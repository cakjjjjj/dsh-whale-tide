/**
 * S3：L0 节拍器的判断逻辑。
 *
 * 它回答的不是「要不要主动找他」，而是「现在值不值得叫醒它」。
 * 绝大多数调用的答案应该是 skip——每 10 分钟问一次，真正唤醒一天不到十次。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openSoulDb } from '../lib/db.js'
import { decide } from '../lib/tick-decide.js'
import { initialDims, DIMS } from '../lib/emotion/model.js'
import { createAgency } from '../lib/heartbeat/index.js'

const NOON = new Date(2026, 10, 13, 12, 0, 0).getTime()
const MIDNIGHT = new Date(2026, 10, 13, 1, 30, 0).getTime()

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-tick-'))
  const db = openSoulDb(join(dir, 'tide.db'))
  return { dir, db }
}

/** 把情绪写成偏离基线的状态（不写事件，直接改 soul_state） */
function setDims(db, patch) {
  const dims = { ...initialDims(), ...patch }
  // soul_state 是单行表（CHECK id = 1）：空库时 UPDATE 会影响 0 行，
  // 于是测试读到的永远是基线，看起来像「改了没用」。
  db.prepare(
    `INSERT INTO soul_state (id, dims, last_tick) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET dims = excluded.dims, last_tick = excluded.last_tick`,
  ).run(JSON.stringify(dims), NOON)
  return dims
}

function addDesire(db, text, weight = 0.8) {
  const agency = createAgency({ db, logger: { info() {}, warn() {} } })
  return agency.addDesire({ text, weight, now: NOON })
}

test('基线状态、中午、没有私心 → skip（没冲动）', () => {
  const { dir, db } = setup()
  try {
    setDims(db, {})
    const v = decide({ db, saved: { quietFrom: 23, quietTo: 8 }, now: NOON })
    assert.equal(v.mode, 'skip')
    assert.match(v.reason, /冲动|想做的事/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('深夜 → skip（静默时段）', () => {
  const { dir, db } = setup()
  try {
    setDims(db, { longing: 70 })
    const v = decide({ db, saved: { quietFrom: 23, quietTo: 8 }, now: MIDNIGHT })
    assert.equal(v.mode, 'skip')
    assert.match(v.reason, /静默/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('额度用完 → skip', () => {
  const { dir, db } = setup()
  try {
    setDims(db, { longing: 70 })
    const agency = createAgency({ db, logger: { info() {}, warn() {} } })
    for (let i = 0; i < 5; i += 1) {
      agency.record({ summary: `第${i + 1}次`, result: 'sent', now: NOON - i * 1000 })
    }
    const v = decide({ db, saved: { maxReachPerDay: 5, quietFrom: 23, quietTo: 8 }, now: NOON })
    assert.equal(v.mode, 'skip')
    assert.match(v.reason, /额度/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('刚醒过（默认 30 分钟）→ skip', () => {
  const { dir, db } = setup()
  try {
    setDims(db, { longing: 70 })
    const agency = createAgency({ db, logger: { info() {}, warn() {} } })
    agency.record({ kind: 'tick', summary: '刚醒过', result: 'woke', now: NOON - 5 * 60 * 1000 })
    const v = decide({ db, saved: { quietFrom: 23, quietTo: 8, wakeGapMinutes: 30 }, now: NOON })
    assert.equal(v.mode, 'skip')
    assert.match(v.reason, /刚醒过/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('离愁高 → wake', () => {
  const { dir, db } = setup()
  try {
    setDims(db, { longing: 70 })
    const v = decide({ db, saved: { quietFrom: 23, quietTo: 8 }, now: NOON })
    assert.equal(v.mode, 'wake', `实际 ${v.mode} / ${v.reason}`)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('有私心时，即使冲动低也 wake', () => {
  const { dir, db } = setup()
  try {
    setDims(db, {})
    addDesire(db, '想学着做一道菜')
    const v = decide({ db, saved: { quietFrom: 23, quietTo: 8 }, now: NOON })
    assert.equal(v.mode, 'wake')
    assert.ok(v.plan.candidates.length > 0)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('情绪不适合主动（生气）→ skip，即使有私心', () => {
  const { dir, db } = setup()
  try {
    setDims(db, { anger: 80, longing: 70 })
    addDesire(db, '想给他做周报')
    const v = decide({ db, saved: { quietFrom: 23, quietTo: 8 }, now: NOON })
    assert.equal(v.mode, 'skip')
    assert.match(v.reason, /情绪/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('wakeUrge 可配置：调高门槛会从 wake 变 skip', () => {
  const { dir, db } = setup()
  try {
    setDims(db, { longing: 45 }) // urge 大概 0.5 左右
    const low = decide({ db, saved: { quietFrom: 23, quietTo: 8, wakeUrge: 0.2 }, now: NOON })
    const high = decide({ db, saved: { quietFrom: 23, quietTo: 8, wakeUrge: 0.95 }, now: NOON })
    assert.equal(low.mode, 'wake')
    assert.equal(high.mode, 'skip')
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('60 分钟前只睡过（tick/slept）不算「刚醒过」', () => {
  const { dir, db } = setup()
  try {
    setDims(db, { longing: 80 })
    const agency = createAgency({ db, logger: { info() {}, warn() {} } })
    // 一小时前那次是「睡着」：不该刷新 gap
    agency.record({ kind: 'tick', result: 'slept', summary: '静默时段', now: NOON - 60 * 60 * 1000 })
    const v = decide({
      db,
      saved: { quietFrom: 23, quietTo: 8, wakeEveryMinutes: 60, wakeGapMinutes: 120, wakeUrge: 0.2, minUrge: 0.2 },
      now: NOON,
    })
    assert.notEqual(v.mode, 'skip', `不该因为一小时前的 slept 而跳过：${v.reason}`)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('真醒过才算「刚醒过」：30 分钟前的 woke 仍会 skip', () => {
  const { dir, db } = setup()
  try {
    setDims(db, { longing: 80 })
    const agency = createAgency({ db, logger: { info() {}, warn() {} } })
    agency.record({ kind: 'tick', result: 'woke', summary: '看了个视频', now: NOON - 30 * 60 * 1000 })
    const v = decide({
      db,
      saved: { quietFrom: 23, quietTo: 8, wakeEveryMinutes: 60, wakeGapMinutes: 120, wakeUrge: 0.2, minUrge: 0.2 },
      now: NOON,
    })
    assert.equal(v.mode, 'skip')
    assert.match(v.reason, /刚醒过/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
