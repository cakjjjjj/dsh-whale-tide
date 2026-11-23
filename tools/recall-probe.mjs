/**
 * 精确词 vs 语义：向量检索到底丢多少？
 * 拿库里真实存在的「精确串」当查询，看能不能把自己召回来。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createMemory } from '../lib/memory/module.js'

const dataDir = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'whale-tide') : join(homedir(), '.dsh', 'whale-tide')
// 探测脚本不该碰主库：复制一份再跑（MemoryStore 构造时可能建表/加载扩展）
const probeDir = mkdtempSync(join(tmpdir(), 'tide-probe-'))
for (const suffix of ['', '-wal', '-shm']) {
  const src = join(dataDir, 'tide.db' + suffix)
  if (existsSync(src)) copyFileSync(src, join(probeDir, 'tide.db' + suffix))
}
const db = new DatabaseSync(join(probeDir, 'tide.db'))

const memory = createMemory({
  db,
  model: 'Xenova/bge-small-zh-v1.5',
  mirror: process.env.HF_ENDPOINT,
  cacheDir: join(probeDir, 'models'),
  importHistory: false,   // 只读探测：不要触发历史索引
  docRoots: [],
})

// 从库里挑含「精确词」的条目：路径、命令、标识符
const rows = db.prepare(`
  SELECT id, text FROM memory
  WHERE deleted_at IS NULL AND (
    text LIKE '%sqlite-vec%' OR text LIKE '%workspace%' OR text LIKE '%MEMORY.md%'
    OR text LIKE '%systemctl%' OR text LIKE '%bge-small%' OR text LIKE '%tide.db%'
    OR text LIKE '%dsh-whale-tide%' OR text LIKE '%pnpm%' OR text LIKE '%RRULE%'
  )
  ORDER BY RANDOM() LIMIT 12
`).all()

const queries = []
for (const row of rows) {
  const text = String(row.text)
  const words = ['sqlite-vec', 'workspace', 'MEMORY.md', 'systemctl', 'bge-small', 'tide.db', 'dsh-whale-tide', 'pnpm', 'RRULE']
  const hit = words.find((w) => text.includes(w))
  if (hit) queries.push({ q: hit, wantId: row.id })
}

let ok = 0
const fails = []
for (const { q, wantId } of queries) {
  const hits = await memory.recallHits(q, 6)
  const got = hits.some((h) => Number(h.id) === Number(wantId))
  if (got) ok += 1
  else fails.push({ q, wantId, top: hits.slice(0, 2).map((h) => String(h.text).slice(0, 40)) })
}
console.log(`精确词查询 ${queries.length} 个，原条目进入 top-6：${ok} / ${queries.length} = ${(ok / queries.length * 100).toFixed(0)}%`)
if (fails.length) {
  console.log('\n没召回的：')
  for (const f of fails) console.log(`  查「${f.q}」→ 期望 #${f.wantId}，实际 top2：${JSON.stringify(f.top)}`)
}
