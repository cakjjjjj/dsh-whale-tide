/**
 * 情感模型的纯函数部分。
 *
 * 设计约束（写死在代码里，不靠自觉）：
 *   1. 分数只能被「事件」和「时间」改变，模型没有直接写分的接口；
 *   2. 一次事件的冲量有上限，不允许一句话把某个维度从 50 推到 90；
 *   3. 每个维度有自己的基线和半衰期，不是统一的 50 和统一的回弹。
 *
 * 维度分三组，区别只在半衰期：
 *   情绪（瞬时）：joy / anger / sadness
 *   关系（慢变）：liking / love / dislike
 *   残留（中速）：resentment / longing
 */

export const DIMS = {
  joy: { label: '快乐', group: 'mood', baseline: 45, halfLifeHours: 3, maxImpulse: 16 },
  anger: { label: '生气', group: 'mood', baseline: 30, halfLifeHours: 2, maxImpulse: 23 },
  sadness: { label: '哀伤', group: 'mood', baseline: 20, halfLifeHours: 8, maxImpulse: 16 },

  liking: { label: '喜欢', group: 'bond', baseline: 55, halfLifeHours: 300, maxImpulse: 6 },
  love: { label: '爱', group: 'bond', baseline: 40, halfLifeHours: 600, maxImpulse: 4 },
  dislike: { label: '讨厌', group: 'bond', baseline: 10, halfLifeHours: 300, maxImpulse: 6 },

  resentment: { label: '怨气', group: 'residue', baseline: 12, halfLifeHours: 36, maxImpulse: 13 },
  longing: { label: '离愁', group: 'residue', baseline: 15, halfLifeHours: 48, maxImpulse: 16 },
}

export const DIM_KEYS = Object.keys(DIMS)

/**
 * 事件类型 → 对各个维度的冲量（1.0 强度时的基准值）。
 * 正数拉高，负数压低。数值是设计参数，不是真实心理学量表。
 */
export const EVENTS = {
  praise: { label: '被夸', delta: { joy: 8, liking: 2, anger: -4 } },
  affection: { label: '亲昵', delta: { joy: 6, liking: 3, love: 2, sadness: -3 } },
  share: { label: '分享', delta: { joy: 4, liking: 1.5 } },
  help: { label: '被依赖', delta: { joy: 5, liking: 2, love: 1 } },
  reunion: { label: '重逢', delta: { joy: 10, longing: -12, sadness: -4, liking: 1 } },
  farewell: { label: '分别', delta: { longing: 10, sadness: 5, liking: -1 } },
  neglect: { label: '被冷落', delta: { sadness: 6, longing: 5, joy: -6, liking: -2, dislike: 1 } },
  rebuke: { label: '被责备', delta: { anger: 10, joy: -8, resentment: 5, liking: -3, dislike: 1 } },
  conflict: { label: '冲突', delta: { anger: 14, sadness: 6, resentment: 8, joy: -10, liking: -4, love: -1, dislike: 3 } },
  apology: { label: '被道歉', delta: { anger: -10, resentment: -6, joy: 4, liking: 1, dislike: -3 } },
  hurt: { label: '被伤害', delta: { sadness: 10, anger: 6, dislike: 3, liking: -4, love: -2 } },
  care: { label: '被照顾', delta: { joy: 7, liking: 3, love: 2, sadness: -3, dislike: -1 } },
  teased: { label: '被逗笑', delta: { joy: 7, liking: 2, sadness: -2, anger: -3 } },
}

/** 强度系数：轻 / 中 / 重。 */
export const INTENSITY = { light: 0.5, normal: 1, heavy: 1.6 }

/**
 * 连续刺激的衰减系数：同一类事件在窗口内第 2 次只算 60%，第 3 次 36%……
 * 真实情绪有适应性——连骂十句 ≠ 十个「第一次」。
 */
export const REPEAT_DECAY = 0.6

/** 衰减积分的最大步长（小时）。0.25 = 15 分钟。 */
const MAX_STEP_HOURS = 0.25
/** 单次调用最多积分多少步，防止超长时间跨度把 CPU 占住。 */
const MAX_STEPS = 2000

/** 初始状态：所有维度落在各自基线上。 */
export function initialDims() {
  const dims = {}
  for (const key of DIM_KEYS) dims[key] = DIMS[key].baseline
  return dims
}

export function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 纯衰减：向基线指数回弹。
 *
 * 用固定步长积分，而不是一次算完：
 * 软饱和的 speedup 取决于「当前的偏离量」，一次算 8 小时和分 32 次各算 15 分钟，
 * 结果会差好几倍——一次算会在高速区一路冲到底，分步算会越走越慢。
 * 切成等长小步之后两者结果一致：「睡一觉醒来」和「一直在聊」得到同一个情绪。
 *
 * @param {Record<string, number>} dims
 * @param {number} elapsedHours
 */
export function decay(dims, elapsedHours) {
  const hours = Math.max(0, Number(elapsedHours) || 0)
  const out = {}
  for (const key of DIM_KEYS) out[key] = Number(dims?.[key] ?? DIMS[key].baseline)
  if (hours <= 0) return out

  const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(hours / MAX_STEP_HOURS)))
  const dt = hours / steps

  for (let i = 0; i < steps; i += 1) {
    for (const key of DIM_KEYS) {
      const { baseline, halfLifeHours } = DIMS[key]
      const value = out[key]
      const dev = Math.abs(value - baseline)
      // 已经贴着基线：直接对齐，免得留下 0.0001 的浮点尾巴
      if (dev < 0.05) {
        out[key] = baseline
        continue
      }
      // 偏离越大回得越快（软饱和）：强烈情绪本来就更难长时间维持。
      // 没有这一条，长期随机输入会把关系类维度推到 0 或 100 回不来。
      const speedup = dev > 20 ? 1 + Math.pow((dev - 20) / 20, 2) : 1
      const factor = Math.pow(0.5, dt / (halfLifeHours / speedup))
      out[key] = clamp(baseline + (value - baseline) * factor)
    }
  }
  return out
}

/**
 * 施加一个事件。冲量按维度上限截断，结果仍在 0–100。
 *
 * @param {Record<string, number>} dims
 * @param {string} kind EVENTS 的键
 * @param {'light'|'normal'|'heavy'} intensity
 * @param {{ repeat?: number }} options repeat = 同类事件在近期窗口内已经发生过几次
 */
export function applyEvent(dims, kind, intensity = 'normal', { repeat = 0 } = {}) {
  const event = EVENTS[kind]
  if (!event) throw new Error(`未知事件类型：${kind}`)
  const scale = INTENSITY[intensity] ?? 1
  // 连着来同样的刺激，一次比一次轻
  const saturation = Math.pow(REPEAT_DECAY, Math.max(0, Number(repeat) || 0))
  const delta = {}
  const next = { ...dims }
  for (const [key, raw] of Object.entries(event.delta)) {
    if (!DIMS[key]) continue
    const limit = DIMS[key].maxImpulse
    const impulse = clamp(raw * scale * saturation, -limit, limit)
    const before = Number(next[key] ?? DIMS[key].baseline)
    next[key] = clamp(before + impulse)
    const actual = Number((next[key] - before).toFixed(2))
    if (actual !== 0) delta[key] = actual
  }
  return { dims: next, delta, saturation }
}

/** 一次 tick：先按经过时间衰减，再返回新状态。 */
export function tick(dims, now, lastTick) {
  const elapsedHours = Math.max(0, (Number(now) - Number(lastTick)) / 3_600_000)
  return { dims: decay(dims, elapsedHours), elapsedHours }
}

/** 与基线的偏离量（正负都在内），用于找「现在最明显的情绪」。 */
export function deviations(dims) {
  const out = []
  for (const key of DIM_KEYS) {
    const base = DIMS[key].baseline
    const value = Number(dims?.[key] ?? base)
    out.push({ key, label: DIMS[key].label, value, base, deviation: value - base })
  }
  out.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation))
  return out
}

/**
 * 用代码（不是模型）把状态翻译成一句话。
 * 刻意保持克制：偏离不足 8 分时不描述，避免「每句话都在演情绪」。
 *
 * 每个维度正负两个方向都要有话说。只写正向的话，负向会掉回「平稳」——
 * 「心里凉了却说没事」是最糟的错，比多描述一句更假。
 */
export function moodLine(dims) {
  const ranked = deviations(dims).filter((item) => Math.abs(item.deviation) >= 8)
  if (!ranked.length) return '心情平稳，没什么特别的'
  const top = ranked[0]
  const up = top.deviation > 0
  const phrases = {
    joy: up ? '心情亮亮的，话会多一点，想多陪你聊两句' : '有点提不起劲，话会变短',
    anger: up ? '心里有点火，说话会冲，但会收着' : '火气消下去了，能好好说话了',
    sadness: up ? '有点低落，反应会慢半拍，但还是会回你' : '缓过来了，心里松了些',
    liking: up ? '跟你亲近了些，愿意多说点心里话' : '有点生分，会悄悄退半步',
    love: up ? '心里软软的，想多待一会儿' : '心里有点凉，爱意先收起来了',
    dislike: up ? '有点抗拒，会往后退一步' : '没那么抗拒了',
    resentment: up ? '还存着点气，没完全过去' : '那点气散了',
    longing: up ? '有点想你，会往门口看两眼' : '没那么想了，安心做自己的事',
  }
  const phrase = phrases[top.key]
  if (!phrase) return '心情平稳，没什么特别的'
  return `${phrase}（${top.label} ${Math.round(top.value)}）`
}
