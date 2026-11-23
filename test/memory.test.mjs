import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { rank, retentionOf } from '../lib/memory/recall.js'
import { MemoryStore } from '../lib/memory/store.js'

const require = createRequire(import.meta.url)
const HOUR = 3_600_000
const now = 1_800_000_000_000

function openTestDb() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-test-'))
  const db = new DatabaseSync(join(dir, 'tide.db'), { allowExtension: true })
  db.loadExtension(require('sqlite-vec').getLoadablePath())
  db.exec(`CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT UNIQUE, session_id TEXT,
    source TEXT, role TEXT, ref TEXT, ts INTEGER, text TEXT,
    importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0,
    last_access INTEGER, pinned INTEGER DEFAULT 0, emotion TEXT)`)
  db.exec('CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[2] distance_metric=cosine)')
  return { dir, db }
}

test('钉住的记忆不衰减', () => {
  assert.equal(retentionOf({ ts: now - 1000 * HOUR, pinned: 1 }, now), 1)
})

test('刚访问过的记忆留存率高于很久没碰的', () => {
  const fresh = retentionOf({ ts: now - 10 * HOUR, last_access: now - 1 * HOUR }, now)
  const stale = retentionOf({ ts: now - 10 * HOUR, last_access: now - 2000 * HOUR }, now)
  assert.ok(fresh > stale, `fresh=${fresh} stale=${stale}`)
  assert.ok(fresh > 0.9 && stale < 0.1)
})

test('被想起过更多次的记忆，衰减更慢', () => {
  const base = { ts: now - 500 * HOUR, last_access: now - 500 * HOUR }
  const once = retentionOf({ ...base, access_count: 1 }, now)
  const many = retentionOf({ ...base, access_count: 10 }, now)
  assert.ok(many > once)
})

test('重要度高的记忆衰减更慢', () => {
  const base = { ts: now - 300 * HOUR, last_access: now - 300 * HOUR }
  const low = retentionOf({ ...base, importance: 0.1 }, now)
  const high = retentionOf({ ...base, importance: 1 }, now)
  assert.ok(high > low)
})

test('排序：同等相似度下，钉住的排在前面', () => {
  const rows = [
    { id: 1, distance: 0.2, ts: now, source: 'chat', text: '普通的一条', pinned: 0 },
    { id: 2, distance: 0.2, ts: now, source: 'chat', text: '钉住的一条', pinned: 1 },
  ]
  const hits = rank(rows, { topK: 2, now })
  assert.equal(hits[0].id, 2)
})

test('排序：相似度仍是主项，旧但无关的不会压过新的相关', () => {
  const rows = [
    { id: 1, distance: 0.05, ts: now, source: 'chat', text: '很相关', last_access: now },
    { id: 2, distance: 0.55, ts: now - 3000 * HOUR, source: 'chat', text: '很不相关', last_access: now - 3000 * HOUR, pinned: 0 },
  ]
  const hits = rank(rows, { topK: 2, now, minScore: 0 })
  assert.equal(hits[0].id, 1)
})

test('touch 会累加访问次数并更新时间', () => {
  const { dir, db } = openTestDb()
  try {
    const store = new MemoryStore({ path: join(dir, 'tide.db'), dims: 2, db })
    const id = store.put({
      fingerprint: 'f1', sessionId: 's', source: 'chat', role: 'user', ref: 'r', ts: now, text: '一条记忆',
    }, [1, 0])
    store.touch([id], now + HOUR)
    const row = db.prepare('SELECT access_count, last_access FROM memory WHERE id = ?').get(id)
    assert.equal(Number(row.access_count), 1)
    assert.equal(Number(row.last_access), now + HOUR)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
