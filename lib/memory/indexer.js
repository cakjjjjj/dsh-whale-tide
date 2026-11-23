/**
 * 冷启动索引：把历史会话日志、以及手写的记忆文件灌进库里。
 *
 * 会话日志是 zstd 压缩的 JSONL（session.v4.jsonl.zstd），Node 24 自带 zstd 解码。
 * 只取 user/message 与 assistant/message，跳过运行时上下文与工具流水。
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { chunkMarkdown, chunkText, fingerprint, isNoise, messageText, sanitize } from './text.js'
import { IMPORTANCE, importanceOf } from './importance.js'

const SESSION_FILE = 'session.v4.jsonl.zstd'
const BATCH = 8

function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(path, d.name))
  } catch {
    return []
  }
}

/** 找出所有会话日志，按修改时间新的在前。 */
export function findSessionLogs(sessionsRoot) {
  const logs = []
  for (const workspaceDir of listDirs(sessionsRoot)) {
    for (const sessionDir of listDirs(workspaceDir)) {
      const file = join(sessionDir, SESSION_FILE)
      if (!existsSync(file)) continue
      try {
        logs.push({ file, sessionId: basename(sessionDir), mtime: statSync(file).mtimeMs })
      } catch {
        // 读不到就跳过
      }
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime)
  return logs
}

function readSessionEvents(file) {
  const raw = readFileSync(file)
  let text
  try {
    text = zstdDecompressSync(raw).toString('utf8')
  } catch {
    text = raw.toString('utf8')
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 残缺行跳过
    }
  }
  return events
}

/**
 * 把历史会话灌库。
 * @returns {Promise<{ sessions: number, chunks: number, added: number }>}
 */
export async function importSessions({ root, store, embedder, maxSessions = 60, chunkSize = 480, onWarn }) {
  const logs = findSessionLogs(root).slice(0, maxSessions)
  const pending = []
  const cwds = new Set()
  let sessions = 0
  let chunks = 0
  let skipped = 0
  let purged = 0
  for (const log of logs) {
    let events
    try {
      events = readSessionEvents(log.file)
    } catch (error) {
      onWarn?.(`读取会话日志失败 ${log.file}: ${error.message}`)
      continue
    }
    const header = events.find((event) => event.type === 'session')
    // 子 agent 的会话是干活用的上下文，不是鲸鲸的记忆，整个跳过并清掉历史残留
    if (header && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) {
      skipped += 1
      purged += store.deleteBySession(header.id ?? log.sessionId)
      continue
    }
    sessions += 1
    for (const event of events) {
      if (event.type === 'session' && typeof event.cwd === 'string') cwds.add(event.cwd)
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      // user 消息在 data.content，assistant 在 data.message.content
      const message = event.data?.message ?? event.data
      // harness 也会把本机注入（时间上下文、技能清单等）塞进 user/message；
      // 实时路径按 source.kind === 'user' 过滤，导入路径也得对齐，否则系统提示会被当用户发言入库。
      if (event.type === 'user/message' && message?.source?.kind && message.source.kind !== 'user') continue
      const text = sanitize(messageText(message))
      if (text.length < 12 || isNoise(text)) continue
      const speaker = message.role === 'assistant' ? '鲸鲸' : '用户'
      const pieces = chunkText(text, chunkSize, 60).map((piece) => `${speaker}: ${piece}`)
      pieces.forEach((piece, index) => {
        chunks += 1
        pending.push({
          fingerprint: fingerprint('chat', log.sessionId, String(event.seq ?? ''), String(index), piece),
          sessionId: log.sessionId,
          source: 'chat',
          role: message.role ?? null,
          ref: `${log.sessionId}#${event.seq ?? index}`,
          ts: Number(event.time ?? log.mtime),
          text: piece,
          importance: importanceOf({ source: 'chat', role: message.role ?? null, text: piece }),
        })
      })
    }
  }
  // 先按指纹滤掉库里已有的：冷启动时 pending 里绝大多数是旧切片，
  // 全量嵌入一遍再被 INSERT OR IGNORE 丢掉，等于每次重启白跑一轮推理。
  const fresh = pending.filter((entry) => !store.has(entry.fingerprint))
  let added = 0
  for (let i = 0; i < fresh.length; i += BATCH) {
    const batch = fresh.slice(i, i + BATCH)
    const vectors = await embedder.embed(batch.map((entry) => entry.text))
    batch.forEach((entry, index) => {
      if (store.put(entry, vectors[index]) !== null) added += 1
    })
  }
  return { sessions, chunks, added, skipped, purged, cwds: [...cwds] }
}

/**
 * 把手写的记忆文件（MEMORY.md / diary / GOALS.md …）灌库。
 * @returns {Promise<{ files: number, added: number }>}
 */
export async function importDocs({ files, store, embedder, chunkSize = 480, onWarn }) {
  const pending = []
  let fileCount = 0
  for (const file of files) {
    if (!existsSync(file)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      onWarn?.(`读取 ${file} 失败: ${error.message}`)
      continue
    }
    if (!text.trim()) continue
    fileCount += 1
    const ts = statSync(file).mtimeMs
    const name = basename(file)
    chunkMarkdown(text, chunkSize, 60).forEach((piece, index) => {
      pending.push({
        fingerprint: fingerprint('doc', file, String(index), piece),
        sessionId: null,
        source: 'doc',
        role: null,
        ref: file,
        ts,
        text: `${name}: ${piece}`,
        importance: IMPORTANCE.DOC,
      })
    })
  }
  const fresh = pending.filter((entry) => !store.has(entry.fingerprint))
  let added = 0
  for (let i = 0; i < fresh.length; i += BATCH) {
    const batch = fresh.slice(i, i + BATCH)
    const vectors = await embedder.embed(batch.map((entry) => entry.text))
    batch.forEach((entry, index) => {
      if (store.put(entry, vectors[index]) !== null) added += 1
    })
  }
  return { files: fileCount, added }
}
