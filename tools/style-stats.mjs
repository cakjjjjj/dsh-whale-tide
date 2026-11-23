#!/usr/bin/env node
/**
 * 鲸鲸的说话风格统计。
 *
 * 改 AGENTS.md 前后各跑一次，看三个数：
 *   平均句长、每百字标点、每百字「我/你」
 *
 * 用法：
 *   DSH_HOME=/path/to/harness node tools/style-stats.mjs
 *   node tools/style-stats.mjs --sessions /path/to/sessions --limit 400
 */

import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = argOf('--sessions', join(dshHome, 'sessions'))
const limit = Number(argOf('--limit', '400'))

const files = []
for (const scope of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!scope.isDirectory()) continue
  for (const dir of readdirSync(join(sessionsRoot, scope.name), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const file = join(sessionsRoot, scope.name, dir.name, 'session.v4.jsonl.zstd')
    try {
      files.push({ file, mtime: statSync(file).mtimeMs })
    } catch {
      // 没有会话文件
    }
  }
}
files.sort((a, b) => b.mtime - a.mtime)

const texts = []
for (const { file } of files.slice(0, 10)) {
  let raw
  try {
    raw = zstdDecompressSync(readFileSync(file)).toString('utf8')
  } catch {
    continue
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'assistant/message') continue
    const message = event.data?.message
    // 只认模型自己说的话，不认系统、工具、定时任务
    if (message?.source?.kind !== 'model') continue
    const blocks = Array.isArray(message?.content) ? message.content : []
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()
    if (text.length < 10) continue
    if (/```|npm |systemctl|https?:\/\/|\/var\/|\$ |sudo -S -p '' /.test(text)) continue
    if (/^(鲸鲸心跳|鲸梦)/.test(text)) continue
    texts.push(text)
  }
}

const sample = texts.slice(-limit)
if (!sample.length) {
  console.error(`没找到可统计的对话：${sessionsRoot}`)
  process.exit(1)
}

let chars = 0
let sentences = 0
let punct = 0
let subjects = 0
const lens = []
for (const text of sample) {
  chars += text.length
  punct += (text.match(/[，。！？；：、,.!?;:…—（）"'《》]/g) ?? []).length
  subjects += (text.match(/[我你您]/g) ?? []).length
  for (const piece of text.split(/[。！？!?…\n]+/)) {
    const trimmed = piece.trim()
    if (trimmed.length < 2) continue
    sentences += 1
    lens.push(trimmed.length)
  }
}
lens.sort((a, b) => a - b)
const at = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] ?? 0
const per100 = (value) => (value / Math.max(1, chars) * 100).toFixed(1)

console.log(`样本        ${sample.length} 条回复 / ${chars} 字 / ${sentences} 句`)
console.log(`平均句长    ${(chars / Math.max(1, sentences)).toFixed(1)} 字`)
console.log(`句长中位数  ${at(0.5)} 字`)
console.log(`句长 P90    ${at(0.9)} 字`)
console.log(`每百字标点  ${per100(punct)} 个`)
console.log(`每百字我/你 ${per100(subjects)} 个`)
console.log('\n最近 3 条：')
for (const text of sample.slice(-3)) console.log('  ·', text.replace(/\n/g, ' ⏎ ').slice(0, 90))
