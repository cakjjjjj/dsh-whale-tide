/**
 * 一轮对话的情感结算：读状态 → 衰减 → 解读 → 应用 → 落库。
 *
 * 这是唯一会改变分数的入口。它不做判断对错，只记账。
 */

import { applyEvent, decay, initialDims, moodLine, tick } from './model.js'
import { classify } from './interpreter.js'
import { loadState, recordEvent, saveState } from '../db.js'

/** 同类事件的「连续」判定窗口：30 分钟内重复，冲量逐步打折。 */
const REPEAT_WINDOW_MS = 30 * 60 * 1000

/**
 * 最近窗口内同一类事件发生过几次。
 * 查库而不是靠内存，重启后也能接上「刚才连着吵了三句」这个事实。
 */
function countRecent(db, kind, now, windowMs) {
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM soul_event WHERE kind = ? AND ts >= ?')
      .get(kind, Number(now) - windowMs)
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

/**
 * 一轮对话的情感结算：读状态 → 衰减 → 解读 → 应用 → 落库。
 *
 * 这是唯一会改变分数的入口。它不做判断对错，只记账。
 * 全程一个事务：多会话同时说话时，读-改-写不会互相覆盖。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ text: string, now?: number, sessionId?: string, memoryId?: number }} input
 */
export function step(db, { text, now = Date.now(), sessionId, memoryId, events = true }) {
  // 定时任务投递的 prompt 不是「他说的话」：只结算时间衰减，不判事件。
  // 否则心跳/鲸梦的指令里出现「失败」「过期」这类词就会误加情绪。
  const reading = events
    ? classify(text)
    : { kind: 'none', intensity: 'normal', why: '', hits: 0 }

  db.exec('BEGIN IMMEDIATE')
  try {
    const state = loadState(db, initialDims, now)
    const { dims: decayed } = tick(state.dims, now, state.lastTick)

    let dims = decayed
    let delta = {}
    let repeat = 0
    if (reading.kind !== 'none') {
      repeat = countRecent(db, reading.kind, now, REPEAT_WINDOW_MS)
      const applied = applyEvent(decayed, reading.kind, reading.intensity, { repeat })
      dims = applied.dims
      delta = applied.delta
      recordEvent(db, {
        ts: now,
        kind: reading.kind,
        intensity: { light: 0.5, normal: 1, heavy: 1.6 }[reading.intensity] ?? 1,
        delta,
        dimsAfter: dims,
        why: reading.why,
        memoryId,
      })
    }

    saveState(db, dims, now)
    db.exec('COMMIT')

    return {
      reading,
      delta,
      dims,
      repeat,
      moodLine: moodLine(dims),
      changed: Object.keys(delta).length > 0,
      sessionId,
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务可能已经因错误自动回滚
    }
    throw error
  }
}

export { decay, moodLine, countRecent, REPEAT_WINDOW_MS }
