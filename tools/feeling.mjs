#!/usr/bin/env node
/**
 * 手动试情绪：给几句话，看状态怎么变。
 *
 *   node tools/feel.mjs "我想你了" "你真笨" "对不起"
 *   node tools/feel.mjs "我想你了|你真笨|对不起"     # 用 | 分隔也行
 *
 * 每次运行都用一个临时库，不动真实状态。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSoulDb, stats } from '../lib/db.js'
import { step } from '../lib/emotion/turn.js'
import { DIMS, DIM_KEYS } from '../lib/emotion/model.js'

const argv = process.argv.slice(2).flatMap((arg) => arg.split('|')).map((s) => s.trim()).filter(Boolean)
if (!argv.length) {
  console.error('用法：node tools/feel.mjs "第一句" "第二句" …')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'soul-feel-'))
const db = openSoulDb(join(dir, 'tide.db'))
let now = Date.now()

try {
  for (const text of argv) {
    now += 60_000
    const result = step(db, { text, now })
    const delta = Object.entries(result.delta)
      .map(([key, value]) => `${DIMS[key].label}${value > 0 ? '+' : ''}${value.toFixed(1)}`)
      .join(' ')
    console.log(`\n他说：「${text}」`)
    const reading = result.reading.kind === 'none'
      ? '没触发（中性）'
      : `${result.reading.kind} / ${result.reading.intensity} / 命中「${result.reading.why}」`
    console.log(`  判读：${reading}`)
    if (delta) console.log(`  变化：${delta}`)
    console.log(`  现在：${result.moodLine}`)
  }

  const { dims } = step(db, { text: '', now })
  console.log('\n最终状态：')
  for (const key of DIM_KEYS) {
    const base = DIMS[key].baseline
    const value = dims[key]
    const arrow = value > base ? '↗' : value < base ? '↘' : '—'
    console.log(`  ${DIMS[key].label.padEnd(3, '　')} ${String(Math.round(value)).padStart(3)}  ${arrow}`)
  }
  console.log(`\n事件记录：${stats(db).events} 条`)
} finally {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}
