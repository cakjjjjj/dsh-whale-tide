/**
 * 长效记忆模块：落库 → 本地 embedding → 检索 → 注入。
 *
 * 和情绪模块共用同一个 tide.db 连接，所以写记忆时可以顺手把当时的情绪存进去。
 * 所有方法都由插件入口调用，模块本身不碰 Harness 的上下文。
 */

import { join, dirname, basename } from 'node:path'
import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { MemoryStore } from './store.js'
import { createEmbedder } from './embed.js'
import { importDocs, importSessions } from './indexer.js'
import { fuse, render } from './recall.js'
import { ftsQuery } from './tokenize.js'
import { importanceOf } from './importance.js'
import { fingerprint, isNoise, messageText, sanitize } from './text.js'

const NOISE_MARKERS = [
  '<system-reminder>',
  '[SCHEDULE REMINDER',
  'Updated instructions from:',
  'Repeated tool call detected',
  'You are repeating the exact same tool call',
  'Time sampled while preparing',
  'Current runtime context. This snapshot',
]

function collectDocRoots({ configured, dirs }) {
  if (configured?.length) return configured
  const files = []
  const seen = new Set()
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    for (const name of ['GOALS.md', 'AGENTS.md']) {
      const file = join(dir, name)
      if (existsSync(file)) files.push(file)
    }
    for (const sub of ['diary', 'heartbeat']) {
      const path = join(dir, sub)
      if (!existsSync(path)) continue
      try {
        for (const entry of readdirSync(path)) {
          if (entry.endsWith('.md')) files.push(join(path, entry))
        }
      } catch {
        // 读不到就跳过
      }
    }
  }
  return files
}

export function createMemory({
  db,
  dims = 512,
  model,
  dtype,
  mirror,
  cacheDir,
  batchSize = 1,
  sessionsRoot,
  docRoots = [],
  topK = 4,
  maxChars = 900,
  minScore = 0.35,
  importHistory = true,
  maxSessions = 60,
  logger = console,
  emotionSnapshot = () => null,
}) {
  mkdirSync(dirname(cacheDir), { recursive: true })
  const store = new MemoryStore({ path: join(dirname(cacheDir), 'tide.db'), dims, db })
  const embedder = createEmbedder({ model, dtype, mirror, cacheDir, batchSize })

  let booting = null
  let workspaces = []

  function boot() {
    if (!booting) {
      booting = (async () => {
        const started = Date.now()
        try {
          store.purgeNoise(NOISE_MARKERS)
          if (importHistory && sessionsRoot) {
            const result = await importSessions({
              root: sessionsRoot,
              store,
              embedder,
              maxSessions,
              onWarn: (m) => logger.warn?.(m),
            })
            workspaces = result.cwds ?? []
            logger.info?.(`记忆：会话 ${result.sessions} 个、切片 ${result.chunks}、新增 ${result.added}`)
          }
          const docs = collectDocRoots({ configured: docRoots, dirs: workspaces })
          if (docs.length) {
            for (const file of docs) store.deleteByRef(file)
            const result = await importDocs({ files: docs, store, embedder, onWarn: (m) => logger.warn?.(m) })
            logger.info?.(`记忆：笔记 ${result.files} 个、新增 ${result.added}`)
          }
          logger.info?.(`记忆就绪 ${Date.now() - started}ms，库内 ${store.stats().count} 条`)
        } catch (error) {
          booting = null
          logger.warn?.(`记忆初始化失败：${error?.message ?? error}`)
        }
      })()
    }
    return booting
  }

  /** 实时落库：一条消息进来，判噪声、切块、向量化、带情绪快照写入。 */
  async function ingest({ sessionId, role, text, ts, ref }) {
    const clean = sanitize(text)
    if (clean.length < 12 || isNoise(clean)) return 0
    await boot()
    const emotion = emotionSnapshot()
    const body = clean.length > 1600 ? clean.slice(0, 1600) : clean
    const entry = {
      fingerprint: fingerprint('live', sessionId, ref ?? '', clean),
      sessionId,
      source: 'chat',
      role,
      ref: ref ?? null,
      ts,
      text: body,
      emotion,
      // 重要度决定衰减速度和「鲸梦能不能删」：明确让记住的、关于他的事实，留得久
      importance: importanceOf({ source: 'chat', role, text: body }),
    }
    const [vector] = await embedder.embed([entry.text])
    return store.put(entry, vector) === null ? 0 : 1
  }

  /**
   * 两路召回 → RRF 融合。
   *
   * 向量路答不了精确词（命令名、路径、错误码），FTS5 路答不了语义；
   * 两路各取 pool 条，按名次融合后再统一排序（时间衰减、去重、每会话上限照旧）。
   * 关键词一路没有结果时，结果与只有向量那会儿完全一致。
   */
  async function retrieve(query, { limit, floor = minScore, excludeSessionId, perSession: sessionCap }) {
    const vector = await embedder.embedQuery(query)
    const pool = Math.max(24, limit * 6)
    const vecRows = store.search(vector, pool)
    const ftsRows = store.searchFts(ftsQuery(query), pool)
    return fuse({
      vecRows,
      ftsRows,
      topK: limit,
      minScore: floor,
      excludeSessionId,
      perSession: sessionCap,
    })
  }

  async function recallText(query, { excludeSessionId } = {}) {
    if (!query || query.trim().length < 2) return ''
    await boot()
    const hits = await retrieve(query, { limit: topK, excludeSessionId, perSession: 2 })
    return render(hits, { maxChars })
  }

  async function recallHits(query, limit = 6, { touch = true } = {}) {
    if (!query?.trim()) return []
    await boot()
    const hits = await retrieve(query, { limit, perSession: 3 })
    // 被检索到就算「想起过一次」，稳定度随之上升
    if (touch) store.touch(hits.map((hit) => hit.id))
    return hits
  }

  return { store, boot, ingest, recallText, recallHits, stats: () => store.stats(), workspaces: () => workspaces }
}

export { basename, messageText, sanitize, isNoise, fingerprint }
