#!/usr/bin/env node
/**
 * 一次性回填：把历史记忆的 importance 按新规则重算。
 *
 * 背景：2026-11-12 之前 importance 是死字段，库里几百条全是默认 0.5，
 * 「重要度 ≥0.7 不删」这层保护等于没有。这个脚本只升不降：
 * 已经有更高值的（比如被召回提升到 0.75 的）不会被压回去。
 *
 * 用法：
 *   node tools/backfill-importance.mjs --dry     # 只看会改多少
 *   node tools/backfill-importance.mjs           # 真写
 *
 * 数据目录：TIDE_DATA_DIR 或 $DSH_HOME/whale-tide
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { importanceOf } from '../lib/memory/importance.js'

const dry = process.argv.includes('--dry')
const dataDir = process.env.TIDE_DATA_DIR
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'whale-tide')
const dbPath = join(dataDir, 'tide.db')

if (!existsSync(dbPath)) {
  console.error(`找不到库：${dbPath}`)
  console.error('请设置 TIDE_DATA_DIR 或 DSH_HOME，例如：DSH_HOME=/path/to/harness node tools/backfill-importance.mjs')
  process.exit(1)
}

const db = new DatabaseSync(dbPath)
const rows = db.prepare('SELECT id, source, role, text, importance, pinned FROM memory').all()

const before = new Map()
for (const row of rows) {
  const key = Number(row.importance).toFixed(2)
  before.set(key, (before.get(key) ?? 0) + 1)
}

const updates = []
for (const row of rows) {
  const next = importanceOf({
    source: row.source,
    role: row.role,
    text: row.text,
    pinned: Number(row.pinned ?? 0),
  })
  const current = Number(row.importance ?? 0.5)
  // 只升不降：召回提升、手动标记的更高值要保住
  const final = Math.max(current, next)
  if (final > current + 1e-9) updates.push({ id: Number(row.id), from: current, to: final })
}

console.log(`库：${dbPath}`)
console.log(`总数：${rows.length}，需要调整：${updates.length}${dry ? '（dry run，没写）' : ''}`)

const byDelta = new Map()
for (const item of updates) {
  const key = `${item.from.toFixed(2)} → ${item.to.toFixed(2)}`
  byDelta.set(key, (byDelta.get(key) ?? 0) + 1)
}
for (const [k, n] of [...byDelta.entries()].sort()) console.log(`  ${k}  ${n} 条`)

if (!dry && updates.length) {
  const stmt = db.prepare('UPDATE memory SET importance = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const item of updates) stmt.run(item.to, item.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  const after = new Map()
  for (const row of db.prepare('SELECT importance FROM memory').all()) {
    const key = Number(row.importance).toFixed(2)
    after.set(key, (after.get(key) ?? 0) + 1)
  }
  console.log('写入完成，分布：')
  for (const [k, n] of [...after.entries()].sort()) console.log(`  ${k}  ${n} 条`)
}

db.close()
