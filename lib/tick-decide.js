/**
 * L0 节拍器的判断层（纯函数，方便测试）。
 *
 * 它回答的不是「要不要主动找他」，而是「现在值不值得叫醒它」：
 * 醒了之后做什么由 L1 的模型自己决定，这里只负责省钱——
 * 每 10 分钟问一次，绝大多数回答应该是 skip。
 *
 * 五道闸，任何一道都能让它继续睡：
 *   静默时段 / 额度用完 / 情绪不适合 / 刚醒过 / 既没冲动也没想做的事
 */

import { createAgency } from './heartbeat/index.js'
import { behaviorOf } from './emotion/behavior.js'
import { initialDims } from './emotion/model.js'
import { CONFIG_DEFAULTS } from './config.js'

const silentLogger = { info() {}, warn() {} }

/**
 * @param {{ db: import('node:sqlite').DatabaseSync, saved?: object, now?: number }} input
 * @returns {{ mode: 'skip'|'wake', reason: string, plan: object, gapMinutes: number|null, config: object }}
 */
export function decide({ db, saved = {}, now = Date.now() }) {
  const cfg = { ...CONFIG_DEFAULTS, ...saved }

  let dims = initialDims()
  try {
    const row = db.prepare('SELECT dims FROM soul_state WHERE id = 1').get()
    if (row) dims = JSON.parse(row.dims)
  } catch {
    // 状态表还没有：按基线处理
  }

  const behavior = behaviorOf(dims)
  const agency = createAgency({
    db,
    logger: silentLogger,
    getConfig: () => cfg,
    // tick 用只读连接跑：绝不能在这里建表
    ensureSchema: false,
  })
  const plan = agency.plan({ dims, now })

  // 距离上次唤醒多久
  let gapMinutes = null
  try {
    const last = db
      .prepare("SELECT ts FROM agency_action WHERE kind = 'tick' AND result != 'slept' ORDER BY id DESC LIMIT 1")
      .get()
    if (last) gapMinutes = (now - Number(last.ts)) / 60_000
  } catch {
    gapMinutes = null
  }
  const minGap = Number(cfg.wakeGapMinutes ?? 30)
  const urgeFloor = Number(cfg.wakeUrge ?? 0.45)

  const verdict = (mode, reason) => ({ mode, reason, plan, gapMinutes, config: cfg })

  if (plan.quiet) return verdict('skip', '静默时段')
  if (plan.budgetLeft <= 0) return verdict('skip', '今天的额度用完了')
  if (!behavior.proactive) return verdict('skip', '情绪不适合主动')
  if (gapMinutes !== null && gapMinutes < minGap) {
    return verdict('skip', `刚醒过 ${Math.round(gapMinutes)} 分钟`)
  }
  if (plan.urge < urgeFloor && plan.candidates.length === 0) {
    return verdict('skip', '没冲动，也没有想做的事')
  }
  return verdict('wake', '有话想说，或者有事想做')
}
