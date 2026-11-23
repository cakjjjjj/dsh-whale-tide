/**
 * 「他最近说过的话」的时间窗查询。
 *
 * 背景：心跳/鲸梦跑在各自会话里，看不到聊天窗口的内容；
 * 向量检索又只会命中跟提示词语义相近的记忆，于是它以为「好几天没见」。
 * recentChats 按时间窗直查，不走向量。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../lib/memory/store.js'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-recent-'))
  const db = new DatabaseSync(join(dir, 'tide.db'))
  db.exec(`CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT, session_id TEXT, source TEXT,
    role TEXT, ref TEXT, ts INTEGER, text TEXT, importance REAL DEFAULT 0.5,
    access_count INTEGER DEFAULT 0, last_access INTEGER, pinned INTEGER DEFAULT 0,
    emotion TEXT, deleted_at INTEGER)`)
  const store = new MemoryStore({ db, path: join(dir, 'unused.db') })
  return { dir, db, store }
}

const insert = (db, id, ts, text, deletedAt = null) =>
  db.prepare(`INSERT INTO memory (fingerprint, session_id, source, role, ts, text, deleted_at)
              VALUES (?, 's1', 'chat', 'user', ?, ?, ?)`).run(`fp-${id}`, ts, text, deletedAt)

test('只取时间窗内的对话，按时间倒序', () => {
  const { dir, db, store } = setup()
  try {
    insert(db, 1, NOW - 2 * HOUR, '用户: 早上好呀鲸鲸')
    insert(db, 2, NOW - 26 * HOUR, '用户: 晚安鲸鲸')
    insert(db, 3, NOW - 100 * HOUR, '用户: 很久以前的一句')
    const rows = store.recentChats({ hours: 48, limit: 6, now: NOW })
    assert.equal(rows.length, 2, '48 小时内应该只有两条')
    assert.equal(rows[0].text, '用户: 早上好呀鲸鲸', '排在最前的是最近的')
    assert.equal(rows[1].text, '用户: 晚安鲸鲸')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('软删的对话不出现', () => {
  const { dir, db, store } = setup()
  try {
    insert(db, 1, NOW - 1 * HOUR, '用户: 这句被软删了', NOW - 30 * 60_000)
    insert(db, 2, NOW - 2 * HOUR, '用户: 这句还在')
    const rows = store.recentChats({ hours: 48, limit: 6, now: NOW })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].text, '用户: 这句还在')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('limit 生效，最多返回 N 条', () => {
  const { dir, db, store } = setup()
  try {
    for (let i = 1; i <= 10; i += 1) insert(db, i, NOW - i * HOUR, `用户: 第 ${i} 条`)
    const rows = store.recentChats({ hours: 48, limit: 3, now: NOW })
    assert.equal(rows.length, 3)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
