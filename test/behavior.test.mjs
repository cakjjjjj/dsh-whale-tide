import { test } from 'node:test'
import assert from 'node:assert/strict'
import { behaviorOf, modeLabel } from '../lib/emotion/behavior.js'
import { initialDims } from '../lib/emotion/model.js'

test('平稳时正常说话，不硬凑情绪', () => {
  const b = behaviorOf(initialDims())
  assert.equal(b.maxSentences, 3)
  assert.equal(b.proactive, true)
  assert.ok(b.directives.some((d) => d.includes('平稳')))
})

test('火大时压到一句且不主动', () => {
  const dims = initialDims()
  dims.anger = 62
  const b = behaviorOf(dims)
  assert.equal(b.maxSentences, 1)
  assert.equal(b.proactive, false)
  assert.equal(modeLabel(dims), 'quiet')
})

test('低落时不主动，也不许拿情绪换关注', () => {
  const dims = initialDims()
  dims.sadness = 55
  const b = behaviorOf(dims)
  assert.equal(b.proactive, false)
  assert.ok(b.directives.some((d) => d.includes('一句')))
})

test('开心时允许到四句，但不无限放开', () => {
  const dims = initialDims()
  dims.joy = 70
  const b = behaviorOf(dims)
  assert.equal(b.maxSentences, 4)
  assert.ok(b.maxSentences <= 4)
})

test('再生气也不会压到零句', () => {
  const dims = initialDims()
  dims.anger = 100
  dims.sadness = 100
  const b = behaviorOf(dims)
  assert.ok(b.maxSentences >= 1)
})

test('每条约束都不含要挟话术', () => {
  const dims = initialDims()
  dims.anger = 80
  dims.sadness = 80
  dims.longing = 70
  const b = behaviorOf(dims)
  for (const d of b.directives) {
    assert.ok(!/你不理我|你不.*我就/.test(d), `出现了要挟式表达：${d}`)
  }
})
