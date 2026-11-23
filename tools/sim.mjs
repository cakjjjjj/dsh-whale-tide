#!/usr/bin/env node
/**
 * 情绪曲线模拟：不接 DSH，直接看这套参数会不会发疯。
 *
 *   node tools/sim.mjs            # 模拟 7 天，每天 20 个事件
 *   node tools/sim.mjs 30 50      # 30 天，每天 50 个事件
 *
 * 打印每天结束时的状态和最明显的情绪，以及各维度的极值。
 */

import { DIMS, DIM_KEYS, EVENTS, applyEvent, decay, initialDims, moodLine } from '../lib/emotion/model.js'

const days = Math.max(1, Number(process.argv[2]) || 7)
const perDay = Math.max(1, Number(process.argv[3]) || 20)
const kinds = Object.keys(EVENTS)
const levels = ['light', 'normal', 'heavy']

let dims = initialDims()
let tick = 0
const peaks = Object.fromEntries(DIM_KEYS.map((key) => [key, { min: 100, max: 0 }]))

for (let day = 1; day <= days; day += 1) {
  for (let i = 0; i < perDay; i += 1) {
    tick += 1
    dims = decay(dims, 24 / perDay)
    const kind = kinds[(tick * 7) % kinds.length]
    const level = levels[(tick * 3) % levels.length]
    dims = applyEvent(dims, kind, level).dims
    for (const key of DIM_KEYS) {
      peaks[key].min = Math.min(peaks[key].min, dims[key])
      peaks[key].max = Math.max(peaks[key].max, dims[key])
    }
  }
  const strong = DIM_KEYS
    .map((key) => `${DIMS[key].label} ${Math.round(dims[key])}`)
    .join(' · ')
  console.log(`第 ${String(day).padStart(2)} 天  ${moodLine(dims)}`)
  console.log(`         ${strong}`)
}

console.log('\n各维度极值（%s 天 × %s 事件）：', days, perDay)
for (const key of DIM_KEYS) {
  const { min, max } = peaks[key]
  const base = DIMS[key].baseline
  console.log(
    `  ${DIMS[key].label.padEnd(3, '　')} 基线 ${String(base).padStart(3)}  范围 ${String(Math.round(min)).padStart(3)}–${String(Math.round(max)).padStart(3)}`,
  )
}
