#!/usr/bin/env node
/**
 * 把旧的 dsh-whale-memory 库搬进灵魂库（tide.db）。
 *
 *   node tools/migrate-memory.mjs --dry     # 只数数量，不写
 *   node tools/migrate-memory.mjs           # 真搬（旧库不动，只读）
 *
 * 搬的内容：memory 表全部行 + memory_vec 里的向量（按 rowid 对齐）。
 * 幂等：指纹已存在的行跳过，可以反复跑。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { openSoulDb } from '../lib/db.js'

const require = createRequire(import.meta.url)
const dry = process.argv.includes('--dry')

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const OLD_DB = join(DSH_HOME, 'whale-memory', 'memory.db')
const NEW_DB = join(DSH_HOME, 'whale-tide', 'tide.db')

if (!existsSync(OLD_DB)) {
  console.log(`旧库不存在：${OLD_DB}`)
  process.exit(0)
}

const old = new DatabaseSync(OLD_DB, { readOnly: true, allowExtension: true })
try {
  const sqliteVec = require('sqlite-vec')
  old.loadExtension(sqliteVec.getLoadablePath())
} catch {
  console.warn('旧库没有 sqlite-vec，向量将无法搬迁（文字照常搬）')
}

const rows = old.prepare('SELECT * FROM memory ORDER BY id').all()
let vectors = new Map()
try {
  const vecRows = old.prepare('SELECT rowid AS id, embedding FROM memory_vec').all()
  for (const row of vecRows) vectors.set(Number(row.id), row.embedding)
} catch {
  vectors = new Map()
}

console.log(`旧库：${rows.length} 条记忆，${vectors.size} 条向量`)
if (dry) {
  const docs = rows.filter((r) => r.source === 'doc').length
  console.log(`  chat ${rows.length - docs} 条 / doc ${docs} 条`)
  console.log('（--dry：没有写入）')
  process.exit(0)
}

const db = openSoulDb(NEW_DB)
let added = 0
let skipped = 0
let vecAdded = 0
const insert = db.prepare(`
  INSERT OR IGNORE INTO memory(fingerprint, session_id, source, role, ref, ts, text)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
const lastId = db.prepare('SELECT last_insert_rowid() AS id')
const insertVec = db.prepare('INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)')

db.exec('BEGIN')
try {
  for (const row of rows) {
    const result = insert.run(
      row.fingerprint,
      row.session_id ?? null,
      row.source,
      row.role ?? null,
      row.ref ?? null,
      Number(row.ts),
      row.text,
    )
    if (!result.changes) {
      skipped += 1
      continue
    }
    added += 1
    const newId = Number(lastId.get().id)
    const blob = vectors.get(Number(row.id))
    if (blob) {
      try {
        insertVec.run(BigInt(newId), blob)
        vecAdded += 1
      } catch (error) {
        console.warn(`向量写入失败 id=${row.id}：${error.message}`)
      }
    }
  }
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  console.error(`迁移中断：${error.message}`)
  process.exit(1)
}

const total = db.prepare('SELECT COUNT(*) AS n FROM memory').get()
console.log(`搬完：新增 ${added} 条、跳过 ${skipped} 条、向量 ${vecAdded} 条`)
console.log(`新库现有 ${Number(total.n)} 条记忆`)
db.close()
old.close()
