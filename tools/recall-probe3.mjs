/**
 * 精确词召回对比：只有向量 vs 向量 + FTS5 融合。
 *
 * 在一致性快照上跑（`VACUUM INTO` 出来的副本），同一个 embedder、同一批查询，
 * 一次跑出 before/after，避免「改完再量」时数据或模型已经变了。
 *
 *   node tools/recall-probe3.mjs <snapshot.db> <models-dir>
 */

import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openSoulDb } from '../lib/db.js'
import { MemoryStore } from '../lib/memory/store.js'
import { createEmbedder } from '../lib/memory/embed.js'
import { fuse, rank } from '../lib/memory/recall.js'
import { ftsQuery } from '../lib/memory/tokenize.js'

const SNAPSHOT = process.argv[2]
const MODELS = process.argv[3]
if (!SNAPSHOT || !existsSync(SNAPSHOT)) {
  console.error('用法: node tools/recall-probe3.mjs <snapshot.db> <models-dir>')
  process.exit(1)
}
if (!existsSync(MODELS)) {
  console.error(`模型目录不存在：${MODELS}`)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'tide-probe3-'))
const dbPath = join(dir, 'tide.db')
copyFileSync(SNAPSHOT, dbPath)
// 模型目录必须是真的（软链过去），否则 embedder 会去 HuggingFace 下载，内网 ETIMEDOUT
const models = join(dir, 'models')
try {
  symlinkSync(MODELS, models, 'dir')
} catch {
  mkdirSync(models, { recursive: true })
}

const db = openSoulDb(dbPath)
const store = new MemoryStore({ path: dbPath, db })
const active = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NULL').get().n
const ftsRows = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'memory_fts'").get().n
  ? db.prepare('SELECT COUNT(*) AS n FROM memory_fts').get().n
  : 0
console.log(`快照：有效记忆 ${Number(active)} 条，关键词索引 ${Number(ftsRows)} 条`)

const embedder = createEmbedder({ model: 'Xenova/bge-small-zh-v1.5', cacheDir: models })

const WORDS = ['MEMORY.md', 'AGENTS.md', 'GOALS.md', 'schedule.json', 'systemctl', 'tide.db',
  'sqlite-vec', 'ffmpeg', 'workspace.json', 'memory-search.mjs', 'pnpm', 'RRULE', 'bge-small',
  'dsh-whale-tide', 'goodnight.mjs', 'notify-qq.mjs', 'tick.mjs', 'vec0', 'perSession']

const rows = db.prepare('SELECT id, text FROM memory WHERE deleted_at IS NULL').all()
const queries = []
for (const word of WORDS) {
  const hit = rows.find((row) => String(row.text).includes(word))
  if (hit) queries.push({ q: word, wantId: Number(hit.id) })
}

const stat = {
  before: { strict6: 0, strict3: 0, hit6: 0, ftsTop: 0 },
  after: { strict6: 0, strict3: 0, hit6: 0, ftsTop: 0 },
  ftsOnly: 0,
}
const table = []
for (const { q, wantId } of queries) {
  const vector = await embedder.embedQuery(q)
  const vecRows = store.search(vector, 36)
  const before = rank(vecRows, { topK: 6, minScore: 0.35, perSession: 3 })
  const keyword = store.searchFts(ftsQuery(q), 36)
  const after = fuse({ vecRows, ftsRows: keyword, topK: 6, minScore: 0.35, perSession: 3 })

  // 严格口径：能否召回「第一条含这个词的记忆」（老 probe2 的算法，见下）
  const beforeRank = before.findIndex((hit) => Number(hit.id) === wantId)
  const afterRank = after.findIndex((hit) => Number(hit.id) === wantId)
  const ftsRank = keyword.findIndex((hit) => Number(hit.id) === wantId)
  if (beforeRank >= 0) stat.before.strict6 += 1
  if (beforeRank >= 0 && beforeRank < 3) stat.before.strict3 += 1
  if (afterRank >= 0) stat.after.strict6 += 1
  if (afterRank >= 0 && afterRank < 3) stat.after.strict3 += 1
  if (ftsRank >= 0) stat.ftsOnly += 1

  // 有用口径：top-6 里有没有一条真的含这个精确词（用户要的是「召回到建表语句」，不是某一行）
  const firstWithWord = (hits) => hits.findIndex((hit) => String(hit.text).includes(q))
  const beforeHit = firstWithWord(before)
  const afterHit = firstWithWord(after)
  if (beforeHit >= 0) stat.before.hit6 += 1
  if (afterHit >= 0) stat.after.hit6 += 1

  // 关键口径：FTS 认定的「最相关那条」有没有进 top-6，以及向量路原本把它排在哪
  // （BM25 第一 = 与精确词最匹配的记忆，这是用户真正想看到的那条）
  const ftsTopId = keyword[0] ? Number(keyword[0].id) : null
  const beforeSince = ftsTopId === null ? -1 : before.findIndex((hit) => Number(hit.id) === ftsTopId)
  const afterSince = ftsTopId === null ? -1 : after.findIndex((hit) => Number(hit.id) === ftsTopId)
  if (beforeSince >= 0) stat.before.ftsTop += 1
  if (afterSince >= 0) stat.after.ftsTop += 1

  table.push({
    q,
    before: beforeHit < 0 ? '未命中' : `#${beforeHit + 1}`,
    fts: ftsRank < 0 ? `${keyword.length}+` : `#${ftsRank + 1}`,
    after: afterHit < 0 ? '未命中' : `#${afterHit + 1}`,
    strict: `${beforeRank < 0 ? '未' : `#${beforeRank + 1}`} → ${afterRank < 0 ? '未' : `#${afterRank + 1}`}`,
    bm25Top: `${beforeSince < 0 ? '未' : `#${beforeSince + 1}`} → ${afterSince < 0 ? '未' : `#${afterSince + 1}`}`,
  })
}

const n = queries.length
const pct = (x) => `${x}/${n} = ${((x / n) * 100).toFixed(0)}%`
console.log(`\n精确词查询 ${n} 个：`)
console.log(`  有用口径（top-6 里有含该词的条目）`)
console.log(`      只有向量 ${pct(stat.before.hit6)}   融合后 ${pct(stat.after.hit6)}`)
console.log(`  严格口径（老 probe2：召回「第一条含该词的记忆」）`)
console.log(`      只有向量 top-6 ${pct(stat.before.strict6)} top-3 ${pct(stat.before.strict3)}`)
console.log(`      融合后   top-6 ${pct(stat.after.strict6)} top-3 ${pct(stat.after.strict3)}`)
console.log(`  FTS 单路把「第一条含该词的记忆」排进前 36 的：${pct(stat.ftsOnly)}`)
console.log(`  关键口径（FTS 最相关那条进 top-6）`)
console.log(`      只有向量 ${pct(stat.before.ftsTop)}   融合后 ${pct(stat.after.ftsTop)}`)
console.log('\n逐条（#n = 名次；FTS 列是标准答案在 BM25 里的名次）：')
for (const row of table) {
  console.log(`  ${row.q.padEnd(18)} 向量首含词 ${row.before.padEnd(6)} FTS ${row.fts.padEnd(5)} 融合首含词 ${row.after.padEnd(6)} 严格 ${row.strict}  BM25第一 ${row.bm25Top}`)
}
