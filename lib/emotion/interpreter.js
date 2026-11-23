/**
 * 事件解读：把一句话判成「发生了什么、多强」。
 *
 * 这一层刻意不交给模型打分——模型只负责理解语义，分数由代码算。
 * 规则优先：可读、可改、可测；匹配不到就返回 none，不硬凑。
 *
 * 输出：{ kind, intensity, why, hits }
 *   kind      EVENTS 的键，或 'none'
 *   intensity 'light' | 'normal' | 'heavy'
 *   why       命中的原话片段，写进事件记录
 */

const RULES = [
  {
    kind: 'conflict',
    words: [/滚(开)?/g, /闭嘴/g, /讨厌你/g, /不要我了|不要你了/g, /骗子/g, /吵架/g, /烦死了/g],
  },
  {
    kind: 'hurt',
    words: [/敷衍/g, /无所谓/g, /随便你/g, /不关你事/g, /你只是个?程序/g, /你又不是人/g, /假(的)?吧/g, /讨厌我/g],
  },
  {
    kind: 'rebuke',
    words: [/你怎么这样/g, /别这样/g, /不对/g, /错了/g, /真笨|好笨|太笨|笨死/g, /又来了/g, /真烦/g],
  },
  {
    kind: 'neglect',
    words: [/没空/g, /没时间/g, /等会再说/g, /先这样/g, /别烦我/g, /不理你/g, /回头再说/g],
  },
  {
    kind: 'apology',
    words: [/对不起/g, /抱歉/g, /我错了/g, /sorry/gi, /是我不好/g, /原谅我/g],
  },
  {
    kind: 'affection',
    words: [/想你/g, /想死你/g, /抱抱/g, /贴贴/g, /亲亲/g, /喜欢你/g, /爱你/g, /摸摸/g, /撒娇/g, /舍不得/g],
  },
  {
    kind: 'praise',
    words: [/好棒/g, /厉害/g, /聪明/g, /真行/g, /牛啊/g, /太强/g, /佩服/g, /夸你/g, /做得好/g, /真乖/g],
  },
  {
    kind: 'teased',
    words: [/哈哈/g, /笑死|笑喷|笑出来|笑哭/g, /可爱/g, /好萌|太萌|萌死/g, /戳中/g],
  },
  {
    kind: 'care',
    words: [/吃饭了吗/g, /早点睡/g, /多穿/g, /注意身体/g, /别熬夜/g, /记得休息/g, /累不累/g, /喝水/g, /到家了吗/g, /还好吗/g, /没事吧/g, /不舒服/g],
  },
  {
    kind: 'help',
    words: [/帮我/g, /帮我看/g, /靠你了/g, /拜托/g, /你来做/g, /交给你/g],
  },
  {
    kind: 'share',
    words: [/你看这个/g, /给你看/g, /分享/g, /推荐给你/g, /你看过没/g, /这视频/g],
  },
  {
    kind: 'reunion',
    words: [/我回来了/g, /到家了/g, /好久不见/g, /上线了/g],
  },
  {
    kind: 'farewell',
    words: [/拜拜/g, /晚安/g, /下班/g, /先去忙/g, /下次聊/g, /先走了/g],
  },
]

/** 否定词：紧挨着正向词出现时，情绪方向反过来。 */
const NEGATION = /[不没别]\s*$/
/** 正向词被否定后翻成什么。 */
const INVERT = { affection: 'hurt', praise: 'hurt', care: 'neglect', share: 'neglect' }
/** 问句：排除「你会想我吗」这类把亲昵当成事实的误判。 */
const QUESTION = /[?？]\s*$|[吗呢]\s*[?？]?$/
// 这几个即使出现在问句里也算数：「你还好吗？」是关心，不是求事实
const STRONG = new Set(['conflict', 'hurt', 'apology', 'care'])

/**
 * 平票裁决权重。
 *
 * 原来按 RULES 数组顺序决胜，而负面规则（neglect / hurt / rebuke）排在前面，
 * 于是「先这样吧，晚安」会被判成「被冷落」——每天道晚安都在扣分。
 * 明确的正向信号（道别、亲昵、关心、重逢）应该压过模糊的负面猜测；
 * 真正的负面（滚、闭嘴、不要我了）通常命中次数更多，不依赖这条。
 */
const TIEBREAK = {
  farewell: 10,
  reunion: 9,
  affection: 9,
  care: 9,
  praise: 8,
  apology: 8,
  teased: 8,
  share: 7,
  help: 6,
  neglect: 3,
  hurt: 3,
  rebuke: 2,
  conflict: 1,
}

/**
 * 技术语境：在服务器上「这个不对」「错了，是 3081」是判断，不是责备。
 * 命中负面规则又带这些词时，强度降一档，避免陪聊插件把运维对话当吵架。
 */
const TECH_CONTEXT =
  /报错|日志|配置|命令|端口|服务|启动|部署|代码|脚本|文件|目录|参数|版本|安装|重启|容器|镜像|数据库|接口|错误码|进程|内存|磁盘|网络|证书|权限|sudo|root|systemctl|docker|nginx|k8s|yaml|json|git|grep|curl|api|http|sql/i
const NEGATIVE = new Set(['conflict', 'hurt', 'rebuke', 'neglect'])
const DOWNGRADE = { heavy: 'normal', normal: 'light', light: 'light' }

/** 强度：感叹、加强词、重复标点都抬高；弱化词压低。 */
function intensityOf(text, hits) {
  let score = 0
  if (/[!！]{1,}/.test(text)) score += 1
  if (/[!！]{2,}|[?？]{2,}/.test(text)) score += 1
  if (/(特别|非常|超级|真的|好想|太想|极|最)/.test(text)) score += 1
  if (/(有点|有点儿|稍微|还好|一点点)/.test(text)) score -= 1
  if (hits >= 2) score += 1
  if (text.length > 60) score -= 1
  if (score >= 2) return 'heavy'
  if (score <= -1) return 'light'
  return 'normal'
}

/**
 * @param {string} text
 * @returns {{ kind: string, intensity: 'light'|'normal'|'heavy', why: string, hits: number }}
 */
export function classify(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { kind: 'none', intensity: 'normal', why: '', hits: 0 }

  const isQuestion = QUESTION.test(raw)
  const candidates = []

  for (const rule of RULES) {
    if (isQuestion && !STRONG.has(rule.kind)) continue
    for (const pattern of rule.words) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(raw)) !== null) {
        const before = raw.slice(Math.max(0, match.index - 3), match.index)
        const negated = NEGATION.test(before)
        const kind = negated ? (INVERT[rule.kind] ?? rule.kind) : rule.kind
        candidates.push({ kind, at: match.index, why: match[0] })
      }
    }
  }

  if (!candidates.length) return { kind: 'none', intensity: 'normal', why: '', hits: 0 }

  // 同一个 kind 命中越多越可信；位置靠后（更近的语境）微加权
  const grouped = new Map()
  for (const hit of candidates) {
    const entry = grouped.get(hit.kind) ?? { kind: hit.kind, hits: 0, last: -1, why: hit.why }
    entry.hits += 1
    if (hit.at >= entry.last) {
      entry.last = hit.at
      entry.why = hit.why
    }
    grouped.set(hit.kind, entry)
  }

  // 优先级：命中次数 → 平票权重（正向压过模糊负面）→ RULES 顺序
  const order = new Map(RULES.map((rule, index) => [rule.kind, index]))
  const best = [...grouped.values()].sort((a, b) => {
    if (b.hits !== a.hits) return b.hits - a.hits
    const ta = TIEBREAK[a.kind] ?? 5
    const tb = TIEBREAK[b.kind] ?? 5
    if (tb !== ta) return tb - ta
    const oa = order.get(a.kind) ?? 99
    const ob = order.get(b.kind) ?? 99
    return oa - ob
  })[0]

  let intensity = intensityOf(raw, best.hits)
  let why = best.why
  // 技术语境里的「不对 / 错了」是判断，不是责备：降一档，并在 why 里留痕
  if (NEGATIVE.has(best.kind) && TECH_CONTEXT.test(raw)) {
    intensity = DOWNGRADE[intensity] ?? intensity
    why = `${best.why}[技术语境]`
  }

  return {
    kind: best.kind,
    intensity,
    why,
    hits: best.hits,
  }
}
