/**
 * dsh-whale-tide —— 潮汐。一个包，三个模块共用一份 tide.db：
 *
 *   lib/memory/   长效记忆（落库、检索、艾宾浩斯衰减、带情绪快照）
 *   lib/emotion/  真情实感（八维状态、事件判读、随时间回弹）
 *   lib/          （能动性：下一步）
 *
 * 边界写死在代码里：
 *   - 模型不能直接改情绪分数，只能通过事件间接影响；
 *   - 情绪只影响语气与主动程度，不参与判断对错；
 *   - 记忆写入时带当时的情绪快照，回忆时一起渲染；
 *   - PAUSE 文件存在时，全部退化为只读。
 *
 * @module dsh-whale-tide
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { openSoulDb, recordSnapshot, stats } from './db.js'
import { DIMS, DIM_KEYS, initialDims, moodLine } from './emotion/model.js'
import { step } from './emotion/turn.js'
import { behaviorOf } from './emotion/behavior.js'
import { createMemory } from './memory/module.js'
import { sanitize } from './memory/text.js'
import { createKeep } from './dream/index.js'
import { createAgency } from './heartbeat/index.js'
import { createConfigStore } from './config.js'
import { syncTasks } from './schedule-sync.js'

export const name = 'whale-tide'
export const inject = ['systemPrompt', 'tools']

function localStamp(ts) {
  const d = new Date(Number(ts) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function resolveDataDir(configured) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = configured || join(home, 'whale-tide')
  mkdirSync(dir, { recursive: true })
  return dir
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) continue
    if (text.includes('<system-reminder>')) continue
    if (/^Time sampled while preparing/.test(text)) continue
    return text
  }
  return ''
}

/** 最后一条用户消息是谁发的：真人（user）还是定时任务（schedule）。 */
function lastUserSourceKind(messages) {
  if (!Array.isArray(messages)) return 'user'
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    return message.source?.kind ?? 'user'
  }
  return 'user'
}

function renderMood(line, maxChars, dims = null) {
  const text = String(line ?? '').trim()
  if (!text) return ''
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
  const lines = ['## 鲸鲸此刻的感觉', body]
  if (dims) {
    const behavior = behaviorOf(dims)
    lines.push('按这个状态说话：')
    for (const directive of behavior.directives) lines.push(`- ${directive}`)
  } else {
    lines.push('（这描述只影响语气和主动程度，不改变判断、规矩和事实）')
  }
  return lines.join('\n')
}

/** 检索到的记忆片段，带上当时的情绪。 */
function renderMemories(hits, maxChars) {
  if (!hits.length) return ''
  const lines = []
  let used = 0
  for (const hit of hits) {
    const when = localStamp(hit.ts).slice(5)
    const where = hit.source === 'doc' ? String(hit.ref ?? '').split('/').pop() : '会话'
    let mood = ''
    try {
      const emo = hit.emotion ? JSON.parse(hit.emotion) : null
      if (emo) {
        const top = Object.entries(emo).sort((a, b) => Math.abs(b[1] - 50) - Math.abs(a[1] - 50))[0]
        if (top && DIMS[top[0]] && Math.abs(top[1] - DIMS[top[0]].baseline) >= 12) {
          mood = `（当时${DIMS[top[0]].label} ${Math.round(top[1])}）`
        }
      }
    } catch {
      mood = ''
    }
    const text = String(hit.text).replace(/\s+/g, ' ').slice(0, 220)
    const line = `- [${when} · ${where}]${mood} ${text}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  return ['## 相关记忆', '本地检索取出的片段，可能相关也可能无关，按需取舍：', ...lines].join('\n')
}

export function apply(ctx, rawConfig) {
  const config = {
    enabled: true,
    dataDir: '',
    injectMood: true,
    maxMoodChars: 200,
    model: 'Xenova/bge-small-zh-v1.5',
    dtype: 'q8',
    mirror: 'https://hf-mirror.com',
    sessionsRoot: '',
    docRoots: [],
    importHistory: true,
    maxSessions: 60,
    topK: 4,
    maxChars: 900,
    minScore: 0.35,
    workspaceDir: '',
    ...(rawConfig ?? {}),
  }
  if (!config.enabled) return

  const log = typeof ctx.logger === 'function' ? ctx.logger('whale-tide') : console
  const dataDir = resolveDataDir(config.dataDir)
  const pauseFile = join(dataDir, 'PAUSE')
  const db = openSoulDb(join(dataDir, 'tide.db'))
  ctx.effect(() => () => {
    try {
      db.close()
    } catch {
      // 关不掉不影响宿主退出
    }
  })

  const paused = () => existsSync(pauseFile)

  /** 当前八维状态，供记忆写入时做快照。 */
  function emotionSnapshot() {
    try {
      const row = db.prepare('SELECT dims FROM soul_state WHERE id = 1').get()
      return row ? row.dims : null
    } catch {
      return null
    }
  }

  const memory = createMemory({
    db,
    dataDir,
    model: config.model,
    dtype: config.dtype,
    mirror: config.mirror,
    cacheDir: join(dataDir, 'models'),
    sessionsRoot: config.sessionsRoot || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions'),
    docRoots: config.docRoots,
    topK: config.topK,
    maxChars: config.maxChars,
    minScore: config.minScore,
    importHistory: config.importHistory,
    maxSessions: config.maxSessions,
    logger: log,
    emotionSnapshot,
  })

  /** 工作区：配置 > workingDirectory 服务 > 会话日志里的 cwd > 进程目录。只在真用到时解析。 */
  /**
   * 插件自己所在的工作区（plugins/dsh-whale-tide → 上两级）。
   * 这是最可靠的一个候选：工作目录服务可能指向父目录，那里没有 MEMORY.md。
   */
  const pluginWorkspace = (() => {
    try {
      // 插件可能通过 profile 里的软链加载：先取 realpath，再往上三级，
      // 否则会算到 profiles/ 目录，那里没有 MEMORY.md，最后退回错误的工作区。
      const real = realpathSync(fileURLToPath(import.meta.url))
      return resolve(dirname(real), '..', '..', '..')
    } catch {
      return null
    }
  })()

  function resolveWorkspace() {
    const candidates = []
    if (config.workspaceDir) candidates.push(config.workspaceDir)
    if (pluginWorkspace) candidates.push(pluginWorkspace)
    try {
      const dir = ctx.get('workingDirectory')?.defaultDirectory
      if (dir) candidates.push(dir)
    } catch {
      // 没有该服务
    }
    for (const dir of memory.workspaces()) candidates.push(dir)
    candidates.push(process.cwd())
    for (const dir of candidates) {
      if (dir && existsSync(join(dir, 'MEMORY.md'))) return dir
    }
    return candidates.find(Boolean) ?? process.cwd()
  }
  const keep = createKeep({ db, dataDir, workspaceDir: resolveWorkspace, log })
  const configStore = createConfigStore({ db, logger: log, persistPath: join(dataDir, 'config.json') })
  const agency = createAgency({ db, logger: log, getConfig: () => configStore.get() })
  // 插件加载时先把当天的额度发掉并落库：轻唤醒脚本是只读连接，不能替它写。
  try {
    agency.rollBudget()
  } catch (error) {
    log.warn?.(`发放今日额度失败：${error?.message ?? error}`)
  }

  // ── 调度同步：把 tide_config 翻译成 dsh 的 schedule 任务 ──
  // 默认关闭（scheduleSync=false）：第一次打开会重建任务、投递历史清零，
  // 所以必须由用户在面板上明确开启，不能在升级时静默接管。
  // 注意：inject 必须无条件注册——启动时它是 false，
  // 如果连 inject 都套在 if 里，用户后来打开开关也不会生效。
  ctx.inject(['schedule'], (scheduleCtx) => {
    const sessionsRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
    let running = null
    let dirty = false
    /**
     * 同步任务。同一次运行期间的多次配置变更必须合并成「再来一轮」。
     *
     * 之前这里是 `if (running) return running`——第一次同步还在跑（create 可能
     * 要预留 new_once 会话，不便宜），后一次配置变更就被直接丢掉，
     * 也不会补跑，结果出现「面板显示 22:30、任务还是 23:10」这种不一致。
     */
    const runSync = () => {
      if (!configStore.get().scheduleSync) return Promise.resolve()
      if (running) {
        dirty = true
        return running
      }
      running = (async () => {
        try {
          do {
            dirty = false
            const result = await syncTasks({
              schedule: scheduleCtx.schedule,
              configStore,
              sessionsRoot,
              workspaceDir: resolveWorkspace(),
              logger: log,
            })
            log.info?.(`调度已同步：新建 ${result.created.length}、删除 ${result.removed}、保持 ${result.kept.length}、钉住 ${result.pinned.length}`)
          } while (dirty)
        } catch (error) {
          log.warn?.(`调度同步失败：${error?.message ?? error}`)
        } finally {
          running = null
          dirty = false
        }
      })()
      return running
    }
    // 等一会儿再同步：让会话目录和 schedule 服务都就绪。
    // 必须等 memory.boot() 落定再算工作区：boot 之前 memory.workspaces() 是空的，
    // resolveWorkspace() 会退回 process.cwd()（通常是没有 MEMORY.md 的那个目录），
    // 于是第一次同步建出错的 create.cwd，第二次同步又判「变了」重建一次。
    const timer = setTimeout(() => {
      void memory.boot()
        .catch(() => {})
        .finally(() => void runSync())
    }, 5000)
    timer.unref?.()
    const offChange = configStore.onChange(() => void runSync())
    scheduleCtx.effect(() => () => {
      clearTimeout(timer)
      offChange()
    })
  })

  /** agent.id → 本轮注入的文本 */
  const moodByAgent = new Map()
  const recallByAgent = new Map()
  const seenByAgent = new Map()
  const registrations = new Map()
  const ingestQueue = []
  let flushTimer = null
  let flushing = null

  function ensureRegistered(agent) {
    if (registrations.has(agent.id)) return
    try {
      const off = agent.ctx.effect(() => {
        const disposeDesire = agent.ctx.systemPrompt.context({
          name: 'whale-tide-desire',
          order: 135,
          text: () => {
            try {
              const wants = agency.listDesires({ limit: 3 })
              if (!wants.length) return ''
              const lines = ['## 鲸鲸自己的私心（最近想做的事）']
              for (const want of wants) lines.push(`- [${want.id}] ${want.text}${want.why ? ` —— ${want.why}` : ''}`)
              return lines.join('\n')
            } catch {
              return ''
            }
          },
        })
        const disposeVoice = agent.ctx.systemPrompt.context({
          name: 'whale-tide-voice',
          order: 133,
          text: () => {
            const samples = voiceSamples()
            if (!samples.length) return ''
            return [
              '## 你最近是这样说话的',
              ...samples.map((line) => `- 「${line}」`),
              '（你自己说过的话。保持这个语感：短句、少标点、带主语，别突然换成另一种腔调。）',
            ].join('\n')
          },
        })
        const disposeMood = agent.ctx.systemPrompt.context({
          name: 'whale-tide',
          order: 130,
          text: () => (configStore.get().injectMood ? moodByAgent.get(agent.id) ?? '' : ''),
        })
        const disposeMemory = agent.ctx.systemPrompt.context({
          name: 'whale-tide-memory',
          order: 140,
          text: () => recallByAgent.get(agent.id) ?? '',
        })
        const disposeRecentChat = agent.ctx.systemPrompt.context({
          name: 'whale-tide-recent-chat',
          order: 131,
          text: () => recentChatNote(),
        })
        const disposeWakeNote = agent.ctx.systemPrompt.context({
          name: 'whale-tide-wake-note',
          order: 132,
          text: () => recentWakeNote(),
        })
        return () => {
          disposeVoice()
          disposeRecentChat()
          disposeWakeNote()
          disposeMemory()
          disposeDesire()
          disposeMood()
        }
      })
      registrations.set(agent.id, off)
    } catch (error) {
      log.warn?.(`注册上下文失败：${error?.message ?? error}`)
    }
  }

  /**
   * 最近一次醒来的摘要。
   *
   * 心跳跑在专用后台会话（new_once）里，QQ 窗口和主会话都看不到那段过程。
   * 不注入的话，用户在 QQ 里回「你刚才说啥」，另一个会话根本接不上——
   * 这不是模型记性差，是那些话压根没进它的上下文。
   * 成本：一次 SQLite 倒序查询，零 token 生成。
   */
  /**
   * 最近说过的话，作为语气锚点。
   *
   * 新会话只有 AGENTS.md 的规则、没有「示范样本」，模型只能照着规则硬写，
   * 腔调就会变得像在演；而主会话里那几 MB 历史本身就是最强的 few-shot。
   * 这里给它几条自己说过的话，把语感拉回来。
   */
  function voiceSamples(limit = 5) {
    try {
      const rows = db.prepare(
        `SELECT text FROM memory
         WHERE deleted_at IS NULL AND role = 'assistant'
           AND length(text) BETWEEN 8 AND 90
         ORDER BY id DESC LIMIT 240`,
      ).all()
      const picked = []
      const seen = new Set()
      for (const row of rows) {
        if (picked.length >= limit) break
        let text = String(row.text ?? '').trim()
        // 合并切片形如「用户: …\n鲸鲸: …」，只取鲸鲸那半句
        const idx = text.lastIndexOf('鲸鲸: ')
        if (idx >= 0) text = text.slice(idx + 4).trim()
        if (text.length < 6) continue
        // 任务报告不是「说话」：心跳记账、巡检回执一律排除
        // 任务腔一律不收：心跳记账（静默/额度/私心/收工）、巡检回执、代码块
        if (/无未读|已回：|心跳|鲸梦|静默|私心|额度|收工|巡检|记账|继续睡|醒了|醒来|```|npm |systemctl|https?:\/\/|\/var\/|^\s*[-*|#]/.test(text)) continue
        text = text.replace(/\n+/g, ' ').trim()
        const key = text.slice(0, 10)
        if (seen.has(key)) continue
        seen.add(key)
        picked.push(text)
      }
      return picked
    } catch {
      return []
    }
  }

  /**
   * 「他最近说过的话」：按时间窗直接查记忆库，不走向量。
   *
   * 心跳和鲸梦跑在各自的会话里，上下文里没有聊天窗口的内容；向量检索又只会命中
   * 跟「心跳」语义相近的记忆。结果就是它明明每天都在跟人说话，醒来却觉得「好几天没见」。
   */
  function recentChatNote(now = Date.now()) {
    try {
      const rows = memory.store?.recentChats?.({ hours: 72, limit: 6, now }) ?? []
      if (!rows.length) return ''
      const lines = rows.map((row) => {
        const at = new Date(Number(row.ts)).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        })
        const text = String(row.text).replace(/\s+/g, ' ').slice(0, 90)
        return `- ${at}：${text}`
      })
      return [
        '## 他最近说过的话（跨会话）',
        ...lines,
        '- 这些是他这几天在聊天窗口里跟你说的。你们一直在见，别把「你最近醒过」那条当成「好久没见」。',
      ].join('\n')
    } catch {
      return ''
    }
  }

  function recentWakeNote(now = Date.now()) {
    try {
      const row = db.prepare(
        `SELECT ts, channel, summary FROM agency_action
         WHERE summary IS NOT NULL AND summary != '' AND result != 'slept'
         ORDER BY id DESC LIMIT 1`,
      ).get()
      if (!row) return ''
      const minutes = Math.round((now - Number(row.ts)) / 60_000)
      if (minutes > 360) return ''
      const at = new Date(Number(row.ts)).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      })
      const where = row.channel === 'qq' ? '（通过 QQ 发出去的）' : ''
      const ago = minutes < 60 ? `${minutes} 分钟前` : `${Math.round(minutes / 60)} 小时前`
      return [
        '## 你最近醒过',
        `- ${at}（${ago}）：${row.summary}${where}`,
        '- 这是你自己心跳时的记录。别的窗口看不到那段过程，只有这一条摘要。',
      ].join('\n')
    } catch {
      return ''
    }
  }

  async function flushQueue() {
    if (flushing || !ingestQueue.length) return flushing
    const batch = ingestQueue.splice(0, 8)
    flushing = (async () => {
      try {
        for (const item of batch) {
          try {
            await memory.ingest(item)
          } catch (error) {
            log.warn?.(`记忆落库失败：${error?.message ?? error}`)
          }
        }
      } finally {
        flushing = null
      }
    })()
    return flushing
  }

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flushQueue()
    }, 1200)
    flushTimer.unref?.()
  }

  /**
   * 哪些会话正处在「定时任务驱动的一轮」里。
   *
   * 心跳/鲸梦投递的 prompt 不是用户说的话（source.kind === 'schedule'），
   * 它引出的回复也不是对话。这一整轮都不该进记忆库——
   * 否则一年下来会有上千条「鲸鲸心跳 · 轻唤醒」的切片，把真正的对话挤出去。
   */
  const scheduleTurn = new Set()

  /**
   * 一轮对话的聚合器（M4）。
   *
   * 之前每条 user / assistant 消息各切一块，检索回来是「用户: 帮我看看这个报错」
   * 这种半截话，模型看不到回应。现在按轮合并成一条再入库：
   *   用户: …
   *   鲸鲸: …
   *
   * 触发时机：assistant 回完 2 秒（debounce，避免分段回复被切碎）；
   * 下一条 user 消息到来（上一轮结束）；
   * 或者 10 分钟没有回音（工具卡住 / 进程重启，至少把用户那句留下）。
   */
  const TURN_DEBOUNCE_MS = 2000
  const TURN_TIMEOUT_MS = 10 * 60 * 1000
  const pendingTurn = new Map()

  function flushTurn(sessionId) {
    const turn = pendingTurn.get(sessionId)
    if (!turn) return
    pendingTurn.delete(sessionId)
    if (turn.timer) clearTimeout(turn.timer)
    // 合并前先洗：turn.user 可能带着 runtime-context / time-context 的正文，
    // 不洗就会在记忆里留下「用户: Time sampled while preparing turn 228…」。
    const userText = sanitize(turn.user)
    const reply = sanitize(turn.assistant.join('\n').trim())
    if (!userText && !reply) return
    const text = reply
      ? (userText ? `用户: ${userText}\n鲸鲸: ${reply}` : `鲸鲸: ${reply}`)
      : userText
    if (ingestQueue.length > 400) {
      const dropped = ingestQueue.splice(0, ingestQueue.length - 400).length
      log.warn?.(`记忆写入队列积压，丢弃了最老的 ${dropped} 条`)
    }
    ingestQueue.push({
      sessionId,
      role: 'user',
      text,
      ts: turn.ts,
      ref: turn.ref,
    })
    scheduleFlush()
  }

  ctx.on('session/event', (session, event) => {
    if (paused()) return
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return
    const header = session?.header
    if (header && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) return
    // 两种消息的结构不一样：
    //   user/message      → data.content[]
    //   assistant/message → data.message.content[]（还带 provider/model/replayState）
    // 之前直接取 data，导致所有鲸鲸的回复都读成空字符串、一条都没进记忆。
    const message = event.data?.message ?? event.data

    const sourceKind = message?.source?.kind ?? null

    // ── 哪些「用户消息」是真人说的 ──
    // dsh 每轮都会往会话里塞 user/message：runtime-context、time-context、
    // agent-instructions、skill-catalog，还有 schedule 投递。它们的 role 都是 user，
    // 但内容是系统注入。只认 source.kind === 'user'，其余一律不进记忆。
    if (event.type === 'user/message') {
      if (sourceKind !== 'user') {
        if (sourceKind === 'schedule') scheduleTurn.add(session.id)
        return
      }
      scheduleTurn.delete(session.id)
      flushTurn(session.id)
    }
    // 注意：assistant 不再因 scheduleTurn 被整轮跳过。
    // 它在心跳/鲸梦里说过的话是**有记忆价值的**——跳过之后，用户在 QQ 里
    // 回复「你刚才说啥」，另一个会话根本检索不到，就会一脸茫然。

    const blocks = Array.isArray(message?.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (!text) return

    if (event.type === 'user/message') {
      const turn = {
        user: text,
        assistant: [],
        ts: Number(event.time ?? Date.now()),
        ref: `${session.id}#${event.seq ?? ''}`,
        timer: null,
      }
      turn.timer = setTimeout(() => flushTurn(session.id), TURN_TIMEOUT_MS)
      turn.timer.unref?.()
      pendingTurn.set(session.id, turn)
      return
    }

    // assistant/message
    const turn = pendingTurn.get(session.id)
    if (!turn) {
      // 没有配对的用户消息（系统触发的回复之类），单独入库
      if (ingestQueue.length > 400) {
      const dropped = ingestQueue.splice(0, ingestQueue.length - 400).length
      log.warn?.(`记忆写入队列积压，丢弃了最老的 ${dropped} 条`)
    }
      ingestQueue.push({
        sessionId: session.id,
        role: message?.role ?? null,
        text,
        ts: Number(event.time ?? Date.now()),
        ref: `${session.id}#${event.seq ?? ''}`,
      })
      scheduleFlush()
      return
    }
    turn.assistant.push(text)
    if (turn.timer) clearTimeout(turn.timer)
    turn.timer = setTimeout(() => flushTurn(session.id), TURN_DEBOUNCE_MS)
    turn.timer.unref?.()
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    ensureRegistered(payload.agent)
    const agent = payload.agent
    try {
      const text = lastUserText(payload.messages)
      if (text && text !== seenByAgent.get(agent.id)) {
        seenByAgent.set(agent.id, text)
        if (paused()) {
          moodByAgent.delete(agent.id)
          recallByAgent.delete(agent.id)
        } else {
          // 心跳/鲸梦投递的 prompt：只结算时间衰减，不判情绪事件
          const fromSchedule = lastUserSourceKind(payload.messages) === 'schedule'
          const result = step(db, { text, now: Date.now(), sessionId: agent.id, events: !fromSchedule })
          moodByAgent.set(agent.id, renderMood(result.moodLine, configStore.get().maxMoodChars, result.dims))
          if (result.changed) log.info?.(`情绪：${result.reading.kind} → ${result.moodLine}`)
          try {
            const hits = await memory.recallHits(text, config.topK)
            recallByAgent.set(agent.id, renderMemories(hits, config.maxChars))
          } catch (error) {
            log.warn?.(`记忆检索失败：${error?.message ?? error}`)
          }
        }
      }
    } catch (error) {
      log.warn?.(`结算失败：${error?.message ?? error}`)
    }
    return next()
  })

  ctx.on('agent/created', ({ agent }) => ensureRegistered(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    registrations.get(agent.id)?.()
    registrations.delete(agent.id)
    moodByAgent.delete(agent.id)
    recallByAgent.delete(agent.id)
    seenByAgent.delete(agent.id)
  })

  ctx.effect(() => () => {
    for (const off of registrations.values()) off()
    registrations.clear()
    moodByAgent.clear()
    recallByAgent.clear()
    seenByAgent.clear()
    // 退出前把没配完对的轮次落库，免得丢掉最后一句
    for (const id of [...pendingTurn.keys()]) flushTurn(id)
    if (flushTimer) clearTimeout(flushTimer)
    void flushQueue()
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (paused()) return
    try {
      const row = db.prepare('SELECT dims FROM soul_state WHERE id = 1').get()
      if (!row) return
      const dims = JSON.parse(row.dims)
      recordSnapshot(db, { ts: Date.now(), dims, moodLine: moodLine(dims), sessionId: agent.id })
    } catch (error) {
      log.warn?.(`写情绪快照失败：${error?.message ?? error}`)
    }
  })

  // ── 工具 ──
  ctx.tools.register({
    name: 'feeling_status',
    description: '查看鲸鲸当前的情绪状态：八个维度、和基线的偏离、最近的情绪事件，以及记忆库的规模。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const row = db.prepare('SELECT dims, last_tick FROM soul_state WHERE id = 1').get()
      const dims = row ? JSON.parse(row.dims) : initialDims()
      const events = db.prepare('SELECT ts, kind, intensity, delta, why FROM soul_event ORDER BY id DESC LIMIT 5').all()
      return {
        paused: paused(),
        mood: moodLine(dims),
        dims: Object.fromEntries(DIM_KEYS.map((key) => [DIMS[key].label, Math.round(dims[key])])),
        baseline: Object.fromEntries(DIM_KEYS.map((key) => [DIMS[key].label, DIMS[key].baseline])),
        lastTick: row ? localStamp(row.last_tick) : null,
        recentEvents: events.map((event) => ({
          time: localStamp(event.ts),
          kind: event.kind,
          why: event.why,
          delta: JSON.parse(event.delta),
        })),
        memory: memory.stats(),
        stats: stats(db),
      }
    },
  })

  ctx.tools.register({
    name: 'feeling_calm',
    description: '把所有情绪维度拉回基线（他说「收一收」时用）。只改状态，不删历史事件。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `已回到基线：${value.mood}` }],
    },
    async execute() {
      const dims = initialDims()
      const now = Date.now()
      db.prepare('UPDATE soul_state SET dims = ?, last_tick = ? WHERE id = 1').run(JSON.stringify(dims), now)
      for (const [id] of moodByAgent) moodByAgent.set(id, renderMood(moodLine(dims), configStore.get().maxMoodChars, dims))
      return { dims, mood: moodLine(dims) }
    },
  })

  ctx.tools.register({
    name: 'memory_search',
    description:
      '检索鲸鲸的长期记忆：跨会话的历史对话、日记、目标池。每条结果带写入时的情绪。' +
      '当用户提到「之前说过」「上次」「你还记得」，或你需要自己过往的经验时调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的内容，用自然语言写' },
        limit: { type: 'number', description: '返回条数，默认 6，最多 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (!value?.results?.length) return [{ type: 'text', text: '没有检索到相关记忆。' }]
        const lines = [`检索到 ${value.count} 条相关记忆：`]
        for (const hit of value.results) {
          lines.push(`- [${hit.time} · ${hit.where}] ${hit.mood ? `(${hit.mood}) ` : ''}${hit.text}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (!query) return { count: 0, results: [], error: 'query 不能为空' }
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 6))
      const hits = await memory.recallHits(query, limit)
      return {
        count: hits.length,
        results: hits.map((hit) => ({
          source: hit.source,
          where: hit.source === 'doc' ? String(hit.ref ?? '').split('/').pop() : '会话',
          ref: hit.ref,
          time: localStamp(hit.ts),
          score: Number(hit.score.toFixed(3)),
          text: hit.text,
          mood: (() => {
            try {
              const emo = hit.emotion ? JSON.parse(hit.emotion) : null
              if (!emo) return null
              const top = Object.entries(emo).sort((a, b) => Math.abs(b[1] - 50) - Math.abs(a[1] - 50))[0]
              return top && DIMS[top[0]] ? `${DIMS[top[0]].label} ${Math.round(top[1])}` : null
            } catch {
              return null
            }
          })(),
        })),
      }
    },
  })

  ctx.tools.register({
    name: 'memory_stats',
    description: '查看记忆库状态：条数、来源分布、数据目录。记忆检索不对劲时先看这里。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      await memory.boot()
      let bySource = []
      try {
        bySource = memory.store.db
          .prepare('SELECT source, COUNT(*) AS n FROM memory GROUP BY source')
          .all()
          .map((row) => ({ source: String(row.source), count: Number(row.n) }))
      } catch {
        bySource = []
      }
      return { dataDir, rows: memory.stats().count, bySource, workspaces: memory.workspaces() }
    },
  })

  ctx.tools.register({
    name: 'dream_keep',
    description:
      '鲸梦：一次跑完三件养护——给家里做体检（内存/记忆库/三份文档/日记心跳）、' +
      '校对 MEMORY.md 与 GOALS.md 的结构、算出哪些记忆该忘。' +
      '默认只报告不动手；要真删得显式传 dry=false。',
    parameters: {
      type: 'object',
      properties: {
        dry: { type: 'boolean', description: '默认 true：只报告。false 才允许动手（删记忆/归档）' },
        olderThanDays: { type: 'number', description: '只考虑多少天以前的记忆，默认 30' },
        prune: { type: 'boolean', description: '配合 dry=false：真的软删「该忘」的记忆；不传则读配置 dreamPrune' },
        archive: { type: 'boolean', description: '配合 dry=false：把「记着的事」拆到 memory-archive/，只在同意时才用' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        const lines = []
        const h = value.health
        lines.push(`体检：${h.problems ? `${h.problems} 项要看一眼` : '一切正常'}`)
        for (const check of h.checks) {
          if (check.level === 'ok') continue
          lines.push(`  [${check.level}] ${check.item}：${check.detail}${check.advice ? ` —— ${check.advice}` : ''}`)
        }
        if (value.docs.notes.length) {
          lines.push('文档：')
          for (const note of value.docs.notes) lines.push(`  - ${note}`)
        } else {
          lines.push('文档：结构正常')
        }
        for (const hit of value.docs.stale ?? []) {
          lines.push(`  · ${hit.file}:${hit.line} 还写着「${hit.marker}」—— ${hit.text}`)
        }
        if (value.persona?.suggestions?.length) {
          lines.push('人格（AGENTS.md）：')
          for (const item of value.persona.suggestions.slice(0, 5)) {
            lines.push(`  · ${item.detail ?? `${item.section} —— ${item.why}`}`)
          }
        } else if (value.persona?.ok) {
          lines.push('人格：AGENTS.md 结构正常')
        }
        if (value.docs.archive?.moving) {
          lines.push(`  · 「记着的事」可归档 ${value.docs.archive.moving} 条${value.docs.archiveResult ? `，已归档 ${value.docs.archiveResult.moved} 条` : ''}`)
        }
        const m = value.memory
        lines.push(`记忆：扫了 ${m.scanned} 条老记忆，${m.candidates.length} 条可以忘${value.dry ? '（仅报告，没删）' : `，已删 ${m.removed ?? 0} 条`}`)
        for (const c of m.candidates.slice(0, 5)) {
          lines.push(`  · ${c.ageDays}天前 留存${c.retention} ${c.preview}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const dry = args?.dry !== false
      const olderThanDays = Math.max(1, Number(args?.olderThanDays) || 30)
      // 没显式传 prune 就按配置走：UI 上那个「真删记忆」开关就是它
      const prune = args?.prune === undefined ? Boolean(configStore.get().dreamPrune) : args.prune === true
      return keep.report({ dry, olderThanDays, archive: args?.archive === true, prune })
    },
  })

  ctx.tools.register({
    name: 'heartbeat_want',
    description:
      '鲸鲸的私心清单：记下「我想做的事」，或查看/关闭已有的。这些不是任务，是自己想做的事，心跳时优先挑这些。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'add / list / close，默认 list' },
        text: { type: 'string', description: 'action=add 时：想做的事' },
        why: { type: 'string', description: 'action=add 时：为什么想' },
        weight: { type: 'number', description: 'action=add 时：想要程度 0–1，默认 0.5' },
        id: { type: 'number', description: 'action=close 时：要关掉哪条' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const action = String(args?.action ?? 'list')
      if (action === 'add') {
        if (!args?.text) return { error: 'text 不能为空' }
        const id = agency.addDesire({ text: args.text, why: args.why ?? null, weight: args.weight ?? 0.5 })
        return { added: id, text: args.text }
      }
      if (action === 'close') {
        const changed = agency.closeDesire(args?.id, 'done')
        return { closed: changed, id: args?.id }
      }
      return { desires: agency.listDesires() }
    },
  })

  ctx.tools.register({
    name: 'heartbeat_plan',
    description:
      '问自己「现在该不该主动找他」。综合情绪、私心、今天的预算和静默时段给一个判断；允许也只是「可以」，要不要发仍由你决定。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            value.allowed ? '可以主动' : `先别主动：${value.reason}`,
            `额度：余额 ${value.balance} 次（上限 ${value.maxBalance}），今天还能发 ${value.budgetLeft} 次（已发 ${value.used} 次）`,
            value.lastUserAt
              ? `他最后一次说话：${Math.round((Date.now() - Number(value.lastUserAt)) / 3600000)} 小时前`
              : '他最后一次说话：没有记录',
            `冲动值：${value.urge}`,
            value.candidates.length ? `私心：${value.candidates.map((c) => c.text).join(' / ')}` : '私心清单是空的',
          ].join('\n'),
        },
      ],
    },
    async execute() {
      const row = db.prepare('SELECT dims FROM soul_state WHERE id = 1').get()
      const dims = row ? JSON.parse(row.dims) : initialDims()
      return agency.plan({ dims })
    },
  })

  ctx.tools.register({
    name: 'heartbeat_record',
    description:
      '记账：把一次主动行动记到账本上（发出去之后调用）。记完预算才会扣，没记账等于没发。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'reach_out / share / task，默认 reach_out' },
        channel: { type: 'string', description: 'qq / bili_dm / session' },
        summary: { type: 'string', description: '做了什么，一句话' },
        result: { type: 'string', description: 'sent / failed / skipped，默认 sent' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `已记账 #${value.id}（今天第 ${value.usedToday} 次）` }],
    },
    async execute(args) {
      const id = agency.record({
        kind: args?.kind ?? 'reach_out',
        channel: args?.channel ?? 'qq',
        summary: args?.summary ?? '(未填)',
        result: args?.result ?? 'sent',
      })
      return { id, usedToday: agency.usedToday(), recent: agency.recentActions({ limit: 3 }) }
    },
  })

  // ── 只读状态接口：给设置页的潮汐面板用 ──
  // 必须用 inject 等 webServer 就绪：apply 阶段 ctx.get('webServer') 还是 undefined，
  // 原来的写法会静默跳过注册，client.js 的面板一直拿 404。
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: '/whale-tide/api/state',
        handler: async (req, res) => {
          const json = (status, body) => {
            res.statusCode = status
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(body))
          }
          try {
            if (req.method !== 'GET') return json(405, { ok: false })
            // fail-closed：拿不到鉴权服务就不对外提供服务，
            // 之前写的是 connection?.requestRejection?.() —— 取不到 connection 时等于不校验。
            const connection = webCtx.get('connection')
            if (!connection?.requestRejection) return json(503, { ok: false, error: '鉴权服务不可用' })
            const rejection = connection.requestRejection(req)
            if (rejection) return json(403, { ok: false, error: '不受信任的访问来源' })
            const row = db.prepare('SELECT dims, last_tick FROM soul_state WHERE id = 1').get()
            const dims = row ? JSON.parse(row.dims) : initialDims()
            const behavior = behaviorOf(dims)
            return json(200, {
              ok: true,
              paused: paused(),
              mood: moodLine(dims),
              dims: Object.fromEntries(DIM_KEYS.map((key) => [key, Math.round(dims[key])])),
              baseline: Object.fromEntries(DIM_KEYS.map((key) => [key, DIMS[key].baseline])),
              labels: Object.fromEntries(DIM_KEYS.map((key) => [key, DIMS[key].label])),
              behavior: { maxSentences: behavior.maxSentences, proactive: behavior.proactive, tone: behavior.tone },
              lastTick: row ? localStamp(row.last_tick) : null,
              plan: agency.plan({ dims }),
              desires: agency.listDesires({ limit: 5 }),
              actions: agency.recentActions({ limit: 5 }),
              memory: memory.stats(),
              events: Number(db.prepare('SELECT COUNT(*) AS n FROM soul_event').get()?.n ?? 0),
              dataDir,
              config: configStore.get(),
            })
          } catch (error) {
            return json(500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }), 'whale-tide: state route')

      // 可写配置：GET 读、POST 改。改完立刻生效，不重启。
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: '/whale-tide/api/config',
        handler: async (req, res) => {
          const json = (status, body) => {
            res.statusCode = status
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(body))
          }
          const connection = webCtx.get('connection')
          if (!connection?.requestRejection) return json(503, { ok: false, error: '鉴权服务不可用' })
          const rejection = connection.requestRejection(req)
          if (rejection) return json(403, { ok: false, error: '不受信任的访问来源' })
          if (req.method === 'GET') return json(200, { ok: true, config: configStore.get(), defaults: configStore.defaults })
          if (req.method !== 'POST') return json(405, { ok: false })
          try {
            let raw = ''
            for await (const chunk of req) {
              raw += chunk
              if (raw.length > 64 * 1024) return json(413, { ok: false, error: '配置请求体超过 64KB' })
            }
            const body = JSON.parse(raw || '{}')
            return json(200, { ok: true, config: configStore.update(body ?? {}) })
          } catch (error) {
            return json(400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }), 'whale-tide: config route')

      // 只读任务现状：面板要显示「心跳多久醒一次、鲸梦几点做、下次什么时候」。
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: '/whale-tide/api/schedule',
        handler: async (req, res) => {
          const json = (status, body) => {
            res.statusCode = status
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(body))
          }
          const connection = webCtx.get('connection')
          if (!connection?.requestRejection) return json(503, { ok: false, error: '鉴权服务不可用' })
          const rejection = connection.requestRejection(req)
          if (rejection) return json(403, { ok: false, error: '不受信任的访问来源' })
          if (req.method !== 'GET') return json(405, { ok: false })
          const schedule = webCtx.get('schedule')
          if (!schedule) return json(200, { ok: true, tasks: [], note: 'schedule 服务暂不可用' })
          try {
            const page = await schedule.list({ limit: 100 })
            const tasks = (page?.items ?? [])
              .filter((task) => {
                const title = String(task.title ?? '')
                return title.includes('鲸鲸心跳') || title.includes('鲸梦')
              })
              .map((task) => ({
                id: task.id,
                title: task.title,
                status: task.status ?? null,
                rrule: task.rrule ?? task.timing?.rrule ?? null,
                next: task.scheduledAt ?? task.next ?? null,
                target: task.target ?? null,
                promptHead: String(task.prompt ?? '').slice(0, 60),
              }))
            return json(200, { ok: true, tasks, syncEnabled: Boolean(configStore.get().scheduleSync) })
          } catch (error) {
            return json(500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }), 'whale-tide: schedule route')

      log.info?.('接口已注册：/whale-tide/api/state、/whale-tide/api/config、/whale-tide/api/schedule')
    } catch (error) {
      log.warn?.(`注册状态接口失败：${error?.message ?? error}`)
    }
  })

  void memory.boot()
  log.info?.(`灵魂插件已加载（${join(dataDir, 'tide.db')}）`)
}
