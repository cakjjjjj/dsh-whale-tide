/**
 * 排序与渲染：把向量近邻变成一段能塞进提示词的文字。
 *
 * 三层加权，对应「记得牢不牢」：
 *   1. 相似度      —— 这条和当前话题有多近
 *   2. 留存率      —— 艾宾浩斯：越久没被想起越淡；被想起过、被标重要的更牢
 *   3. 钉住        —— pinned 的记忆不参与衰减，永远参与排序
 *
 * 公式刻意保守：相似度是主项，留存率只在 0.6–1.0 之间做调节，
 * 免得一条很久以前提过、但和当前话题无关的话被顶上来。
 */

import { basename } from 'node:path'
import { truncate } from './text.js'

const HOUR = 3_600_000
const DOC_BONUS = 0.08
const PINNED_BONUS = 0.25
/** 留存率的下限：再淡的记忆，相似度够高也还有机会。 */
const MIN_RETENTION = 0.6
/**
 * 稳定度基数（小时）= 168，是**衰减时间常数**，不是半衰期。
 * 一次都没被想起时：e^(-168/168) ≈ 0.37，真正的半衰期是 ln2 × 168 ≈ 116 小时（约 4.8 天）。
 */
const BASE_STABILITY_HOURS = 168

/**
 * 艾宾浩斯式留存率。
 * 稳定度随「被访问次数」和「重要性」增长：想起来一次，就记得更久一点。
 * @returns {number} 0–1
 */
export function retentionOf(row, now = Date.now()) {
  if (Number(row.pinned) === 1) return 1
  const ts = Number(row.last_access ?? row.ts ?? 0)
  if (!ts) return MIN_RETENTION
  const ageHours = Math.max(0, (now - ts) / HOUR)
  // 封顶：被想起的次数不无限滚雪球，否则热门记忆会自我强化、越排越前。
  const access = Math.min(12, Math.max(0, Number(row.access_count ?? 0)))
  const importance = Math.min(1, Math.max(0, Number(row.importance ?? 0.5)))
  const stability = BASE_STABILITY_HOURS * (1 + access) * (0.5 + importance)
  return Math.exp(-ageHours / stability)
}

function stamp(ts) {
  if (!ts) return '未知时间'
  const d = new Date(Number(ts))
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Reciprocal Rank Fusion：只用名次，不用分数，对尺度免疫。
 *
 * 为什么不按分数加权：BM25 无上界、余弦在 0–1，
 * 不做归一化直接加权等于让 BM25 单方面决定排序。
 * @param {Array<Array<Record<string, unknown>>>} lists 每路已按相关性排好序
 * @param {{ k?: number }} options
 */
export function rrf(lists, { k = 60 } = {}) {
  const merged = new Map()
  for (const list of lists) {
    if (!list?.length) continue
    list.forEach((row, index) => {
      const id = Number(row.id)
      if (!Number.isFinite(id)) return
      const entry = merged.get(id) ?? { row, paths: 0, score: 0 }
      // 同一行两路都命中时保留带 distance 的那份（向量行），FTS 行没有 distance
      if (entry.row.distance === undefined && row.distance !== undefined) {
        entry.row = { ...entry.row, distance: row.distance }
      }
      entry.paths += 1
      entry.score += 1 / (k + index + 1)
      merged.set(id, entry)
    })
  }
  // 归一化：单路第一 = 1，两路都第一 = 2。
  // 分母不能取 2/(k+1)——那样单路命中最高只到 0.5，加上留存系数后整批掉到
  // minScore(0.35) 以下被静默丢弃，融合等于没做（第一版就是这个错）。
  const max = 1 / (k + 1)
  const out = []
  for (const entry of merged.values()) {
    out.push({ ...entry.row, fused: entry.score / max, rrfScore: entry.score, fusedPaths: entry.paths })
  }
  out.sort((a, b) => b.fused - a.fused)
  return out
}

/**
 * 两路召回的结果 → 融合 → 排序。
 *
 * 抽成纯函数是为了能直接单测「融合」这一段，不用拉 embedding 模型。
 * 关键词一路没有结果时退回原来的纯向量排序：与加第二路之前完全一致。
 * @param {{ vecRows?: Array, ftsRows?: Array, topK?: number, minScore?: number,
 *   excludeSessionId?: string, perSession?: number, now?: number, k?: number }} input
 */
export function fuse({
  vecRows = [],
  ftsRows = [],
  topK = 4,
  minScore = 0.35,
  excludeSessionId,
  perSession = 2,
  now = Date.now(),
  k = 60,
} = {}) {
  const anyFts = ftsRows.length > 0
  const rows = anyFts ? rrf([vecRows, ftsRows], { k }) : vecRows
  return rank(rows, {
    topK,
    minScore,
    excludeSessionId,
    perSession,
    now,
    mode: anyFts ? 'fused' : 'vector',
  })
}

/**
 * 近邻行 → 排序后的命中。
 * @param {Array<Record<string, unknown> & { distance?: number, fused?: number }>} rows
 * @param {{ topK?: number, minScore?: number, excludeSessionId?: string, now?: number,
 *   perSession?: number, mode?: 'vector'|'fused' }} options
 *   mode='fused' 表示 rows 已由 rrf() 融合（用 fused 分，没有 distance）
 */
export function rank(rows, options = {}) {
  const { topK = 4, minScore = 0.35, excludeSessionId, now = Date.now(), perSession = 2, mode = 'vector' } = options
  const fusedMode = mode === 'fused'
  const scored = []
  for (const row of rows) {
    const similarity = fusedMode ? Number(row.fused) : 1 - Number(row.distance)
    if (!Number.isFinite(similarity)) continue
    if (excludeSessionId && row.session_id === excludeSessionId) continue
    const isDoc = row.source === 'doc'
    const pinned = Number(row.pinned) === 1
    const retention = retentionOf(row, now)
    // 留存率压到 MIN_RETENTION–1 区间再乘，保证相似度仍是主项
    const retentionFactor = MIN_RETENTION + (1 - MIN_RETENTION) * retention
    const score =
      similarity * retentionFactor +
      (isDoc ? DOC_BONUS : 0) +
      (pinned ? PINNED_BONUS : 0)
    if (score < minScore) continue
    scored.push({ ...row, similarity, retention, score })
  }
  scored.sort((a, b) => b.score - a.score)

  const picked = []
  const perSessionCount = new Map()
  for (const hit of scored) {
    const key = String(hit.session_id ?? hit.ref ?? 'doc')
    const used = perSessionCount.get(key) ?? 0
    if (used >= perSession) continue
    if (picked.some((p) => p.text.includes(hit.text) || hit.text.includes(p.text))) continue
    perSessionCount.set(key, used + 1)
    picked.push(hit)
    if (picked.length >= topK) break
  }
  return picked
}

/** 命中 → 注入文本；空命中返回空串，让上层直接跳过。 */
export function render(hits, { maxChars = 900, title = '相关记忆' } = {}) {
  if (!hits.length) return ''
  const lines = []
  let used = 0
  for (const hit of hits) {
    const where = hit.source === 'doc' ? basename(String(hit.ref ?? '笔记')) : '会话'
    const line = `- [${stamp(hit.ts)} · ${where}] ${truncate(hit.text, 220)}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  return [
    `## ${title}`,
    '本地向量检索从既有会话与笔记里取出的片段，可能相关也可能无关，按需取舍：',
    ...lines,
  ].join('\n')
}
