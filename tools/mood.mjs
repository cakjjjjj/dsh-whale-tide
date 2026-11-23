#!/usr/bin/env node
/**
 * 给日程脚本用的情绪阀门。
 *
 *   node tools/mood.mjs             # 一行：normal / bright / quiet
 *   node tools/mood.mjs --json      # 完整状态 + 行为约束
 *   node tools/mood.mjs --allow     # 只在「可以主动」时退出码 0，否则 1
 *
 * 只读，不改状态。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { behaviorOf, modeLabel } from '../lib/emotion/behavior.js'
import { initialDims, moodLine } from '../lib/emotion/model.js'

const dataDir = process.env.TIDE_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'whale-tide')
const dbPath = join(dataDir, 'tide.db')

let dims = initialDims()
try {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const row = db.prepare('SELECT dims FROM soul_state WHERE id = 1').get()
  if (row) dims = JSON.parse(row.dims)
  db.close()
} catch {
  // 没有库就按基线算
}

const args = process.argv.slice(2)
const behavior = behaviorOf(dims)
const mode = modeLabel(dims)

if (args.includes('--json')) {
  console.log(JSON.stringify({ mode, mood: moodLine(dims), dims, ...behavior }, null, 1))
} else if (args.includes('--allow')) {
  console.log(mode)
  process.exit(behavior.proactive ? 0 : 1)
} else {
  console.log(mode)
}
