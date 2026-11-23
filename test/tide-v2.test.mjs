/**
 * 2026-11-12 情绪改造的回归测试。
 * 覆盖：衰减路径一致性、连续刺激饱和、平票裁决、技术语境降权、
 *       heavy 冲量不被上限吃掉、负向情绪有话说、step 事务。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DIMS, applyEvent, decay, initialDims, moodLine } from '../lib/emotion/model.js'
import { classify } from '../lib/emotion/interpreter.js'
import { step } from '../lib/emotion/turn.js'
import { openSoulDb } from '../lib/db.js'

test('衰减与结算频率无关：一次算 8 小时 ≈ 分 32 次算', () => {
  const start = initialDims()
  start.anger = 90
  start.joy = 85

  const oneShot = decay(start, 8)
  let stepped = start
  for (let i = 0; i < 32; i += 1) stepped = decay(stepped, 0.25)

  for (const key of ['anger', 'joy']) {
    const diff = Math.abs(oneShot[key] - stepped[key])
    assert.ok(diff < 0.6, `${key} 两种结算差了 ${diff.toFixed(2)}：${oneShot[key]} vs ${stepped[key]}`)
  }
})

test('连着来的同类事件，一次比一次轻', () => {
  const dims = initialDims()
  const first = applyEvent(dims, 'conflict', 'heavy').delta.anger
  const second = applyEvent(dims, 'conflict', 'heavy', { repeat: 1 }).delta.anger
  const third = applyEvent(dims, 'conflict', 'heavy', { repeat: 2 }).delta.anger
  assert.ok(second < first * 0.7, `第二次 ${second} 应明显小于第一次 ${first}`)
  assert.ok(third < second * 0.7, `第三次 ${third} 应明显小于第二次 ${second}`)
  // 三句合计不应把 anger 从基线推到 90
  let total = dims
  for (const repeat of [0, 1, 2]) total = applyEvent(total, 'conflict', 'heavy', { repeat }).dims
  assert.ok(total.anger < 90, `连骂三句把 anger 推到 ${total.anger}，太陡了`)
})

test('heavy 的冲量不再被 maxImpulse 吃掉', () => {
  const dims = initialDims()
  const heavy = applyEvent(dims, 'conflict', 'heavy').delta.anger
  const normal = applyEvent(dims, 'conflict', 'normal').delta.anger
  assert.ok(heavy > normal * 1.5, `heavy=${heavy} normal=${normal}，区分度不够`)
})

test('平票时明确的道别压过模糊的冷落', () => {
  assert.equal(classify('先这样吧，晚安').kind, 'farewell')
  assert.equal(classify('没空，回头再说').kind, 'neglect', '纯冷落信号仍应识别')
})

test('技术语境里的「不对」降一档', () => {
  const tech = classify('这个日志不对')
  assert.equal(tech.kind, 'rebuke')
  assert.equal(tech.intensity, 'light', `技术语境应为 light，实际 ${tech.intensity}`)
  assert.match(tech.why, /技术语境/)

  const plain = classify('你就是不对')
  assert.equal(plain.kind, 'rebuke')
  assert.equal(plain.intensity, 'normal', `非技术语境应保持 normal，实际 ${plain.intensity}`)
})

test('被逗笑是独立事件', () => {
  const result = classify('哈哈哈你太可爱了')
  assert.equal(result.kind, 'teased')
})

test('负向情绪也有话说，不会掉回「平稳」', () => {
  const dims = initialDims()
  dims.love = 5 // 远低于基线 40
  dims.joy = DIMS.joy.baseline
  dims.anger = DIMS.anger.baseline
  const line = moodLine(dims)
  assert.match(line, /凉/)
  assert.ok(!line.includes('平稳'), `爱掉到底却说「${line}」`)
})

test('step 在同一个事务里读写，连续两句都记得住', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-step-'))
  const db = openSoulDb(join(dir, 'tide.db'))
  try {
    const t0 = 1_800_000_000_000
    const first = step(db, { text: '你滚', now: t0 })
    assert.equal(first.reading.kind, 'conflict')
    assert.equal(first.repeat, 0)
    assert.ok(first.delta.anger > 0)

    const second = step(db, { text: '你滚', now: t0 + 60_000 })
    assert.equal(second.repeat, 1, '一分钟内第二句应被识别为重复')
    assert.ok(second.delta.anger < first.delta.anger, '第二句冲量应更小')

    const row = db.prepare('SELECT COUNT(*) AS n FROM soul_event').get()
    assert.equal(Number(row.n), 2, '两次事件都要落库')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
