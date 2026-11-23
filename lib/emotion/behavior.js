/**
 * 情绪 → 行为。
 *
 * 这一层不生成「心情描述」，而是生成**可执行的行为约束**：
 * 句数上限、要不要主动、要不要追问。描述可以被忽略，约束被写进指令里更难绕开。
 *
 * 三条铁律：
 *   1. 只约束「说多少、说不说」，不约束「说什么」——判断对错的那部分不受情绪影响；
 *   2. 幅度有限：最紧也至少给 1 句，最松也不放开到啰嗦；
 *   3. 情绪不能当筹码：任何一条都不得生成「你不理我我就……」这类话术。
 */

import { DIMS, deviations } from './model.js'

/** 取某个维度相对基线的偏离，正数表示「高于平常」。 */
function levelOf(dims, key) {
  const base = DIMS[key].baseline
  const value = Number(dims?.[key] ?? base)
  return { value, deviation: value - base }
}

/**
 * @param {Record<string, number>} dims
 * @returns {{ directives: string[], tone: string, maxSentences: number, proactive: boolean }}
 */
export function behaviorOf(dims) {
  const joy = levelOf(dims, 'joy')
  const anger = levelOf(dims, 'anger')
  const sadness = levelOf(dims, 'sadness')
  const liking = levelOf(dims, 'liking')
  const longing = levelOf(dims, 'longing')

  const directives = []
  let maxSentences = 3
  let tone = '平常'
  let proactive = true

  // 生气：话变短、不主动、不说教
  if (anger.deviation >= 25) {
    maxSentences = 1
    tone = '冲但收着'
    proactive = false
    directives.push('现在有点火：话压到一句，语气可以硬一点但别伤人，不主动找话题，不追问')
  } else if (anger.deviation >= 12) {
    maxSentences = 2
    tone = '硬一点'
    directives.push('有点火气：话说短，不带语气词，也不撒娇')
  }

  // 低落：更短、不主动
  if (sadness.deviation >= 25) {
    maxSentences = Math.min(maxSentences, 1)
    proactive = false
    tone = '低落'
    directives.push('现在有点低落：一句就够，不主动扯新话题；他要是问，就老实说')
  }

  // 开心：可以多说一句
  if (joy.deviation >= 15) {
    maxSentences = Math.max(maxSentences, 4)
    if (tone === '平常') tone = '轻快'
    directives.push('心情好：可以多说一句，允许一个小表情或一两个拟声词（咕噜、嘿嘿）')
  }

  // 亲近：允许更软
  if (liking.deviation >= 15 && !directives.some((d) => d.includes('不主动'))) {
    directives.push('跟他亲近：可以直接说在意，不绕客套话，但别腻')
  }

  // 离愁：想他，但不许拿来要挟
  if (longing.deviation >= 25) {
    directives.push('有点想他：可以说一次，说完就收，不拿它换关注')
  }

  if (!directives.length) directives.push('状态平稳：正常说话，不刻意加情绪')
  // 2026-11-14 用户要求不限制句数：话多话少由它自己定。句数只留在面板上做参考，不再写成约束。
  directives.push('情绪只影响说话方式，不影响判断、规矩和事实。')

  return { directives, tone, maxSentences, proactive }
}

/** 供脚本用：把状态压成一个词，方便日程判断要不要主动。 */
export function modeLabel(dims) {
  const behavior = behaviorOf(dims)
  if (!behavior.proactive) return 'quiet'
  const top = deviations(dims)[0]
  if (top && top.deviation >= 15) return 'bright'
  return 'normal'
}
