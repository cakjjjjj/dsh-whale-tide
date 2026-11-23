/**
 * 运行时可改的配置。
 *
 * 只有「行为参数」放这里——静默时段、主动次数、情绪注入开关、分享上限。
 * 情绪的半衰期、冲量上限这类手感常数仍留在代码里：它们需要测试守着，不适合在界面上随手拖。
 */

import { writeFileSync } from 'node:fs'

export const CONFIG_DEFAULTS = {
  /** 一天最多主动联系几次 */
  maxReachPerDay: 3,
  /** 静默时段起（小时，24 小时制） */
  quietFrom: 23,
  /** 静默时段止 */
  quietTo: 8,
  /** 面板用的「想联系」门槛 0..1 */
  minUrge: 0.3,
  /** 轻唤醒的门槛：比面板更保守，因为每次唤醒要花一次模型调用 */
  wakeUrge: 0.45,
  /** 是否把「此刻的感觉」注入提示词 */
  injectMood: true,
  /** 注入文本上限 */
  maxMoodChars: 200,

  // ── 0.4.0 新增：心跳与鲸梦的调度 ──
  /** 心跳总开关 */
  wakeEnabled: true,
  /** 每隔多少分钟醒一次（L1，真正花 token 的那层） */
  wakeEveryMinutes: 180,
  /** 两次唤醒的最小间隔（分钟），防止任务重排后密集触发 */
  wakeGapMinutes: 30,
  /** 鲸梦每天几点做，HH:MM */
  dreamAt: '22:30',
  /** 鲸梦要做哪几件事 */
  dreamTasks: ['health', 'memory', 'persona', 'workspace'],
  /** 鲸梦是否真删记忆（false = 只报告） */
  dreamPrune: false,
  /** 鲸梦是否加一步「写晚安语音」（本机的习惯，默认不写） */
  dreamGoodnight: false,
  /** 记忆归档总开关：开 = 真归档（dry=false 且 archive=true）；关 = 仅报告 */
  memoryArchive: false,
  /** 每天发放的行动额度 */
  dailyGrant: 3,
  /** 额度上限：用不完可以攒，攒到这个数为止 */
  maxBalance: 20,
  /** 心跳提示词里的通知命令（例如 `node scripts/notify-qq.mjs "内容"`）；留空用通用说法 */
  notifyHint: '',
  /** 鲸梦晚安语音发到哪（例如 `c2c:0BFB…`）；留空用通用说法 */
  reportTo: '',
  /** 是否让插件接管心跳/鲸梦的任务（首次打开会重建任务，投递历史清零） */
  scheduleSync: false,
  /**
   * 心跳/鲸梦投到哪个会话：
   *   background —— 各建一个专用后台会话（new_once），不污染主对话，主会话上下文不涨
   *   main       —— 投到最近活跃的会话，你能在聊天窗口里看到它醒来的过程
   *   new        —— 每次都新建会话（一天 8 个，不建议）
   */
  sessionMode: 'background',
}

const RANGES = {
  maxReachPerDay: [0, 20],
  quietFrom: [0, 23],
  quietTo: [0, 23],
  minUrge: [0, 1],
  wakeUrge: [0, 1],
  maxMoodChars: [80, 600],
  wakeEveryMinutes: [30, 720],
  wakeGapMinutes: [10, 240],
  dailyGrant: [0, 20],
  maxBalance: [0, 100],
}

const BOOL_KEYS = new Set(['injectMood', 'wakeEnabled', 'dreamPrune', 'dreamGoodnight', 'memoryArchive', 'scheduleSync'])
const TIME_KEYS = new Set(['dreamAt'])
/** 自由文本型：原样保存，只限长度。 */
const TEXT_KEYS = new Set(['notifyHint', 'reportTo'])
/** 枚举型多选：只接受白名单里的值 */
const LIST_KEYS = {
  dreamTasks: ['health', 'memory', 'persona', 'workspace'],
}

/**
 * 标量枚举：值只能是白名单里的一个字符串，**不是数组**。
 *
 * sessionMode 曾经被错放进 LIST_KEYS，于是 clampConfig 把 'background'
 * 包成了 ['background']：面板下拉框取到数组对不上选项，resolveTarget
 * 收到数组也会走到 new_once 分支。现在单独一类，并且兼容解包旧脏数据。
 */
const ENUM_KEYS = {
  sessionMode: ['background', 'main', 'new'],
}

export function clampConfig(key, value) {
  if (BOOL_KEYS.has(key)) return Boolean(value)
  if (TEXT_KEYS.has(key)) return String(value ?? '').trim().slice(0, 300)
  if (TIME_KEYS.has(key)) {
    const text = String(value ?? '').trim()
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : undefined
  }
  if (key in ENUM_KEYS) {
    // 兼容旧数据：曾被错误地存成 ["background"]，解包取第一个
    const raw = Array.isArray(value) ? value[0] : value
    const text = String(raw ?? '').trim()
    return ENUM_KEYS[key].includes(text) ? text : undefined
  }
  if (key in LIST_KEYS) {
    const allowed = LIST_KEYS[key]
    const raw = Array.isArray(value) ? value : [value]
    // 去重 + 只留白名单 + 按白名单顺序排，保证面板提交什么顺序都稳定
    const picked = new Set(raw.map((item) => String(item)))
    return allowed.filter((item) => picked.has(item))
  }
  const range = RANGES[key]
  const num = Number(value)
  if (!range || !Number.isFinite(num)) return undefined
  return Math.min(range[1], Math.max(range[0], Math.round(num * 100) / 100))
}

export function createConfigStore({ db, logger = console, persistPath = null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS tide_config (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_ts INTEGER NOT NULL)`)

  const load = () => {
    const out = { ...CONFIG_DEFAULTS }
    let rows = []
    try {
      rows = db.prepare('SELECT key, value FROM tide_config').all()
    } catch {
      return out
    }
    for (const row of rows) {
      const key = String(row.key)
      if (!(key in CONFIG_DEFAULTS)) continue
      try {
        const parsed = JSON.parse(row.value)
        const clamped = clampConfig(key, parsed)
        if (clamped !== undefined) out[key] = clamped
      } catch {
        // 脏数据忽略
      }
    }
    return out
  }

  let current = load()
  const listeners = new Set()

  function onChange(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** 保存部分字段；返回完整的新配置。非法值抛错，不做静默修正。 */
  function update(patch, now = Date.now()) {
    const clean = {}
    for (const [key, raw] of Object.entries(patch ?? {})) {
      if (!(key in CONFIG_DEFAULTS)) continue
      const clamped = clampConfig(key, raw)
      if (clamped === undefined) throw new Error(`配置项 ${key} 的值不合法：${String(raw)}`)
      clean[key] = clamped
    }
    if (!Object.keys(clean).length) return current
    // 起点和终点相同不是「24 小时静默」的意思，是配置填错了——直接拒绝，别静默修正。
    const nextQuiet = { ...current, ...clean }
    if (Number(nextQuiet.quietFrom) === Number(nextQuiet.quietTo)) {
      throw new Error('静默时段的起点和终点不能相同；要跨零点请设 quietFrom > quietTo（例如 22 → 8）')
    }
    // 最短间隔 >= 唤醒间隔会锁死：每次醒来都撞上「刚醒过」，永远 skip。
    if (Number(nextQuiet.wakeGapMinutes) >= Number(nextQuiet.wakeEveryMinutes)) {
      throw new Error('两次唤醒的最短间隔必须小于唤醒间隔，否则每次醒来都会撞上「刚醒过」而一直跳过')
    }
    const stmt = db.prepare(
      'INSERT INTO tide_config(key, value, updated_ts) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts',
    )
    // 一次改多个键要么全成要么全不成：中途失败时库里不能留下半套配置。
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [key, value] of Object.entries(clean)) stmt.run(key, JSON.stringify(value), now)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 可能已自动回滚
      }
      throw error
    }
    current = { ...current, ...clean }
    if (persistPath) {
      try {
        writeFileSync(persistPath, `${JSON.stringify(current, null, 2)}\n`)
      } catch {
        // 落盘失败不影响内存生效
      }
    }
    for (const listener of listeners) {
      try {
        listener(current)
      } catch (error) {
        logger.warn?.(`配置回调失败：${error?.message ?? error}`)
      }
    }
    return current
  }

  return {
    get: () => current,
    load,
    update,
    onChange,
    defaults: CONFIG_DEFAULTS,
  }
}
