/**
 * 精确词召回率探测。
 *
 * 在一致性快照上跑，不碰主库：
 *   1. 从 snapshot 复制到临时目录
 *   2. openSoulDb（加载 sqlite-vec + 迁移）
 *   3. 拿库里真实存在的精确词当 query，看能否把自己召回
 */
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { openSoulDb } from '../lib/db.js'
import { createMemory } from '../lib/memory/module.js'

const SNAPSHOT = process.argv[2]
const MODELS = process.argv[3]
if (!SNAPSHOT || !existsSync(SNAPSHOT)) {
  console.error('用法: node tools/recall-probe2.mjs <snapshot.db> <models-dir>')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'tide-probe-'))
const dbPath = join(dir, 'tide.db')
copyFileSync(SNAPSHOT, dbPath)
// 模型目录必须是真实的（软链过去），否则 embedder 会去 HuggingFace 下载
const models = join(dir, 'models')
if (!existsSync(MODELS)) {
  console.error(`模型目录不存在：${MODELS}`)
  process.exit(1)
}
try {
  symlinkSync(MODELS, models, 'dir')
} catch {
  mkdirSync(models, { recursive: true })
}

const db = openSoulDb(dbPath)
const memCount = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NULL').get().n
let vecCount = 0
try {
  vecCount = db.prepare('SELECT COUNT(*) AS n FROM memory_vec').get().n
} catch (error) {
  console.error('向量表不可用：', error?.message ?? error)
}
console.log(`快照：memory ${memCount} 条，memory_vec ${vecCount} 条`)

const memory = createMemory({
  db,
  model: 'Xenova/bge-small-zh-v1.5',
  cacheDir: models,
  importHistory: false,
  docRoots: [],
  logger: { info() {}, warn() {} },
})
await memory.boot()

// 挑「含精确词」的条目，用那个词做 query
const words = ['MEMORY.md', 'AGENTS.md', 'GOALS.md', 'schedule.json', 'systemctl', 'tide.db',
  'sqlite-vec', 'ffmpeg', 'workspace.json', 'memory-search.mjs', 'pnpm', 'RRULE', 'bge-small',
  'dsh-whale-tide', 'goodnight.mjs', 'notify-qq.mjs', 'workspace.json', 'tick.mjs', 'vec0', 'perSession']
const rows = db.prepare("SELECT id, text FROM memory WHERE deleted_at IS NULL").all()
const queries = []
for (const word of words) {
  const hit = rows.find((r) => String(r.text).includes(word))
  if (hit) queries.push({ q: word, wantId: hit.id })
}

let ok = 0, okTop3 = 0
const fails = []
for (const { q, wantId } of queries) {
  const hits = await memory.recallHits(q, 6, { touch: false })
  const rank = hits.findIndex((h) => Number(h.id) === Number(wantId))
  if (rank >= 0) ok += 1
  if (rank >= 0 && rank < 3) okTop3 += 1
  if (rank < 0) fails.push({ q, wantId, top: hits.slice(0, 2).map((h) => String(h.text).slice(0, 34)) })
}
console.log(`\n精确词查询 ${queries.length} 个：`)
console.log(`  进入 top-6：${ok}/${queries.length} = ${(ok / queries.length * 100).toFixed(0)}%`)
console.log(`  进入 top-3：${okTop3}/${queries.length} = ${(okTop3 / queries.length * 100).toFixed(0)}%`)
if (fails.length) {
  console.log('\n漏掉的：')
  for (const f of fails) console.log(`  「${f.q}」→ 期望 #${f.wantId}，实际 top2：${JSON.stringify(f.top)}`)
}
