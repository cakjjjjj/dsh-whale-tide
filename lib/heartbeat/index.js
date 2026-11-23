/**
 * 能动性：私心、预算、决定要不要主动。
 *
 * 这一层不替鲸鲸做决定，只做三件事：
 *   1. 记账——发过什么、什么时候、结果如何；
 *   2. 卡预算——一天能主动几次、几点之后不许吵；
 *   3. 给建议——按当前情绪和私心清单，回答「现在该不该主动」。
 *
 * 真正的「想不想说话」由模型读私心清单后决定，但预算和静默时段是硬的。
 */

import { behaviorOf } from '../emotion/behavior.js'
import { stamp } from '../time.js'

const DAY = 86_400_000

export const DEFAULTS = {
  /** 一天最多主动联系几次（不是消息条数，是「主动发起」的次数）。 */
  maxReachPerDay: 3,
  /** 每天发放的行动额度：用不完可以攒，攒到 maxBalance 封顶。 */
  dailyGrant: 3,
  /** 额度上限。 */
  maxBalance: 20,
  /** 静默时段：这段时间除非他先说话，否则不主动。 */
  quietFrom: 23,
  quietTo: 8,
  /** 低于这个「想联系」分数，就别硬找。 */
  minUrge: 0.3,
}

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function createAgency({ db, logger = console, config = {}, getConfig = null, ensureSchema = true }) {
  // 配置可以在运行时改：优先用外部提供的实时读取器，其次用静态对象
  const readConfig = () =>
    typeof getConfig === 'function' ? { ...DEFAULTS, ...getConfig() } : { ...DEFAULTS, ...config }
  const cfg = readConfig()

  // 只读连接（比如轻唤醒脚本）不能建表：让调用方决定要不要确保 schema 存在。
  if (ensureSchema) {
    db.exec(`CREATE TABLE IF NOT EXISTS agency_desire (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_ts INTEGER NOT NULL, text TEXT NOT NULL,
      why TEXT, weight REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'open', done_ts INTEGER)`)
    db.exec(`CREATE TABLE IF NOT EXISTS agency_action (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, channel TEXT,
      summary TEXT NOT NULL, mood TEXT, result TEXT NOT NULL DEFAULT 'planned')`)
    // 额度余额：只有一行（id = 1）。granted_on 是「哪一天发放的」，本地日期 YYYY-MM-DD。
    // 用独立的行存余额，是因为「攒额度」必须跨天持久化；跟着行动账本反推会依赖历史起点。
    db.exec(`CREATE TABLE IF NOT EXISTS agency_budget (
      id INTEGER PRIMARY KEY CHECK (id = 1), balance REAL NOT NULL DEFAULT 0, granted_on TEXT NOT NULL)`)
  }

  function addDesire({ text, why = null, weight = 0.5, now = Date.now() }) {
    const result = db
      .prepare('INSERT INTO agency_desire(created_ts, text, why, weight) VALUES (?, ?, ?, ?)')
      .run(now, String(text).slice(0, 500), why, Math.min(1, Math.max(0, Number(weight) || 0.5)))
    return Number(result.lastInsertRowid)
  }

  function listDesires({ status = 'open', limit = 20 } = {}) {
    return db
      .prepare('SELECT id, created_ts, text, why, weight, status FROM agency_desire WHERE status = ? ORDER BY weight DESC, id DESC LIMIT ?')
      .all(status, limit)
      .map((row) => ({
        id: Number(row.id),
        ageDays: Math.round((Date.now() - Number(row.created_ts)) / DAY),
        text: String(row.text),
        why: row.why,
        weight: Number(row.weight),
      }))
  }

  function closeDesire(id, status = 'done', now = Date.now()) {
    const result = db
      .prepare('UPDATE agency_desire SET status = ?, done_ts = ? WHERE id = ? AND status = ?')
      .run(status, now, Number(id), 'open')
    return Number(result.changes ?? 0)
  }

  /** 今天已经主动过几次。 */
  function usedToday(now = Date.now()) {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM agency_action WHERE ts >= ? AND kind = 'reach_out' AND result = 'sent'")
      .get(startOfDay(now))
    return Number(row?.n ?? 0)
  }

  /** 本地日期，用来判断「今天发放过没有」。 */
  function todayKey(now = Date.now()) {
    const d = new Date(now)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  /**
   * 算当前余额，**不写库**——轻唤醒脚本用的是只读连接，这里不能有副作用。
   * 跨天只补发一次（不按离线天数补），避免放几天假回来攒出一堆主动。
   */
  function peekBudget(now = Date.now()) {
    const live = readConfig()
    const grant = Math.max(0, Number(live.dailyGrant ?? DEFAULTS.dailyGrant))
    const cap = Math.max(0, Number(live.maxBalance ?? DEFAULTS.maxBalance))
    const key = todayKey(now)
    let balance = grant
    try {
      const row = db.prepare('SELECT balance, granted_on FROM agency_budget WHERE id = 1').get()
      if (row) {
        balance = String(row.granted_on) === key
          ? Number(row.balance)
          : Math.min(cap, Number(row.balance) + grant)
      } else {
        balance = Math.min(cap, grant)
      }
    } catch {
      // 只读连接里表可能还没建：按今天刚发的算
      balance = Math.min(cap, grant)
    }
    return Math.max(0, balance)
  }

  /** 发放并持久化余额。写连接调用；只读连接不能用。 */
  function rollBudget(now = Date.now()) {
    const live = readConfig()
    const grant = Math.max(0, Number(live.dailyGrant ?? DEFAULTS.dailyGrant))
    const cap = Math.max(0, Number(live.maxBalance ?? DEFAULTS.maxBalance))
    const key = todayKey(now)
    try {
      const row = db.prepare('SELECT balance, granted_on FROM agency_budget WHERE id = 1').get()
      if (!row) {
        const balance = Math.min(cap, grant)
        db.prepare('INSERT INTO agency_budget(id, balance, granted_on) VALUES (1, ?, ?)').run(balance, key)
        return balance
      }
      if (String(row.granted_on) !== key) {
        const balance = Math.min(cap, Number(row.balance) + grant)
        db.prepare('UPDATE agency_budget SET balance = ?, granted_on = ? WHERE id = 1').run(balance, key)
        return balance
      }
      return Number(row.balance)
    } catch (error) {
      logger.warn?.(`额度发放失败：${error?.message ?? error}`)
      return 0
    }
  }

  /** 花掉一次额度（记账时调）。 */
  function spend(now = Date.now()) {
    rollBudget(now)
    try {
      const row = db.prepare('SELECT balance FROM agency_budget WHERE id = 1').get()
      const next = Math.max(0, Number(row?.balance ?? 0) - 1)
      db.prepare('UPDATE agency_budget SET balance = ? WHERE id = 1').run(next)
      return next
    } catch {
      return 0
    }
  }

  function inQuietHours(now = Date.now()) {
    const { quietFrom, quietTo } = readConfig()
    // 相等视为「不设静默」：否则 hour >= 8 || hour < 8 恒真，会把人锁死在静默里。
    if (Number(quietFrom) === Number(quietTo)) return false
    const hour = new Date(now).getHours()
    if (quietFrom < quietTo) return hour >= quietFrom && hour < quietTo
    return hour >= quietFrom || hour < quietTo
  }

  /**
   * 现在该不该主动。
   * @returns {{ allowed: boolean, reason: string, budgetLeft: number, urge: number, candidates: object[] }}
   */
  function plan({ dims, now = Date.now() }) {
    const live = readConfig()
    const behavior = behaviorOf(dims)
    const used = usedToday(now)
    const balance = peekBudget(now)
    // 两道闸取小：余额管「攒」，maxReachPerDay 管「一天别刷屏」
    const dayCap = Math.max(0, Number(live.maxReachPerDay ?? DEFAULTS.maxReachPerDay) - used)
    const budgetLeft = Math.min(Math.floor(balance), dayCap)
    const desires = listDesires({ limit: 10 })
    // 他最后一次说话是什么时候：判断「该不该主动」比只看额度更靠谱。
    const lastUserAt = (() => {
      try {
        const row = db
          .prepare("SELECT MAX(ts) AS t FROM memory WHERE source = 'chat' AND deleted_at IS NULL AND text LIKE '用户:%'")
          .get()
        return row?.t ? Number(row.t) : null
      } catch {
        return null
      }
    })()

    // 「想联系」的冲动：亲近 + 离愁 + 心情，减去火气与低落
    const urgeRaw =
      0.35 +
      (Number(dims?.liking ?? 55) - 55) / 200 +
      (Number(dims?.longing ?? 15) - 15) / 150 +
      (Number(dims?.joy ?? 45) - 45) / 250 -
      (Number(dims?.anger ?? 30) - 30) / 200 -
      (Number(dims?.sadness ?? 20) - 20) / 300
    const urge = Math.max(0, Math.min(1, urgeRaw))
    const topDesire = desires[0] ?? null
    const desireBoost = topDesire ? Number(topDesire.weight) * 0.15 : 0

    const reasons = []
    if (!behavior.proactive) reasons.push('情绪状态不适合主动')
    if (inQuietHours(now)) reasons.push('静默时段')
    if (budgetLeft <= 0) reasons.push(balance < 1 ? '额度用完了（攒额上限内每天发一点）' : '今天的主动次数用完了')
    if (urge + desireBoost < live.minUrge) reasons.push('此刻没有想联系的冲动')

    const allowed = reasons.length === 0
    return {
      allowed,
      reason: allowed ? '可以主动，但要不要发由你决定' : reasons.join('；'),
      budgetLeft,
      used,
      lastUserAt,
      balance: Math.floor(balance),
      maxBalance: Math.max(0, Number(live.maxBalance ?? DEFAULTS.maxBalance)),
      dailyGrant: Math.max(0, Number(live.dailyGrant ?? DEFAULTS.dailyGrant)),
      urge: Number((urge + desireBoost).toFixed(2)),
      candidates: topDesire ? [topDesire] : [],
      quiet: inQuietHours(now),
      proactive: behavior.proactive,
    }
  }

  /** 记账：无论发没发，都留痕。 */
  // 默认按「已经发生」记账：调用 record 就说明这件事做了，忘传 result 不该让预算漏扣。
  // 要记「计划中」请显式传 result: 'planned'，它不计入预算。
  function record({ kind = 'reach_out', channel = 'qq', summary, mood = null, result = 'sent', now = Date.now() }) {
    const res = db
      .prepare('INSERT INTO agency_action(ts, kind, channel, summary, mood, result) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now, kind, channel, String(summary).slice(0, 500), mood, result)
    // 真发出去一次就花掉一次额度；planned / skipped / failed 不扣。
    if (String(kind) === 'reach_out' && String(result) === 'sent') spend(now)
    return Number(res.lastInsertRowid)
  }

  function recentActions({ limit = 10 } = {}) {
    return db
      .prepare('SELECT id, ts, kind, channel, summary, result FROM agency_action ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: Number(row.id),
        at: stamp(row.ts),
        kind: String(row.kind),
        channel: row.channel,
        summary: String(row.summary),
        result: String(row.result),
      }))
  }

  return {
    addDesire, listDesires, closeDesire, plan, record, recentActions, usedToday, inQuietHours,
    peekBudget, rollBudget, spend, getConfig: readConfig,
  }
}
