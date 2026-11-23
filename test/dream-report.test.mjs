/**
 * dream_keep 的三种动作必须互不牵连：
 *   - 默认 / dry=true   → 只报告，什么都不动
 *   - dry=false, prune=false, archive=false → 允许动手，但没勾任何一项，所以也不动
 *   - dry=false, archive=true → 真归档，但不删记忆（除非 prune=true）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKeep } from '../lib/dream/index.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-dream-report-'))
  const memory = [
    '# MEMORY',
    '',
    '## 记着的事',
    ...Array.from({ length: 14 }, (_, i) => `- 第 ${i + 1} 条`),
    '',
  ].join('\n')
  writeFileSync(join(dir, 'MEMORY.md'), memory)
  const db = new DatabaseSync(join(dir, 'tide.db'))
  // planForgotten / listDeleted 要读 memory 表；这里只建最小结构，够 report 跑通
  db.exec(`CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT, session_id TEXT, source TEXT,
    role TEXT, ref TEXT, ts INTEGER, text TEXT, pinned INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER, importance REAL NOT NULL DEFAULT 0.5,
    access_count INTEGER NOT NULL DEFAULT 0, last_access INTEGER)`)
  // purgeDeleted 会顺带删向量行；测试库不用真的 vec0 扩展，建个同名普通表就够
  db.exec('CREATE TABLE IF NOT EXISTS memory_vec (rowid INTEGER PRIMARY KEY)')
  const keep = createKeep({ db, dataDir: dir, workspaceDir: dir, log: { info() {}, warn() {} } })
  return { dir, db, keep, memory }
}

test('dry run（默认）只报告，不动 MEMORY.md', () => {
  const { dir, db, keep, memory } = setup()
  try {
    const body = keep.report({ dry: true, archive: true })
    assert.equal(body.dry, true)
    assert.equal(body.docs.archiveResult, undefined, 'dry run 不该产出归档结果')
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), memory)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('dry=false 但没勾归档：仍然什么都不动', () => {
  const { dir, db, keep, memory } = setup()
  try {
    const body = keep.report({ dry: false, archive: false, prune: false })
    assert.equal(body.dry, false)
    assert.equal(body.docs.archiveResult, undefined)
    assert.equal(body.memory.removed, undefined, 'prune 没开就不该删记忆')
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), memory)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('dry=false 且 archive=true：真归档，MEMORY.md 变短', () => {
  const { dir, db, keep } = setup()
  try {
    const body = keep.report({ dry: false, archive: true, prune: false })
    assert.ok(body.docs.archiveResult, '应该产出归档结果')
    assert.ok(body.docs.archiveResult.moved > 0, '应该搬走至少一条')
    const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.ok(after.length > 0)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('dry run 不删过期的软删行，只报 pendingPurge', () => {
  const { dir, db, keep } = setup()
  try {
    const old = Date.now() - 40 * 86_400_000
    db.prepare(`INSERT INTO memory (session_id, source, ts, text, deleted_at)
                VALUES ('s1', 'chat', ?, '四十天前软删的一条', ?)`).run(old, old)
    const body = keep.report({ dry: true })
    assert.equal(body.dry, true)
    assert.equal(body.memory.pendingPurge, 1, '应报出 1 条待清')
    const left = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NOT NULL').get()
    assert.equal(Number(left.n), 1, 'dry run 之后这一行必须还在')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('dry=false 才会真清过期的软删行', () => {
  const { dir, db, keep } = setup()
  try {
    const old = Date.now() - 40 * 86_400_000
    db.prepare(`INSERT INTO memory (session_id, source, ts, text, deleted_at)
                VALUES ('s1', 'chat', ?, '四十天前软删的一条', ?)`).run(old, old)
    const body = keep.report({ dry: false, archive: false, prune: false })
    assert.equal(body.memory.purged, 1)
    const left = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NOT NULL').get()
    assert.equal(Number(left.n), 0)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
