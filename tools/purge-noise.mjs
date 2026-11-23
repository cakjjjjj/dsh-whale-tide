#!/usr/bin/env node
/**
 * 清理漏进记忆的系统注入。
 *
 * 这些不是对话，是 dsh 每轮塞进会话的上下文（运行时快照、时间戳、
 * 审批开关说明、mood 注入、schedule 变更通知）。它们 role 都是 user，
 * 早期版本一律当真人消息入库，实测占 13.8%，且是「重复率 23%」的主要来源。
 *
 * 默认 dry run，只报告；--apply 才写 deleted_at（软删，30 天内可恢复）。
 *
 *   DSH_HOME=/path/to/harness node tools/purge-noise.mjs
 *   DSH_HOME=/path/to/harness node tools/purge-noise.mjs --apply
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const apply = process.argv.includes('--apply')
const dataDir = process.env.TIDE_DATA_DIR
  || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'whale-tide') : join(homedir(), '.dsh', 'whale-tide'))
const db = new DatabaseSync(join(dataDir, 'tide.db'))

/** 明确的系统注入：整条匹配即判定，不做模糊猜测。 */
const PATTERNS = [
  ['approval', /^(用户: )?Approval prompts (are|is)/i],
  ['runtime', /^(用户: )?Current runtime context\./i],
  ['elapsed', /^(用户: )?Elapsed since the/i],
  ['timezone', /^(用户: )?Browser time zone for this request/i],
  ['cwd', /^(用户: )?Current working directory:/i],
  ['snapshot', /^(用户: )?This snapshot supersedes/i],
  ['dsh-path', /^(用户: )?Current DSH (file policy|Harness)/i],
  ['time-sample', /^(用户: )?Time sampled while preparing/i],
  ['mood-block', /^(用户: )?## 鲸鲸此刻的感觉/],
  ['schedule-change', /^(用户: )?\[SCHEDULE (CHANGE|REMINDER)\]/i],
]

/** 疑似 AGENTS.md 片段：只报告，不自动删（可能是真人贴的文档）。 */
const SUSPECT = /^(用户: )?[\s\S]{0,40}(## (性格|不要这样做|怎么说话)|^\|\s*场合\s*\|)/m

const rows = db.prepare('SELECT id, text, ts FROM memory WHERE deleted_at IS NULL').all()
const hit = new Map()
const suspects = []
for (const row of rows) {
  const text = String(row.text ?? '')
  const found = PATTERNS.find(([, re]) => re.test(text))
  if (found) {
    if (!hit.has(found[0])) hit.set(found[0], [])
    hit.get(found[0]).push(row)
  } else if (SUSPECT.test(text) && text.length > 80) {
    suspects.push(row)
  }
}

const total = hit.size ? [...hit.values()].reduce((n, list) => n + list.length, 0) : 0
console.log(`库里 ${rows.length} 条，命中系统注入 ${total} 条：`)
for (const [kind, list] of [...hit.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${kind.padEnd(16)} ${String(list.length).padStart(4)} 条  例：${list[0].text.slice(0, 46).replace(/\n/g, ' ')}`)
}
console.log(`\n疑似 AGENTS.md 片段（不自动删，请人工看）：${suspects.length} 条`)
for (const row of suspects.slice(0, 3)) {
  console.log(`  #${row.id} ${row.text.slice(0, 60).replace(/\n/g, ' ')}`)
}

if (!apply) {
  console.log('\ndry run。确认无误后加 --apply 写入 deleted_at（软删，可恢复）。')
  process.exit(0)
}

const now = Date.now()
const stmt = db.prepare('UPDATE memory SET deleted_at = ? WHERE id = ?')
let n = 0
db.exec('BEGIN IMMEDIATE')
try {
  for (const list of hit.values()) {
    for (const row of list) {
      stmt.run(now, row.id)
      n += 1
    }
  }
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  console.error('回滚：', error?.message ?? error)
  process.exit(1)
}
console.log(`\n已软删 ${n} 条。恢复：UPDATE memory SET deleted_at = NULL WHERE deleted_at = ${now};`)
