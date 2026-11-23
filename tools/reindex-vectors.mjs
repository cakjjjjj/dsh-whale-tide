#!/usr/bin/env node
/**
 * 重算记忆的向量（换模型、或修「有正文没向量」的孤儿）。
 *
 * 为什么需要它：换 embedding 模型时，库里旧向量还是老模型算的，
 * 两个模型的空间不是同一个，余弦距离失去意义——不报错，只是检索悄悄变坏。
 * 之前没有任何工具能重算，只能手工重建库。
 *
 * 用法：
 *   node tools/reindex-vectors.mjs --dry                 # 只看有多少行要重算
 *   node tools/reindex-vectors.mjs                       # 真算（默认库：$DSH_HOME/whale-tide/tide.db）
 *   node tools/reindex-vectors.mjs --db /tmp/copy.db     # 拿副本试
 *   node tools/reindex-vectors.mjs --model Xenova/bge-small-zh-v1.5 --dtype q8
 *
 * 注意：
 *   - 先停 dsh-web。库是 WAL 模式，两个进程同时写会互相踩。
 *   - 动手前 cp tide.db tide.db.bak。
 *   - 只支持「维度不变」的重算（默认 512 维，bge-small-zh-v1.5）。
 *     换维度还得改 lib/db.js 里写死的 float[512]，这个脚本不管。
 */

import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { openSoulDb } from '../lib/db.js'
import { createEmbedder } from '../lib/memory/embed.js'

const require = createRequire(import.meta.url)

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const dbPath = arg('db', join(DSH_HOME, 'whale-tide', 'tide.db'))
const model = arg('model', 'Xenova/bge-small-zh-v1.5')
const dtype = arg('dtype', 'q8')
const mirror = arg('mirror', 'https://hf-mirror.com')
const cacheDir = arg('cache', join(DSH_HOME, 'whale-tide', 'models'))
const batch = Math.max(1, Number(arg('batch', '8')))
const dry = process.argv.includes('--dry')
const yes = process.argv.includes('--yes')

if (!existsSync(dbPath)) {
  console.error(`库不存在：${dbPath}`)
  process.exit(1)
}

const db = openSoulDb(dbPath)
const total = Number(db.prepare('SELECT COUNT(*) AS n FROM memory').get()?.n ?? 0)
const withVec = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_vec').get()?.n ?? 0)
const missing = Math.max(0, total - withVec)

console.log(`库：${dbPath}`)
console.log(`记忆 ${total} 条，已有向量 ${withVec} 条，缺 ${missing} 条`)
console.log(`模型：${model}（${dtype}）`)

if (dry) {
  console.log('--dry：只数了数，没动。')
  process.exit(0)
}

if (!yes) {
  console.log('')
  console.log('这条命令会重算全部向量，旧向量作废。确认三点：')
  console.log('  1. dsh-web 已经停了')
  console.log(`  2. 备份过了：cp ${dbPath} ${dbPath}.bak`)
  console.log('  3. 维度还是 512（换维度得改 lib/db.js，这个脚本不管）')
  console.log('')
  console.log('确认无误再加 --yes 重跑。')
  process.exit(1)
}

const backup = `${dbPath}.before-reindex`
try {
  if (!existsSync(backup)) {
    copyFileSync(dbPath, backup, 1) // COPYFILE_EXCL：已有备份就不覆盖
    console.log(`已备份：${backup}`)
  } else {
    console.log(`备份已存在，跳过：${backup}`)
  }
} catch (error) {
  console.error(`备份失败，停手：${error.message}`)
  process.exit(1)
}

const embedder = createEmbedder({ model, dtype, mirror, cacheDir, batchSize: batch })
const rows = db.prepare('SELECT id, text FROM memory ORDER BY id').all()
console.log(`开始重算 ${rows.length} 条…`)

const insert = db.prepare('INSERT OR REPLACE INTO memory_vec(rowid, embedding) VALUES (?, ?)')
let done = 0
let failed = 0

db.exec('DELETE FROM memory_vec')
db.exec('BEGIN IMMEDIATE')
try {
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch)
    let vectors
    try {
      vectors = await embedder.embed(slice.map((r) => r.text))
    } catch (error) {
      console.error(`  批次 ${i}–${i + slice.length - 1} 嵌入失败：${error.message}`)
      failed += slice.length
      continue
    }
    for (let k = 0; k < slice.length; k += 1) {
      const vec = vectors[k]
      if (!Array.isArray(vec) || vec.length !== 512) {
        failed += 1
        continue
      }
      insert.run(BigInt(slice[k].id), new Float32Array(vec))
      done += 1
    }
    if ((i / batch) % 10 === 0) console.log(`  ${done}/${rows.length}`)
  }
  db.exec('COMMIT')
} catch (error) {
  try {
    db.exec('ROLLBACK')
  } catch {
    // 可能已自动回滚
  }
  console.error(`中途失败，已回滚：${error.message}`)
  process.exit(1)
}

const after = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_vec').get()?.n ?? 0)
console.log(`完成：写入 ${done} 条，失败 ${failed} 条，向量表现在 ${after} 条。`)
if (failed) console.log('失败的条目没有向量，检索只能靠关键词捞——可以再跑一次补。')
