/**
 * S2：配置 → schedule 任务。
 *
 * 关键不变量：
 *   - rrule 变了才重建任务，没变就不动（不重置投递历史）
 *   - wakeEnabled=false 时删掉心跳任务
 *   - 目标会话避开「最近 10 分钟还在聊」的那个
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  rruleEvery, rruleDaily, pickRecentSession, syncTasks,
  WAKE_TITLE, DREAM_TITLE, buildWakePrompt, buildDreamPrompt,
} from '../lib/schedule-sync.js'

function fakeSchedule() {
  const tasks = []
  let seq = 0
  return {
    tasks,
    async list() { return { items: tasks.map((t) => ({ ...t })) } },
    async create(payload) {
      seq += 1
      // 真实存储把 rrule 提成顶层字段（不是 timing.rrule），fake 也照做，
      // 否则测不出「读错字段导致每次重建」这类 bug。
      const task = { id: `task-${seq}`, status: 'active', ...payload, rrule: payload.timing?.rrule ?? null }
      tasks.push(task)
      return task
    },
    async edit(request) {
      if (request.action === 'delete') {
        const index = tasks.findIndex((t) => t.id === request.id)
        if (index >= 0) tasks.splice(index, 1)
      }
      return { ok: true }
    },
  }
}

function fakeConfig(values) {
  // 默认按 main 模式跑（另有专门的 background 用例）
  const cfg = { wakeEnabled: true, wakeEveryMinutes: 180, dreamAt: '22:30', sessionMode: 'main', ...values }
  return { get: () => cfg }
}

/** 造一个「空闲」会话目录：mtime 推到 1 小时前 */
function makeSession(root, scopeName, sessionId, ageMs) {
  const dir = join(root, scopeName, sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, 'x')
  const when = (Date.now() - ageMs) / 1000
  utimesSync(file, when, when)
  return sessionId
}

test('rruleEvery 跳过静默小时（默认 23–8）', () => {
  const r = rruleEvery(180)
  // 180 分钟 = 0/3/6/9/12/15/18/21 点，默认静默 23–8 过滤后剩 9/12/15/18/21
  assert.match(r, /^DTSTART;TZID=Asia\/Shanghai:20260101T000000\nRRULE:FREQ=DAILY;BYHOUR=9,12,15,18,21;BYMINUTE=0$/)
})

test('rruleEvery 在间隔无法用 BYHOUR 精确表达时退回 MINUTELY', () => {
  // 90 分钟的触发点会在 :00 和 :30 混着出现，BYHOUR+BYMINUTE 会多出不该有的时刻
  const r = rruleEvery(90, { quietFrom: 23, quietTo: 18 })
  assert.match(r, /RRULE:FREQ=MINUTELY;INTERVAL=90$/)
})

test('跨天同步时 rrule 不变（不再每天重建任务）', () => {
  const day1 = rruleEvery(120)
  const day2 = rruleDaily('22:30')
  const day3 = rruleDaily('22:30')
  assert.equal(day1, rruleEvery(120), '心跳 rule 不应随日期变')
  assert.equal(day2, day3, '鲸梦 rule 不应随日期变')
  assert.match(day1, /^DTSTART;TZID=Asia\/Shanghai:20260101T000000/)
})

test('rruleDaily 生成 DAILY 规则，非法时间抛错', () => {
  const r = rruleDaily('22:30', new Date(2026, 10, 13, 9, 0, 0))
  assert.match(r, /RRULE:FREQ=DAILY;BYHOUR=22;BYMINUTE=30/)
  assert.throws(() => rruleDaily('25:00'), /时间格式/)
})

test('pickRecentSession 跳过正在聊的会话', () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sess-'))
  try {
    const busy = makeSession(root, '--ws-a--', 'session-busy', 60 * 1000)      // 1 分钟前
    const idle = makeSession(root, '--ws-a--', 'session-idle', 90 * 60 * 1000)  // 90 分钟前
    const picked = pickRecentSession({ sessionsRoot: root })
    assert.ok(picked, '应该挑到一个')
    assert.equal(picked.sessionId, idle, '跳过刚说过话的那个')
    assert.notEqual(picked.sessionId, busy)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('全都在聊的时候返回 null（调用方去新建）', () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sess2-'))
  try {
    makeSession(root, '--ws--', 's1', 2 * 60 * 1000)
    makeSession(root, '--ws--', 's2', 5 * 60 * 1000)
    assert.equal(pickRecentSession({ sessionsRoot: root }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('首次同步会创建两个任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sync-'))
  try {
    makeSession(root, '--ws--', 'session-idle', 2 * 60 * 60 * 1000)
    const schedule = fakeSchedule()
    const result = await syncTasks({
      schedule,
      configStore: fakeConfig(),
      sessionsRoot: root,
      logger: { info() {}, warn() {} },
    })
    assert.equal(schedule.tasks.length, 2)
    assert.deepEqual(result.created.sort(), [DREAM_TITLE, WAKE_TITLE].sort())
    const wake = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    assert.equal(wake.target.sessionId, 'session-idle')
    assert.match(wake.prompt, /tick\.mjs/)
    assert.match(schedule.tasks.find((t) => t.title === DREAM_TITLE).prompt, /dream_keep/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rrule 没变就不重建（保留投递历史）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sync2-'))
  try {
    makeSession(root, '--ws--', 'session-idle', 2 * 60 * 60 * 1000)
    const schedule = fakeSchedule()
    const now = new Date(2026, 10, 13, 9, 0, 0)
    const deps = { schedule, configStore: fakeConfig(), sessionsRoot: root, logger: { info() {}, warn() {} }, now }
    await syncTasks(deps)
    const idsBefore = schedule.tasks.map((t) => t.id)
    const again = await syncTasks(deps)
    assert.deepEqual(schedule.tasks.map((t) => t.id), idsBefore, '任务 id 不该变')
    assert.equal(again.created.length, 0)
    assert.equal(again.kept.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('改间隔会重建心跳任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sync3-'))
  try {
    makeSession(root, '--ws--', 'session-idle', 2 * 60 * 60 * 1000)
    const schedule = fakeSchedule()
    const now = new Date(2026, 10, 13, 9, 0, 0)
    await syncTasks({ schedule, configStore: fakeConfig(), sessionsRoot: root, logger: { info() {}, warn() {} }, now })
    const before = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    await syncTasks({
      schedule,
      configStore: fakeConfig({ wakeEveryMinutes: 60 }),
      sessionsRoot: root,
      logger: { info() {}, warn() {} },
      now,
    })
    const after = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    assert.notEqual(after.id, before.id, '应该删旧建新')
    // 60 分钟在默认静默 23–8 下：8 点到 22 点整点
    assert.match(after.timing.rrule, /BYHOUR=8,9,10,11,12,13,14,15,16,17,18,19,20,21,22/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('wakeEnabled=false 会删掉心跳任务，但保留鲸梦', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sync4-'))
  try {
    makeSession(root, '--ws--', 'session-idle', 2 * 60 * 60 * 1000)
    const schedule = fakeSchedule()
    const now = new Date(2026, 10, 13, 9, 0, 0)
    await syncTasks({ schedule, configStore: fakeConfig(), sessionsRoot: root, logger: { info() {}, warn() {} }, now })
    await syncTasks({
      schedule,
      configStore: fakeConfig({ wakeEnabled: false }),
      sessionsRoot: root,
      logger: { info() {}, warn() {} },
      now,
    })
    assert.equal(schedule.tasks.filter((t) => t.title.startsWith('鲸鲸心跳')).length, 0)
    assert.equal(schedule.tasks.filter((t) => t.title.startsWith('鲸梦')).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('模板里不出现写死的时间、次数和设备', () => {
  const wake = buildWakePrompt({})
  const dream = buildDreamPrompt({})
  assert.ok(!/\d{2}:\d{2}/.test(wake), '心跳 prompt 不该写死时刻')
  assert.ok(!/\d+\s*次/.test(wake), '心跳 prompt 不该写死次数')
  assert.match(wake, /tide_config|tick\.mjs/)
  assert.match(dream, /dreamTasks/)
})

test('提示词按配置填路径和通知方式（P1-6）', () => {
  const wake = buildWakePrompt({ workspaceDir: '/srv/ws', notifyHint: 'node notify.mjs "内容"' })
  assert.match(wake, /在 \/srv\/ws 下/)
  assert.match(wake, /node notify\.mjs/)
  const dream = buildDreamPrompt({ workspaceDir: '/srv/ws', reportTo: 'c2c:ABC', goodnight: true })
  assert.match(dream, /在 \/srv\/ws 下/)
  assert.match(dream, /c2c:ABC/)
  // 晚安是这台机器的习惯，插件默认不该写进流程
  assert.ok(!/晚安/.test(buildDreamPrompt({ workspaceDir: '/srv/ws' })), '默认不该有晚安步骤')
  // 留空时不出现本机路径
  assert.ok(!/var\/lib\/dsh/.test(buildWakePrompt({})), '不该带上本机路径')
})

test('prompt 变了也会重建任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sync8-'))
  try {
    makeSession(root, '--ws--', 'session-idle', 2 * 60 * 60 * 1000)
    const schedule = fakeSchedule()
    const now = new Date(2026, 10, 17, 9, 0, 0)
    const deps = { schedule, configStore: fakeConfig(), sessionsRoot: root, logger: { info() {}, warn() {} }, now }
    await syncTasks(deps)
    const before = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    await syncTasks({ ...deps, configStore: fakeConfig({ notifyHint: 'node notify.mjs "内容"' }) })
    const after = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    assert.notEqual(after.id, before.id, '通知方式变了应重建')
    assert.match(after.prompt, /node notify\.mjs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('background 模式投到专用后台会话（new_once），不碰主对话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sync5-'))
  try {
    makeSession(root, '--ws--', 'session-main', 90 * 60 * 1000)
    const schedule = fakeSchedule()
    await syncTasks({
      schedule,
      configStore: fakeConfig({ sessionMode: 'background' }),
      sessionsRoot: root,
      logger: { info() {}, warn() {} },
    })
    const wake = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    assert.equal(wake.target.kind, 'new_once')
    assert.equal(wake.target.sessionId, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('main 模式下全都在聊，退回最新会话而不是不建任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sync6-'))
  try {
    // 两个都在 10 分钟内说过话：没有 idle 会话可选
    makeSession(root, '--ws--', 's-old', 8 * 60 * 1000)
    makeSession(root, '--ws--', 's-newest', 1 * 60 * 1000)
    const schedule = fakeSchedule()
    await syncTasks({
      schedule,
      configStore: fakeConfig({ sessionMode: 'main' }),
      sessionsRoot: root,
      logger: { info() {}, warn() {} },
    })
    const wake = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    assert.equal(wake.target.sessionId, 's-newest', '都在聊时也要建任务，不能返回 null')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveTarget 收到数组也能解包（旧脏数据）', async () => {
  const { resolveTarget } = await import('../lib/schedule-sync.js')
  // 数组不会被当成 new_once：main 应该走 session 分支
  const target = resolveTarget({ sessionsRoot: '/nonexistent', mode: ['main'] })
  // 没有会话目录时返回 null（main 分支拿不到会话），关键是不能静默变 new_once
  assert.notEqual(target?.kind, 'new_once')
})

test('已钉成 session 的心跳任务，background 模式再同步也不重建', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-sync7-'))
  try {
    const schedule = fakeSchedule()
    const now = new Date(2026, 10, 14, 9, 0, 0)
    const deps = {
      schedule,
      configStore: fakeConfig({ sessionMode: 'background' }),
      sessionsRoot: root,
      logger: { info() {}, warn() {} },
      now,
    }
    await syncTasks(deps)
    const wake = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    const idBefore = wake.id
    // 模拟一次投递之后被钉到真实会话上（pinDeliveredSession 的产物）
    wake.target = { kind: 'session', sessionId: 'session-pinned' }

    const again = await syncTasks(deps)
    const after = schedule.tasks.find((t) => t.title === WAKE_TITLE)
    assert.equal(after.id, idBefore, '钉住的 session 不该被当成不一致而重建')
    assert.deepEqual(after.target, { kind: 'session', sessionId: 'session-pinned' })
    assert.equal(again.created.length, 0)
    assert.equal(again.kept.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
