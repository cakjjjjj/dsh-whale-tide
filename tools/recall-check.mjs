/**
 * 单个查询的召回检查：融合后的前 N 条，以及「含指定片段」的条目排在第几。
 *
 *   node tools/recall-check.mjs <snapshot.db> <models-dir> "<query>" ["<期望出现的片段>"]
 */
import { join } from 'node:path'
import { copyFileSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openSoulDb } from '../lib/db.js'
import { MemoryStore } from '../lib/memory/store.js'
import { createEmbedder } from '../lib/memory/embed.js'
import { fuse } from '../lib/memory/recall.js'
import { ftsQuery } from '../lib/memory/tokenize.js'

const [SNAPSHOT, MODELS, QUERY, NEEDLE] = process.argv.slice(2)
if (!QUERY) {
  console.error('用法: node tools/recall-check.mjs <snapshot.db> <models-dir> "<query>" ["<期望片段>"]')
  process.exit(1)
}
const dir = mkdtempSync(join(tmpdir(), 'tide-check-'))
const dbPath = join(dir, 'tide.db')
copyFileSync(SNAPSHOT, dbPath)
const models = join(dir, 'models')
try { symlinkSync(MODELS, models, 'dir') } catch {}
const db = openSoulDb(dbPath)
const store = new MemoryStore({ path: dbPath, db })
const embedder = createEmbedder({ model: 'Xenova/bge-small-zh-v1.5', cacheDir: models })

const vector = await embedder.embedQuery(QUERY)
const vecRows = store.search(vector, 36)
const expr = ftsQuery(QUERY)
const ftsRows = store.searchFts(expr, 36)
const hits = fuse({ vecRows, ftsRows, topK: 6, minScore: 0.35, perSession: 3 })

console.log(`查询：${QUERY}`)
console.log(`FTS 表达式：${expr ?? '(跳过，只有向量一路)'}   向量 ${vecRows.length} 条 / FTS ${ftsRows.length} 条`)
hits.forEach((hit, index) => {
  const mark = NEEDLE && String(hit.text).includes(NEEDLE) ? ' ★含期望片段' : ''
  console.log(`  #${index + 1} [${hit.score.toFixed(3)}] ${String(hit.text).replace(/\s+/g, ' ').slice(0, 100)}${mark}`)
})
if (NEEDLE) {
  const pos = hits.findIndex((hit) => String(hit.text).includes(NEEDLE))
  console.log(pos >= 0 ? `\n期望片段出现在 top-${pos + 1}` : `\n期望片段不在 top-${hits.length}`)
}
