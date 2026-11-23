#!/usr/bin/env node
/**
 * 回填关键词索引（memory_fts）。
 *
 * memory_fts 里存的是 bigram 之后的文本，不是原文——SQL 里没有 bigram()，
 * 所以不能靠一条 INSERT…SELECT 从主表重建。历史条目必须走一遍这个脚本。
 * 之后的写入由 MemoryStore.put() 双写，软删/恢复由鲸梦同步。
 *
 *   DSH_HOME=/path/to/harness node tools/backfill-fts.mjs          # dry run
 *   DSH_HOME=/path/to/harness node tools/backfill-fts.mjs --apply
 *
 * 可重复执行：已索引的跳过，残留的清掉，不会重复计数。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { bigram } from '../lib/memory/tokenize.js'

const apply = process.argv.includes('--apply')
const dataDir = process.env.TIDE_DATA_DIR
  || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'whale-tide') : join(homedir(), '.dsh', 'whale-tide'))

const db = new DatabaseSync(join(dataDir, 'tide.db'))
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
  USING fts5(body, tokenize='unicode61')
`)

const active = db.prepare('SELECT id, text FROM memory WHERE deleted_at IS NULL ORDER BY id').all()
const indexed = new Set(db.prepare('SELECT rowid AS id FROM memory_fts').all().map((row) => Number(row.id)))
const activeIds = new Set(active.map((row) => Number(row.id)))
const missing = active.filter((row) => !indexed.has(Number(row.id)))
// 软删、真删的条目不该留在索引里（新流程会清，历史的要补一刀）
const stale = [...indexed].filter((id) => !activeIds.has(id))

console.log(`库：${join(dataDir, 'tide.db')}`)
console.log(`有效记忆 ${active.length} 条，已索引 ${active.length - missing.length} 条，待补 ${missing.length} 条`)
console.log(`索引里的残留（软删/已删）${stale.length} 条`)

if (!apply) {
  console.log('\ndry run。加 --apply 真正写入（幂等，可重复跑）。')
  process.exit(0)
}

const insert = db.prepare('INSERT OR REPLACE INTO memory_fts(rowid, body) VALUES (?, ?)')
const drop = db.prepare('DELETE FROM memory_fts WHERE rowid = ?')
db.exec('BEGIN')
try {
  for (const row of missing) insert.run(BigInt(row.id), bigram(row.text))
  for (const id of stale) drop.run(BigInt(id))
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}

const total = db.prepare('SELECT COUNT(*) AS n FROM memory_fts').get().n
console.log(`\n已写入 ${missing.length} 条、清掉 ${stale.length} 条。索引现有 ${Number(total)} 条。`)
