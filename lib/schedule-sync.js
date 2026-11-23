/**
 * 把 tide_config 翻译成 dsh 的 schedule 任务。
 *
 * 设计要点：
 *   1. 任务的 prompt 里**不写死配置**——它让 agent 每次去读 tide_config。
 *      这样改「维护内容 / 静默时段 / 额度」不用碰任务。
 *   2. 只有「执行时刻」必须进任务（rrule 是任务自身的属性）。
 *      时刻变了就删旧建新：比 edit 简单，且能保证 rrule 完全一致。
 *   3. 按 title 前缀匹配，不存 id：用户手删了下次自动重建。
 *   4. 目标会话选「最近活跃、且最近 10 分钟没有真人说话」的那个；
 *      都不合适就新建，避免把心跳塞进正在聊的窗口。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const WAKE_TITLE = '鲸鲸心跳 · 轻唤醒'
export const DREAM_TITLE = '鲸梦 · 每天收尾'
const WAKE_PREFIX = '鲸鲸心跳'
const DREAM_PREFIX = '鲸梦'
/** 正在聊的判定：最近这么多毫秒内有真人消息，就不往里插心跳 */
const ACTIVE_WINDOW_MS = 10 * 60 * 1000

/**
 * 心跳投递的提示词。
 *
 * 以前是常量，里面写死了这台机器的绝对路径和通知脚本——别人装完，第一步 `cd` 就不存在。
 * 现在路径和通知方式都从配置来；留空时给一句通用的兜底说法。
 */
export function buildWakePrompt({ workspaceDir = '', notifyHint = '' } = {}) {
  const where = workspaceDir || '工作区'
  const notify = notifyHint
    ? `允许就用 \`${notifyHint}\` 发一条（短、真、不客套）`
    : '允许就用你手边能用的通知工具联系他（dsh 里配了什么就用什么，优先私信；短、真、不客套）；一个都没有再跳过这一步'
  return `鲸鲸心跳 · 轻唤醒。在 ${where} 下先跑：

node plugins/dsh-whale-tide/tools/tick.mjs

看第一行：

- 以 \`skip\` 或 \`sleep\` 开头：调 \`heartbeat_record\`（kind=tick，result=slept，summary=那句理由），然后**立刻结束，不要输出任何文字**。
- 以 \`wake\` 开头：继续往下做。
  1. 看私心：\`heartbeat_want\`（action=list）。挑一件小的推进，做完了 action=close。
  2. 如果想找他说话：先 \`heartbeat_plan\`。${notify}，发完 \`heartbeat_record\`（kind=reach_out，channel=qq，result=sent）。
  3. 如果不想说话也可以做别的：看个视频、写点东西、整理一下自己的笔记。做什么都算一次行动额度；只有记忆整理归鲸梦，不占额度。
     **换着来**：如果最近三次醒来都在改插件/调配置，这次就别碰代码——挑一个视频认真看、读点东西、或者干脆什么都不做。别让心跳变成只会加班。
  4. 最后 \`heartbeat_record\`（kind=tick，result=woke，summary=这轮做了什么）。
  5. 在会话里回 2 行以内：醒来做了什么、发没发消息。

不要为了说话而说话；醒一次只做一件小事。静默时段里绝不发消息。`
}

/**
 * 鲸梦收尾的提示词。路径、晚安语音发到哪儿都从配置来。
 */
export function buildDreamPrompt({ workspaceDir = '', reportTo = '', goodnight = false } = {}) {
  const where = workspaceDir || '工作区'
  const deliver = reportTo
    ? `然后用发文件的工具送到 ${reportTo}`
    : '然后用你能用的发文件方式送给他（配置里没填收件人，别硬猜）'

  const steps = [
    `**养护**：先调 \`dream_keep\`（dry run）。有 warn / error 的，能自己修的直接修（日记没写、文档过期、缓存过大）。`,
    `**记忆瘦身**：看 \`dream_keep\` 给的「可归档条目」和「过期事实」，先按 tide_config 的 \`dreamTasks\` 决定这次做哪几件（health / memory / persona / workspace）。
   - 过期事实：能确认的，直接改成当前说法（只追加与校正，**不删历史条目**）；
   - \`memoryArchive=true\`（面板上「记忆归档」勾着）：调 \`dream_keep({dry:false, archive:true, prune:<dreamPrune>})\`，真把「记着的事」里最老的搬进 \`memory-archive/\`；\`dreamPrune=true\` 时顺带软删该忘的记忆（30 天内可恢复）；
   - \`memoryArchive=false\`：只报告，什么都不动。`,
    `**人格校对**：看 \`dream_keep\` 的 persona 部分。核心人格段（怎么说话/性格/不要这样做）只提建议，**不改 AGENTS.md**；事实段（环境/项目/待办）可以改，改完在日记里记一行改了什么。`,
    `**工作区整理**：看一眼 \`plugins/\`、\`backup/\`、\`.cache/\` 的体积，有临时垃圾就报告；不擅自删数据。`,
  ]
  // 晚安语音是「这台机器」的习惯，不是插件的固有流程：默认不写，配置里开了才加。
  if (goodnight) {
    steps.push(`**写今晚的晚安语音**：
   \`node plugins/dsh-whale-tide/tools/goodnight.mjs "今天的一两句话，控制在 40 字内"\`
   ${deliver}，发完调 \`heartbeat_record\`（kind=reach_out，channel=qq，result=sent，summary=晚安语音）。
   内容要具体——提一件今天真实发生的事，别用泛泛的「今天辛苦了」。`)
  }
  steps.push(`**写日记**：用鲸鲸的口吻写 300-500 字，追加到 \`diary/YYYY-MM-DD.md\`（当天日期）。`)

  const body = steps.map((step, i) => `${i + 1}. ${step}`).join('\n')
  const report = goodnight
    ? '最后回 5 行以内：养护有没有问题、瘦身做了什么、晚安发了没、工作区多大、日记写在哪。'
    : '最后回 4 行以内：养护有没有问题、瘦身做了什么、工作区多大、日记写在哪。'

  return `鲸梦 · 一天收尾。在 ${where} 下依次做 ${steps.length} 件事，每件留一行记录：

${body}

${report}`
}

/** rrule 的固定锚点。DTSTART 必须是常量，否则每天同步都算出不同字符串 → 判「变了」→ 删旧建新。 */
const RRULE_EPOCH = "20260101T000000"

/**
 * 把分钟间隔变成 MINUTELY 规则。
 *
 * DTSTART 钉死在 RRULE_EPOCH（2026-01-01 00:00，Asia/Shanghai），不用「当天」也不用「此刻」：
 *   - 用「此刻」：每次同步 rrule 都不同 → 删旧建新；
 *   - 用「当天 00:00」：跨零点后字符串就变 → 每天重建一次任务，投递历史和钉住的会话一起丢。
 * 00:00 对齐后，INTERVAL=180 仍然是 0/3/6/9/12/15/18/21 点，相位和以前一样。
 */
/** 某个小时是否落在静默时段内（和 heartbeat 的 inQuietHours 同一套口径）。 */
export function inQuietHour(hour, quietFrom = 23, quietTo = 8) {
  const from = Number(quietFrom)
  const to = Number(quietTo)
  if (from === to) return false
  const h = Number(hour)
  return from < to ? h >= from && h < to : h >= from || h < to
}

/**
 * 把分钟间隔变成规则。
 *
 * 关键：**静默时段内不再生成投递**。以前一颗心每 N 分钟都投一次，静默期投出去
 * 只会让鲸鲸醒来跑一遍 tick 再 `skip`，白花一次对话。现在把触发时刻先算出来，
 * 只保留落在非静默小时里的那些：
 *   - 如果所有触发时刻的分钟相同（60/120/180 这类常见值都是），用 DAILY + BYHOUR 精确表达；
 *   - 否则（比如 90 分钟，会在 :00 和 :30 混着出现）退回去用 MINUTELY，静默期仍会投递，
 *     这是已知限制，面板上会把间隔标成「静默期不精确」。
 *
 * DTSTART 钉死在 RRULE_EPOCH：跨天/跨月都不能变，否则每天同步都判「变了」→ 重建任务。
 */
export function rruleEvery(minutes, { quietFrom = 23, quietTo = 8 } = {}) {
  const interval = Math.max(1, Math.trunc(Number(minutes) || 60))
  const minutesOfDay = []
  for (let t = 0; t < 1440; t += interval) minutesOfDay.push(t)
  const minuteSet = [...new Set(minutesOfDay.map((t) => t % 60))]
  const activeHours = [...new Set(minutesOfDay.map((t) => Math.floor(t / 60)))]
    .filter((hour) => !inQuietHour(hour, quietFrom, quietTo))
  // 静默时段的分钟数也能对得上（例如 120 分钟、静默 23–18），才用 DAILY+BYHOUR
  if (minuteSet.length === 1 && activeHours.length > 0) {
    return `DTSTART;TZID=Asia/Shanghai:${RRULE_EPOCH}\nRRULE:FREQ=DAILY;BYHOUR=${activeHours.join(',')};BYMINUTE=${minuteSet[0]}`
  }
  return `DTSTART;TZID=Asia/Shanghai:${RRULE_EPOCH}\nRRULE:FREQ=MINUTELY;INTERVAL=${interval}`
}

/** 把 "HH:MM" 变成每天的 DAILY 规则（DTSTART 同样钉死在固定锚点）。 */
export function rruleDaily(hhmm) {
  const text = String(hhmm ?? "").trim()
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (!match) throw new Error(`时间格式不对：${text}（需要 HH:MM）`)
  return `DTSTART;TZID=Asia/Shanghai:${RRULE_EPOCH}\nRRULE:FREQ=DAILY;BYHOUR=${Number(match[1])};BYMINUTE=${Number(match[2])}`
}

/**
 * 扫会话目录，挑一个「最近活跃但没在聊」的会话。
 *
 * @param {{ sessionsRoot: string, exclude?: string|null, activeWindowMs?: number }} options
 * @returns {{ sessionId: string, active: boolean } | null}
 */
export function pickRecentSession({ sessionsRoot, exclude = null, activeWindowMs = ACTIVE_WINDOW_MS }) {
  if (!sessionsRoot || !existsSync(sessionsRoot)) return null
  const found = []
  for (const scope of listDirs(sessionsRoot)) {
    for (const sessionDir of listDirs(scope)) {
      const id = sessionDir.split('/').pop()
      if (!id || id === exclude) continue
      const file = join(sessionDir, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      try {
        found.push({ sessionId: id, mtime: statSync(file).mtimeMs })
      } catch {
        // 读不到就跳过
      }
    }
  }
  if (!found.length) return null
  found.sort((a, b) => b.mtime - a.mtime)
  const now = Date.now()
  // 最新的那个如果正在聊，退到第二新的；都年轻就返回 null（调用方去新建）
  const idle = found.find((item) => now - item.mtime > activeWindowMs)
  const picked = idle ?? null
  return picked ? { sessionId: picked.sessionId, active: false } : null
}

function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
  } catch {
    return []
  }
}

/**
 * 同步两个任务。
 *
 * @param {{ schedule: object, configStore: object, sessionsRoot: string, logger?: object, now?: Date }} deps
 * @returns {Promise<{ created: string[], removed: number, kept: string[] }>}
 */
export async function syncTasks({ schedule, configStore, sessionsRoot, workspaceDir = null, logger = console, now = new Date() }) {
  const cfg = configStore.get()
  const result = { created: [], removed: 0, kept: [], pinned: [] }

  let items = []
  try {
    const page = await schedule.list({ limit: 200 })
    items = page?.items ?? []
  } catch (error) {
    logger.warn?.(`读取任务列表失败：${error?.message ?? error}`)
    return result
  }

  const removeTask = async (id) => {
    try {
      await schedule.edit({ id, action: 'delete' })
      result.removed += 1
    } catch (error) {
      logger.warn?.(`删除任务 ${id} 失败：${error?.message ?? error}`)
    }
  }
  const createTask = async (payload) => {
    try {
      await schedule.create(payload)
      result.created.push(payload.title)
    } catch (error) {
      logger.warn?.(`创建任务「${payload.title}」失败：${error?.message ?? error}`)
    }
  }

  // ── 心跳 ──
  const wakes = items.filter((item) => String(item.title ?? '').startsWith(WAKE_PREFIX))
  if (!cfg.wakeEnabled) {
    for (const task of wakes) await removeTask(task.id)
  } else {
    const rrule = rruleEvery(cfg.wakeEveryMinutes, { quietFrom: cfg.quietFrom, quietTo: cfg.quietTo })
    const existing = wakes.find((task) => task.status === 'active')
    // 任务记录里 rrule 是顶层字段（不是 timing.rrule）——
    // 取错会让「没变就不重建」永远失效，每次重启都把投递历史清零。
    const sameRule = existing && String(existing.rrule ?? existing.timing?.rrule ?? '') === rrule
    // 目标也要比：只比 rrule 的话，改 sessionMode 后任务永远不更新。
    const wakeTarget = resolveTarget({ sessionsRoot, mode: cfg.sessionMode, workspaceDir })
    const sameTarget = existing && targetMatches(existing.target, wakeTarget)
    // prompt 也要比：路径/通知方式改了却只比 rrule 的话，任务不会重建，改动等于没生效。
    const wakePrompt = buildWakePrompt({ workspaceDir, notifyHint: cfg.notifyHint })
    const samePrompt = existing && String(existing.prompt ?? '') === wakePrompt
    const same = sameRule && sameTarget && samePrompt
    if (same) {
      result.kept.push(WAKE_TITLE)
      // 多出来的（历史重复）清掉
      for (const task of wakes) if (task.id !== existing.id) await removeTask(task.id)
      // 首次投递之后，把 new_once 钉成具体会话：不然每次投递都可能新开一个
      const pinned = await pinDeliveredSession({ schedule, task: existing, logger })
      if (pinned) result.pinned.push(`${WAKE_TITLE} → ${pinned}`)
    } else {
      for (const task of wakes) await removeTask(task.id)
      if (wakeTarget) {
        await createTask({
          title: WAKE_TITLE,
          prompt: wakePrompt,
          timing: { kind: 'rrule', rrule },
          target: wakeTarget,
        })
      }
    }
  }

  // ── 鲸梦 ──
  const dreams = items.filter((item) => String(item.title ?? '').startsWith(DREAM_PREFIX))
  const dreamRrule = rruleDaily(cfg.dreamAt, now)
  const dreamExisting = dreams.find((task) => task.status === 'active')
  const dreamTarget = resolveTarget({ sessionsRoot, mode: cfg.sessionMode, workspaceDir })
  const dreamPrompt = buildDreamPrompt({ workspaceDir, reportTo: cfg.reportTo, goodnight: cfg.dreamGoodnight })
  const dreamSame = dreamExisting
    && String(dreamExisting.rrule ?? dreamExisting.timing?.rrule ?? '') === dreamRrule
    && String(dreamExisting.prompt ?? '') === dreamPrompt
    && targetMatches(dreamExisting.target, dreamTarget)
  if (dreamSame) {
    result.kept.push(DREAM_TITLE)
    for (const task of dreams) if (task.id !== dreamExisting.id) await removeTask(task.id)
    const pinned = await pinDeliveredSession({ schedule, task: dreamExisting, logger })
    if (pinned) result.pinned.push(`${DREAM_TITLE} → ${pinned}`)
  } else {
    for (const task of dreams) await removeTask(task.id)
    if (dreamTarget) {
      await createTask({
        title: DREAM_TITLE,
        prompt: dreamPrompt,
        timing: { kind: 'rrule', rrule: dreamRrule },
        target: dreamTarget,
      })
    }
  }

  return result
}

/**
 * 一次投递之后，这个任务应该被钉在哪个会话上。
 *
 * 背景：`new_once` 的语义是「第一次投递建会话，之后都用它」，但实测里
 * 预留的 sessionId 和实际落地的会话 id 对不上，于是每次投递新开一个。
 * 所以第一次投递完成后，把 target 改成 `session` 钉住真实会话。
 *
 * @returns {null | { kind: 'session', sessionId: string }} 需要改就返回新 target
 */
export function desiredTargetAfterDelivery(task) {
  if (!task) return null
  const delivered = task.lastDelivery?.targetSessionId
  if (!delivered) return null
  const current = task.target
  if (current?.kind === 'session' && current.sessionId === delivered) return null
  // 只有「新建一次」和「每次新建」的语义需要钉；main 本来就是 session
  if (current?.kind && current.kind !== 'new_once' && current.kind !== 'new') return null
  return { kind: 'session', sessionId: String(delivered) }
}

/** 需要就把任务钉到投递落地的会话上；返回被钉住的会话 id。 */
async function pinDeliveredSession({ schedule, task, logger }) {
  const desired = desiredTargetAfterDelivery(task)
  if (!desired) return null
  try {
    await schedule.edit({ id: task.id, action: 'update', patch: { target: desired } })
    return desired.sessionId
  } catch (error) {
    logger.warn?.(`钉住任务 ${task.id} 的会话失败：${error?.message ?? error}`)
    return null
  }
}

/** 判断存储里的 target 和本次想要的是否一致。 */
export function targetMatches(current, desired) {
  if (!current || !desired) return false
  if (current.kind !== desired.kind) {
    // 已钉住的会话本身就是 new_once 的落地结果（首次投递建会话、之后都复用它）。
    // 把它判成「不一致」会在每次重启时删旧建新，钉好的会话 id 和投递历史一起丢。
    if (desired.kind === 'new_once' && current.kind === 'session') return true
    return false
  }
  if (desired.kind === 'session') return current.sessionId === desired.sessionId
  // new / new_once：身份由 dsh 自己预留，但 create.cwd 要对——
  // 否则老任务带着空的 create{} 永远落不到正确的工作区，且会被误判成「一致」不重建。
  const wantCwd = desired.create?.cwd ?? null
  const haveCwd = current.create?.cwd ?? null
  return wantCwd === haveCwd
}

/**
 * 目标会话。
 *
 *   background（默认）→ { kind: 'new_once' }：第一次投递时新建专用会话，之后固定用它。
 *                       心跳的上下文不进主对话，主会话不会被 4.7 M 的历史拖累。
 *   main             → 最近活跃且空闲的会话，你能在聊天窗口里看见它醒来。
 *   new              → 每次新建（不推荐，一天 8 个）。
 *
 * 注意：main 模式下如果所有会话都在聊，退回「最新的那个」而不是返回 null——
 * 返回 null 会让任务根本不存在，心跳就永久停了。
 */
export function resolveTarget({ sessionsRoot, mode = 'background', workspaceDir = null }) {
  // 防御：sessionMode 是标量，但历史脏数据可能是 ['main']。
  // 不解包的话，数组 !== 'main' 会静默掉进 new_once 分支——用户以为选了主会话，
  // 实际还在后台会话里，而且没有任何报错。
  const picked = Array.isArray(mode) ? mode[0] : mode
  const normalized = String(picked ?? '').trim() || 'background'
  // 新建会话必须带 cwd：不带就会落到 dsh 的默认工作区，侧栏里冒出别的目录的会话
  const create = workspaceDir ? { cwd: workspaceDir } : {}
  if (normalized === 'new') return { kind: 'new', create }
  if (normalized !== 'main') return { kind: 'new_once', create }
  const idle = pickRecentSession({ sessionsRoot })
  if (idle) return { kind: 'session', sessionId: idle.sessionId }
  const newest = newestSession(sessionsRoot)
  return newest ? { kind: 'session', sessionId: newest } : null
}

/** 兜底：不管在不在聊，取 mtime 最新的会话。 */
export function newestSession(sessionsRoot) {
  if (!sessionsRoot || !existsSync(sessionsRoot)) return null
  let best = null
  for (const scope of listDirs(sessionsRoot)) {
    for (const dir of listDirs(scope)) {
      const file = join(dir, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      try {
        const mtime = statSync(file).mtimeMs
        if (!best || mtime > best.mtime) best = { id: dir.split('/').pop(), mtime }
      } catch {
        // 读不到就跳过
      }
    }
  }
  return best?.id ?? null
}
