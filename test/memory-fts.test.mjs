/**
 * 关键词检索（FTS5）+ 名次融合（RRF）。
 *
 * 背景：向量一路对「命令名 / 路径 / 标识符」几乎无感——18 个精确词查询
 * 只有 5 个能把原条目召回（28%），四个不同的词返回同一对结果。
 * 这里测的是补上的第二路，以及两路融合的边界情况。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

import { MemoryStore, indexFts } from '../lib/memory/store.js'
import { bigram, ftsQuery } from '../lib/memory/tokenize.js'
import { fuse, rank, rrf } from '../lib/memory/recall.js'
import { createKeep } from '../lib/dream/index.js'

const require = createRequire(import.meta.url)
const now = 1_800_000_000_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-fts-'))
  const db = new DatabaseSync(join(dir, 'tide.db'), { allowExtension: true })
  db.loadExtension(require('sqlite-vec').getLoadablePath())
  db.exec(`CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT UNIQUE, session_id TEXT,
    source TEXT, role TEXT, ref TEXT, ts INTEGER, text TEXT,
    importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0,
    last_access INTEGER, pinned INTEGER DEFAULT 0, emotion TEXT, deleted_at INTEGER)`)
  db.exec('CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[2] distance_metric=cosine)')
  const store = new MemoryStore({ path: join(dir, 'tide.db'), dims: 2, db })
  const keep = createKeep({ db, dataDir: dir, workspaceDir: () => dir, log: { info() {}, warn() {} } })
  return { dir, db, store, keep }
}

/** 写一条并返回 id（指纹、正文、向量都可覆盖）。 */
function put(store, fingerprint, text, { ts = now, session = 's', vector = [1, 0] } = {}) {
  const id = store.put({
    fingerprint, sessionId: session, source: 'chat', role: 'user', ref: 'r', ts, text, importance: 0.5,
  }, vector)
  assert.ok(id, `写入失败：${fingerprint}`)
  return id
}

test('分词：中文按两字切，ASCII 词整体保留并小写', () => {
  assert.equal(
    bigram('鲸鲸心跳的配置在 schedule.json 里'),
    '鲸鲸 鲸心 心跳 跳的 的配 配置 置在 schedule.json 里',
  )
  assert.equal(bigram('MEMORY.md'), 'memory.md')
  assert.equal(bigram('心'), '心', '单字也要能搜')
})

test('查询表达式：每个 token 加引号，没有有效 token 时返回 null', () => {
  assert.equal(ftsQuery('schedule.json'), '"schedule.json"')
  assert.equal(ftsQuery('心跳 备份'), '"心跳" AND "备份"')
  assert.equal(ftsQuery('  ...  '), null, '纯标点不该生成空短语')
})

test('自然句里的精确词：只用精确词做 OR，不把整句中文 bigram AND 上去', () => {
  // 召回入口拿到的是用户整句话。整句 AND 必然 0 条（实测「sqlite-vec 那个表是怎么建的」→ 0）
  assert.equal(ftsQuery('sqlite-vec 那个表是怎么建的'), '"sqlite-vec"')
  assert.equal(ftsQuery('tide.db 和 workspace.json 是什么'), '"tide.db" OR "workspace.json"')
})

test('长中文句里没有精确词时，不给 FTS 一路（避免噪声）', () => {
  assert.equal(ftsQuery('今天有点累想早点睡明天再说吧'), null)
  // 短查询仍然走中文 bigram
  assert.ok(ftsQuery('备份策略'))
})

test('自然句里带精确词时，关键词一路真能召回', () => {
  const { dir, db, store } = setup()
  try {
    const want = put(store, 'f1', 'sqlite-vec 的表是 `CREATE VIRTUAL TABLE memory_vec USING vec0(...)` 这么建的')
    put(store, 'f2', '今天有点累')
    const hits = store.searchFts(ftsQuery('sqlite-vec 那个表是怎么建的'), 10)
    assert.deepEqual(hits.map((hit) => Number(hit.id)), [want])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('查「MEMORY.md」能召回含该词的条目', () => {
  const { dir, db, store } = setup()
  try {
    const want = put(store, 'f1', '把 MEMORY.md 里「记着的事」只留最近 12 条')
    put(store, 'f2', '今天有点累，想早点睡')
    const hits = store.searchFts(ftsQuery('MEMORY.md'), 10)
    assert.ok(hits.some((hit) => Number(hit.id) === want), `没召回：#${want}`)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('查「心跳」（两字）能召回 —— trigram 就栽在两个字上', () => {
  const { dir, db, store } = setup()
  try {
    const want = put(store, 'f1', '鲸鲸心跳的配置在 schedule.json 里')
    put(store, 'f2', '周末想去看海')
    const hits = store.searchFts(ftsQuery('心跳'), 10)
    assert.deepEqual(hits.map((hit) => Number(hit.id)), [want])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('查「schedule.json」不抛 fts5 语法错', () => {
  const { dir, db, store } = setup()
  try {
    put(store, 'f1', '鲸鲸心跳的配置在 schedule.json 里')
    const expr = ftsQuery('schedule.json')
    let hits
    assert.doesNotThrow(() => {
      hits = store.searchFts(expr, 5)
    })
    assert.equal(hits.length, 1, '加引号之后能命中')
    // 反过来证明：不加引号的裸表达式确实会被 FTS5 当语法
    assert.throws(() => db.prepare('SELECT rowid FROM memory_fts WHERE body MATCH ?').all('schedule.json'))
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('软删的条目不出现在 FTS 结果里', () => {
  const { dir, db, store, keep } = setup()
  try {
    const id = put(store, 'f1', 'disk check: tide.db 已经 6MB 了')
    assert.equal(store.searchFts(ftsQuery('tide.db'), 5).length, 1, '删之前能搜到')
    assert.equal(keep.forget([id]), 1)
    assert.equal(store.searchFts(ftsQuery('tide.db'), 5).length, 0, '软删后搜不到')
    const left = db.prepare('SELECT COUNT(*) AS n FROM memory_fts WHERE rowid = ?').get(BigInt(id))
    assert.equal(Number(left.n), 0, 'FTS 行也该一起清掉')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('恢复软删后能重新搜到', () => {
  const { dir, db, store, keep } = setup()
  try {
    const id = put(store, 'f1', 'disk check: tide.db 已经 6MB 了')
    keep.forget([id])
    assert.equal(store.searchFts(ftsQuery('tide.db'), 5).length, 0)
    assert.equal(keep.restore([id]), 1)
    assert.equal(store.searchFts(ftsQuery('tide.db'), 5).length, 1, '恢复后重建了关键词索引')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('向量与 FTS 都命中时只返回一条（RRF 合并）', () => {
  const row = { id: 7, ts: now, session_id: 's', source: 'chat', text: 'schedule.json 在这里', pinned: 0, importance: 0.5 }
  const vecRows = [{ ...row, distance: 0.1 }]
  const ftsRows = [{ ...row }]
  const hits = fuse({ vecRows, ftsRows, topK: 5, now, minScore: 0 })
  assert.equal(hits.length, 1, '同一条只出现一次')
  assert.equal(Number(hits[0].id), 7)
  assert.equal(hits[0].fusedPaths, 2, '标记两路都命中')
  assert.equal(hits[0].distance, 0.1, '保留向量路的 distance')
})

test('RRF：名次越靠前分越高，两路都命中的排在单路前面', () => {
  const fused = rrf([
    [{ id: 1 }, { id: 2 }], // 向量：1 比 2 靠前
    [{ id: 3 }, { id: 2 }], // FTS：3 比 2 靠前
  ])
  assert.equal(Number(fused[0].id), 2, '两路都命中 → 融合分最高')
  // 两路都是第 2 名：2/(60+2) ÷ 2/(60+1) ≈ 0.98；单路第一也只到 0.5
  assert.ok(fused[0].fused > 0.9, `fused=${fused[0].fused}`)
  assert.ok(fused[0].fused > fused[1].fused && fused[0].fused > fused[2].fused)
  assert.equal(fused[0].fusedPaths, 2)
})

test('FTS 为空时行为与现在一致（不回归）', () => {
  const vecRows = [
    { id: 1, distance: 0.2, ts: now, session_id: 's', source: 'chat', text: '很相关', pinned: 0, importance: 0.5 },
    { id: 2, distance: 0.4, ts: now, session_id: 't', source: 'chat', text: '一般相关', pinned: 0, importance: 0.5 },
  ]
  assert.deepEqual(
    fuse({ vecRows, ftsRows: [], topK: 3, now }),
    rank(vecRows, { topK: 3, now }),
    '关键词一路没结果时，排序与只有向量那会儿逐字段一致',
  )
})

test('关键词一路能独立工作（向量为空时不至于全空）', () => {
  const ftsRows = [
    { id: 9, ts: now, session_id: 's', source: 'chat', text: 'systemctl restart dsh-web', pinned: 0, importance: 0.5 },
  ]
  const hits = fuse({ vecRows: [], ftsRows, topK: 3, now, minScore: 0 })
  assert.equal(hits.length, 1)
  assert.equal(Number(hits[0].id), 9)
})

test('回填用的 indexFts 可以重复执行（幂等，不会重复计数）', () => {
  const { dir, db } = setup()
  try {
    db.prepare(`INSERT INTO memory(fingerprint, source, ts, text) VALUES ('x', 'chat', ?, '心跳')`).run(now)
    const id = Number(db.prepare('SELECT id FROM memory WHERE fingerprint = ?').get('x').id)
    indexFts(db, id, '心跳')
    indexFts(db, id, '心跳')
    const n = db.prepare('SELECT COUNT(*) AS n FROM memory_fts WHERE rowid = ?').get(BigInt(id)).n
    assert.equal(Number(n), 1)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruneOrphanVectors 只清真孤儿，软删条目的向量要留着', () => {
  const { dir, db, store, keep } = setup()
  try {
    const live = put(store, 'live', '一条活着的记忆')
    const deleted = put(store, 'deleted', '一条被软删的记忆', { vector: [0, 1] })
    const gone = put(store, 'gone', '一条被真删的记忆', { vector: [0, 1] })
    keep.forget([deleted])
    db.prepare('DELETE FROM memory WHERE id = ?').run(gone) // 留下向量行，模拟真删后的残留
    assert.equal(store.pruneOrphanVectors(), 1, '只清掉真删那条的向量')
    const count = db.prepare('SELECT COUNT(*) AS n FROM memory_vec').get().n
    assert.equal(Number(count), 2, '活着的 + 软删的都还在')
    const soft = db.prepare('SELECT COUNT(*) AS n FROM memory_vec WHERE rowid = ?').get(BigInt(deleted))
    assert.equal(Number(soft.n), 1)
    assert.ok(live)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
