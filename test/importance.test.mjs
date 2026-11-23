/**
 * M2：importance 从死字段变成真的会变的数。
 *
 * 之前 377 条记忆全是 0.5，「重要度 ≥0.7 不删」这条保护形同虚设。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

import { IMPORTANCE, importanceOf } from '../lib/memory/importance.js'
import { MemoryStore } from '../lib/memory/store.js'

const require = createRequire(import.meta.url)

test('用户明确要求记住 → 0.9', () => {
  assert.equal(importanceOf({ source: 'chat', role: 'user', text: '记住，我的服务器是 example.com' }), IMPORTANCE.EXPLICIT)
  assert.equal(importanceOf({ source: 'chat', role: 'user', text: '别忘了下周要做周报' }), IMPORTANCE.EXPLICIT)
})

test('关于用户的稳定事实 → 0.7', () => {
  assert.equal(importanceOf({ source: 'chat', role: 'user', text: '我在做国产化运维，主要用 UOS' }), IMPORTANCE.FACT)
  assert.equal(importanceOf({ source: 'chat', role: 'user', text: '我的猫叫皮蛋' }), IMPORTANCE.FACT)
})

test('普通对话 → 0.5', () => {
  assert.equal(importanceOf({ source: 'chat', role: 'user', text: '今天这个接口有点慢，看看日志' }), IMPORTANCE.NORMAL)
})

test('鲸鲸自己说的话不因为「记住」升级', () => {
  assert.equal(importanceOf({ source: 'chat', role: 'assistant', text: '我记住了，以后都这样' }), IMPORTANCE.NORMAL)
})

test('文档切片 → 0.8', () => {
  assert.equal(importanceOf({ source: 'doc', role: null, text: '# 环境' }), IMPORTANCE.DOC)
})

test('钉住的记忆 → 1.0', () => {
  assert.equal(importanceOf({ source: 'chat', role: 'user', text: '随便', pinned: 1 }), IMPORTANCE.PINNED)
})

test('空文本走默认值，不炸', () => {
  assert.equal(importanceOf({}), IMPORTANCE.NORMAL)
  assert.equal(importanceOf(), IMPORTANCE.NORMAL)
})

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-imp-'))
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

test('put 会把 importance 落库', () => {
  const { dir, db } = openDb()
  try {
    const store = new MemoryStore({ path: join(dir, 'tide.db'), dims: 2, db })
    const id = store.put({
      fingerprint: 'f-imp', sessionId: 's', source: 'chat', role: 'user', ref: 'r',
      ts: Date.now(), text: '记住这个', importance: 0.9,
    }, [1, 0])
    const row = db.prepare('SELECT importance FROM memory WHERE id = ?').get(id)
    assert.equal(Number(row.importance), 0.9)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('被召回三次之后，重要度抬到 0.75', () => {
  const { dir, db } = openDb()
  try {
    const store = new MemoryStore({ path: join(dir, 'tide.db'), dims: 2, db })
    const id = store.put({
      fingerprint: 'f-touch', sessionId: 's', source: 'chat', role: 'user', ref: 'r',
      ts: Date.now(), text: '一条普通记忆', importance: 0.5,
    }, [1, 0])
    store.touch([id])
    store.touch([id])
    let row = db.prepare('SELECT importance, access_count FROM memory WHERE id = ?').get(id)
    assert.equal(Number(row.importance), 0.5, '两次还不到提升线')
    store.touch([id])
    row = db.prepare('SELECT importance, access_count FROM memory WHERE id = ?').get(id)
    assert.equal(Number(row.access_count), 3)
    assert.equal(Number(row.importance), 0.75, '第三次应抬到 0.75')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
