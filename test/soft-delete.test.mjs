/**
 * M3：软删除。
 *
 * forget() 从「直接 DELETE」改成「标记 deleted_at」：
 * 检索立刻看不到，但内容和向量都还在，30 天内能 restore。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

import { openSoulDb } from '../lib/db.js'
import { MemoryStore } from '../lib/memory/store.js'
import { createKeep } from '../lib/dream/index.js'

const require = createRequire(import.meta.url)
const DAY = 86_400_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-soft-'))
  const db = new DatabaseSync(join(dir, 'tide.db'), { allowExtension: true })
  db.loadExtension(require('sqlite-vec').getLoadablePath())
  db.exec(`CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT UNIQUE, session_id TEXT,
    source TEXT, role TEXT, ref TEXT, ts INTEGER, text TEXT,
    importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0,
    last_access INTEGER, pinned INTEGER DEFAULT 0, emotion TEXT, deleted_at INTEGER)`)
  db.exec('CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[2] distance_metric=cosine)')
  const store = new MemoryStore({ path: join(dir, 'tide.db'), dims: 2, db })
  const keep = createKeep({
    db,
    dataDir: dir,
    workspaceDir: () => dir,
    log: { info() {}, warn() {} },
  })
  return { dir, db, store, keep }
}

test('软删之后检索不到，但行还在', () => {
  const { dir, db, store, keep } = setup()
  try {
    const id = store.put({
      fingerprint: 'soft-1', sessionId: 's', source: 'chat', role: 'user', ref: 'r',
      ts: Date.now(), text: '今天有点累', importance: 0.5,
    }, [1, 0])
    assert.equal(store.search([1, 0], 5).length, 1, '删之前能查到')

    const marked = keep.forget([id])
    assert.equal(marked, 1)
    assert.equal(store.search([1, 0], 5).length, 0, '软删后检索不到')

    const row = db.prepare('SELECT deleted_at FROM memory WHERE id = ?').get(id)
    assert.ok(row, '行还在')
    assert.ok(Number(row.deleted_at) > 0, '标记了时间')
    const vec = db.prepare('SELECT COUNT(*) AS n FROM memory_vec WHERE rowid = ?').get(BigInt(id))
    assert.equal(vec.n, 1, '向量还在（恢复时不用重新 embedding）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore 之后又能检索到', () => {
  const { dir, db, store, keep } = setup()
  try {
    const id = store.put({
      fingerprint: 'soft-2', sessionId: 's', source: 'chat', role: 'user', ref: 'r',
      ts: Date.now(), text: '磁盘满了怎么办', importance: 0.5,
    }, [1, 0])
    keep.forget([id])
    assert.equal(store.search([1, 0], 5).length, 0)
    assert.equal(keep.restore([id]), 1)
    assert.equal(store.search([1, 0], 5).length, 1, '恢复后能查到')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('purgeDeleted 只清超过保留期的标记', () => {
  const { dir, db, store, keep } = setup()
  try {
    const oldId = store.put({
      fingerprint: 'old', sessionId: 's', source: 'chat', role: 'user', ref: 'r',
      ts: Date.now(), text: '很旧的记忆', importance: 0.5,
    }, [1, 0])
    const newId = store.put({
      fingerprint: 'new', sessionId: 's', source: 'chat', role: 'user', ref: 'r',
      ts: Date.now(), text: '刚删的记忆', importance: 0.5,
    }, [0, 1])
    const now = Date.now()
    keep.forget([oldId], now - 40 * DAY) // 40 天前删的
    keep.forget([newId], now - 2 * DAY) // 2 天前删的

    const removed = keep.purgeDeleted({ retentionDays: 30, now })
    assert.equal(removed, 1, '只清 40 天前那条')
    assert.equal(store.search([1, 0], 5).length, 0)
    assert.equal(store.search([0, 1], 5).length, 0)
    // 新删那条还在（软删）
    const still = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE id = ?').get(newId)
    assert.equal(still.n, 1, '2 天前删的还没真删')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已经软删的不会再被 planForgotten 重复列出', () => {
  const { dir, db, store, keep } = setup()
  try {
    const old = Date.now() - 60 * DAY
    const id = store.put({
      fingerprint: 'repeat', sessionId: 's', source: 'chat', role: 'user', ref: 'r',
      ts: old, text: '一条很久以前的话', importance: 0.2,
    }, [1, 0])
    keep.forget([id])
    const plan = keep.planForgotten({ olderThanDays: 30, minRetention: 0.5 })
    assert.equal(plan.candidates.length, 0, '已软删的不再出现在候选里')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('迁移到 005 后 schema 版本是 5', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-schema-'))
  try {
    const db = openSoulDb(join(dir, 'soul.db'))
    const { version } = db.prepare('SELECT MAX(version) AS version FROM schema_version').get()
    assert.equal(Number(version), 5)
    const cols = db.prepare('PRAGMA table_info(memory)').all().map((c) => c.name)
    assert.ok(cols.includes('deleted_at'), 'memory 表要有 deleted_at')
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
