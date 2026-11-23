/**
 * M5：定时任务投递的消息只结算衰减，不判情绪事件。
 *
 * 之前心跳 prompt 里的「失败」「过期」「不对」会被 classify 当成人说的，
 * 造成情绪被自己的调度指令推着走。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openSoulDb } from '../lib/db.js'
import { step } from '../lib/emotion/turn.js'
import { initialDims, DIMS } from '../lib/emotion/model.js'

const HOUR = 3_600_000

test('events=false：只衰减，不记事件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-evt-'))
  const db = openSoulDb(join(dir, 'tide.db'))
  try {
    const t0 = 1_800_000_000_000
    // 先制造一个明显的情绪偏离
    const first = step(db, { text: '你滚', now: t0 })
    assert.equal(first.reading.kind, 'conflict')
    const angerAfter = first.dims.anger
    assert.ok(angerAfter > DIMS.anger.baseline, `anger=${angerAfter}`)

    const eventsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM soul_event').get().n)

    // 模拟心跳投递：内容里有负面词，但 events=false
    const second = step(db, {
      text: '鲸梦巡检失败，记忆过期了，这个不对',
      now: t0 + HOUR,
      events: false,
    })
    assert.equal(second.reading.kind, 'none', '不判事件')
    assert.equal(second.changed, false, '没有分数变化')

    const eventsAfter = Number(db.prepare('SELECT COUNT(*) AS n FROM soul_event').get().n)
    assert.equal(eventsAfter, eventsBefore, '没有新增事件记录')

    // 但时间衰减照常发生
    assert.ok(second.dims.anger < angerAfter, `衰减后 anger=${second.dims.anger} 应低于 ${angerAfter}`)
    assert.ok(second.dims.anger >= DIMS.anger.baseline, '不会掉到基线以下')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('events=true（默认）时行为不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-evt2-'))
  const db = openSoulDb(join(dir, 'tide.db'))
  try {
    const t0 = 1_800_000_000_000
    const r = step(db, { text: '你滚', now: t0 })
    assert.equal(r.reading.kind, 'conflict')
    assert.ok(Number(db.prepare('SELECT COUNT(*) AS n FROM soul_event').get().n) > 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('初始状态不会被 events=false 的调用改坏', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-evt3-'))
  const db = openSoulDb(join(dir, 'tide.db'))
  try {
    const r = step(db, { text: '随便写点什么，不含任何事件词', now: Date.now(), events: false })
    const dims = initialDims()
    for (const key of Object.keys(DIMS)) {
      assert.ok(Math.abs(r.dims[key] - dims[key]) < 1e-6, `${key} 不该变`)
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
