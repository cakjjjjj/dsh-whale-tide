/**
 * 关键词检索的分词：中文按相邻两字切（bigram），ASCII 词整体保留。
 *
 * 为什么不用 FTS5 内置的 trigram：它要求查询至少 3 个字符，
 * 「心跳」「备份」这种最常用的两字中文直接 0 条；查询里的 `.` `-`
 * 还会被当成 FTS 语法，报 syntax error near "."。
 *
 * 为什么不用裸 unicode61：它把一整串连续汉字当成一个 token，
 * 搜「心跳」命中不了「鲸鲸心跳的配置在…」。所以写入与查询两侧
 * 都必须先过 bigram()，否则两个索引永远对不上。
 */

const HAN = /^[\u4e00-\u9fa5]+$/
const TOKEN = /[\u4e00-\u9fa5]+|[A-Za-z0-9_./-]+/g
/** 精确词：命令名、文件名、路径、标识符（含字母的 ASCII 串，允许 . _ - /）。 */
const IDENT = /[A-Za-z][A-Za-z0-9_./-]*/g
/** FTS5 里没有意义的 token（只剩标点）先滤掉，否则会生成空短语。 */
const MEANINGFUL = /[A-Za-z0-9\u4e00-\u9fa5]/

/**
 * 中文按相邻两字切；ASCII 词（含 . / _ -）整体保留并小写。
 * 写入与查询必须共用这一个函数。
 * @param {string} text
 * @returns {string} 以空格分隔的 token 串
 */
export function bigram(text) {
  const out = []
  for (const match of String(text ?? '').matchAll(TOKEN)) {
    const word = match[0]
    if (HAN.test(word)) {
      if (word.length === 1) out.push(word)
      for (let i = 0; i < word.length - 1; i += 1) out.push(word.slice(i, i + 2))
    } else {
      out.push(word.toLowerCase())
    }
  }
  return out.join(' ')
}

/**
 * 查询转 FTS5 安全表达式：每个 token 加引号。
 *
 * 召回入口拿到的是**用户整句话**（`recallHits(text)`），所以这里分两种：
 *   1. 句子里有精确词（`sqlite-vec`、`MEMORY.md`、`tide.db`）→ 只用这些词，OR 连接。
 *      把整句中文 bigram 全 AND 上去几乎必然 0 条，关键词一路等于白装。
 *   2. 没有精确词（短查询，如「心跳」「备份策略」）→ 中文 bigram，AND 连接，
 *      相当于短语匹配；长句里确实没有精确词（>8 个 bigram）时返回 null，
 *      退回向量一路，不硬凑噪声。
 * @param {string} keyword
 * @returns {string|null} null 时调用方跳过 FTS 一路
 */
export function ftsQuery(keyword) {
  const raw = String(keyword ?? '')
  const idents = [...raw.matchAll(IDENT)]
    .map((match) => match[0].toLowerCase())
    .filter((token) => token.length >= 2)
  if (idents.length) {
    return idents.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
  }
  const tokens = bigram(raw)
    .split(' ')
    .filter((token) => token && MEANINGFUL.test(token))
  if (!tokens.length) return null
  // 长句里全是普通中文 bigram：AND 起来必然 0 条，OR 起来全是噪声。不如不要这一路。
  if (tokens.length > 8) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ')
}
