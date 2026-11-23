/**
 * 一条记忆有多重要——决定它衰减多慢、以及鲸梦能不能删它。
 *
 * 2026-11-12 之前 importance 是个死字段：schema 有、`planForgotten` 里拿它当保护条件，
 * 但全项目没有一处写它，377 条全是默认的 0.5，「重要度 ≥0.7 不删」形同虚设。
 *
 * 这里的判断是启发式，不是打分模型。宁可判高（更耐忘、更难被删），
 * 也不要判低——记忆被误删是不可逆的，多留一条只是多占几 KB。
 */

export const IMPORTANCE = {
  /** 钉住：永不衰减、永不参与清理 */
  PINNED: 1.0,
  /** 用户明确要求记住 */
  EXPLICIT: 0.9,
  /** 文档切片（MEMORY.md / GOALS.md / diary） */
  DOC: 0.8,
  /** 被召回 3 次以上：显然有用 */
  RECALLED: 0.75,
  /** 关于用户的稳定事实（身份、偏好、身边的人、在做的项目） */
  FACT: 0.7,
  /** 普通对话 */
  NORMAL: 0.5,
}

/** 用户明确要求「记住」的说法。 */
const EXPLICIT_MARKERS = [
  /记住/,
  /记得/,
  /别忘了?/,
  /以后.{0,6}(都|要|别|不要)/,
  /重要(的)?(事|内容|一点)/,
  /提醒我/,
  /这个要存/,
]

/** 关于用户的稳定事实：身份、偏好、身边人、在做的项目。 */
const FACT_MARKERS = [
  /我叫|我的名字/,
  /我在.{0,16}(工作|上班|读书|上学|住|生活|做|搞|负责|管)/,
  /我是.{2,12}(工程师|运维|开发|学生|老师|医生|设计师)/,
  /我(喜欢|不喜欢|讨厌|爱|离不开)/,
  /我的(猫|狗|家人|孩子|爸妈|公司|服务器|项目|机器|电脑)/,
  /我(养|住|用|做)了?/,
]

/**
 * @param {{ source?: string, role?: string|null, text?: string, pinned?: number }} input
 * @returns {number} 0–1
 */
export function importanceOf({ source, role, text, pinned = 0 } = {}) {
  if (Number(pinned) === 1) return IMPORTANCE.PINNED
  if (source === 'doc') return IMPORTANCE.DOC
  const body = String(text ?? '')
  if (!body) return IMPORTANCE.NORMAL
  // 只有用户说的话才可能是「要求记住」或「关于我的事实」；
  // 鲸鲸自己的回复按普通记录处理，避免它自夸一句就被永久保留。
  if (role === 'user' || role == null) {
    if (EXPLICIT_MARKERS.some((re) => re.test(body))) return IMPORTANCE.EXPLICIT
    if (FACT_MARKERS.some((re) => re.test(body))) return IMPORTANCE.FACT
  }
  return IMPORTANCE.NORMAL
}

/** 被召回到一定次数之后，重要度至少抬到这里。 */
export const RECALL_PROMOTE_AFTER = 3
