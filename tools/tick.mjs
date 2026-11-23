#!/usr/bin/env node
/**
 * L0 节拍器。每 10 分钟问一次：现在值不值得叫醒它？
 *
 *   skip  → 继续睡，零成本（纯 SQLite 读，不调模型）
 *   wake  → 值得花一次模型调用，去看看私心、想想有没有话要说
 *
 * 判断逻辑在 lib/tick-decide.js（纯函数，有单测）；这里只负责 IO。
 * 只读数据库，不写状态；唤醒记录（kind=tick）由 L1 自己记。
 *
 * 数据目录：TIDE_DATA_DIR 或 $DSH_HOME/whale-tide
 * 找不到库时退出码 1 并打印实际路径——不再静默返回 skip，
 * 否则「心跳从来没醒过」这件事会被藏起来。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { decide } from '../lib/tick-decide.js'

// 数据目录探测顺序写清楚：显式指定 > DSH_HOME > 用户目录。
// ⚠️ DSH_HOME 只在 systemd 服务进程里存在；cron / 手动执行时没有。
const explicitDataDir = process.env.TIDE_DATA_DIR
const dshHome = process.env.DSH_HOME
const dataDir = explicitDataDir
  || (dshHome ? join(dshHome, 'whale-tide') : join(homedir(), '.dsh', 'whale-tide'))
const dbPath = join(dataDir, 'tide.db')

function emit(mode, reason, extra = {}) {
  const payload = { mode, reason, dataDir, ...extra }
  if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 1))
  else console.log(`${mode} ${reason}`)
  process.exit(0)
}

if (existsSync(join(dataDir, 'PAUSE'))) emit('skip', 'PAUSE 文件在，全部只读')

if (!existsSync(dbPath)) {
  console.error(`[tick] 找不到记忆库：${dbPath}`)
  console.error('[tick] 请设置 TIDE_DATA_DIR 或 DSH_HOME，例如：')
  console.error('[tick]   DSH_HOME=/path/to/harness node tools/tick.mjs')
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: true })

// 只读连接里不建表：先确认迁移跑过，缺表时给一句能看懂的提示，
// 而不是让 createAgency 抛 "attempt to write a readonly database"。
const hasSchema = (() => {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('agency_desire','agency_action','soul_state')")
      .get()
    return Number(row?.n ?? 0) === 3
  } catch {
    return false
  }
})()
if (!hasSchema) {
  console.error(`[tick] 库结构不完整（缺 agency_* / soul_state）：${dbPath}`)
  console.error('[tick] 先启动一次 dsh-web，让插件把迁移跑完，再回来跑这个脚本')
  process.exit(1)
}

const saved = {}
try {
  for (const row of db.prepare('SELECT key, value FROM tide_config').all()) {
    try {
      saved[String(row.key)] = JSON.parse(row.value)
    } catch {
      // 脏数据忽略
    }
  }
} catch {
  // 没有配置表就全用默认值
}

const verdict = decide({ db, saved })
db.close()

emit(verdict.mode, verdict.reason, {
  urge: Number(verdict.plan?.urge ?? 0),
  budgetLeft: verdict.plan?.budgetLeft ?? null,
  wakeUrge: Number(verdict.config?.wakeUrge ?? 0.45),
  gapMinutes: verdict.gapMinutes === null ? null : Math.round(verdict.gapMinutes),
  desires: (verdict.plan?.candidates ?? []).map((item) => item.text),
})
