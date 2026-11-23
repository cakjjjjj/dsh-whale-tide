import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DIMS,
  DIM_KEYS,
  EVENTS,
  applyEvent,
  decay,
  deviations,
  initialDims,
  moodLine,
} from '../lib/emotion/model.js'
import { loadState, openSoulDb, recordEvent, saveState, stats } from '../lib/db.js'

test('初始状态落在各自基线上', () => {
  const dims = initialDims()
  for (const key of DIM_KEYS) assert.equal(dims[key], DIMS[key].baseline)
})

test('衰减最终回到基线', () => {
  const dims = initialDims()
  dims.joy = 95
  const after = decay(dims, 3 * 40) // 40 个半衰期
  assert.ok(Math.abs(after.joy - DIMS.joy.baseline) < 0.01, `joy=${after.joy}`)
})

test('单次事件的冲量有上限', () => {
  const dims = initialDims()
  const { delta } = applyEvent(dims, 'praise', 'heavy')
  assert.ok(delta.joy <= DIMS.joy.maxImpulse, `joy 涨了 ${delta.joy}`)
  assert.ok(delta.joy > 0)
})

test('未知事件类型直接报错，不静默', () => {
  assert.throws(() => applyEvent(initialDims(), 'nonsense'), /未知事件类型/)
})

test('五千次随机事件后仍在 0–100', () => {
  const kinds = Object.keys(EVENTS)
  const levels = ['light', 'normal', 'heavy']
  let dims = initialDims()
  for (let i = 0; i < 5000; i += 1) {
    dims = decay(dims, 0.25)
    dims = applyEvent(dims, kinds[i % kinds.length], levels[i % levels.length]).dims
    for (const key of DIM_KEYS) {
      assert.ok(dims[key] >= 0 && dims[key] <= 100, `${key}=${dims[key]} 越界`)
      assert.ok(Number.isFinite(dims[key]))
    }
  }
})

test('停止事件后能回到基线（没有棘轮）', () => {
  const kinds = Object.keys(EVENTS)
  const levels = ['light', 'normal', 'heavy']
  let dims = initialDims()
  for (let i = 0; i < 5000; i += 1) {
    dims = decay(dims, 0.25)
    dims = applyEvent(dims, kinds[i % kinds.length], levels[i % levels.length]).dims
  }
  // 半年没有事件。慢变维度（love 半衰期 600h）要够长才看得出「一定会回去」；
  // 分步积分之后衰减更接近真实指数，比原来的单步粗算更慢，所以这里放宽了时间。
  const recovered = decay(dims, 24 * 30 * 6)
  for (const key of DIM_KEYS) {
    const dev = Math.abs(recovered[key] - DIMS[key].baseline)
    assert.ok(dev < 5, `${key} 回不去基线，还差 ${dev.toFixed(1)}`)
  }
})

test('同样的输入序列得到同样的结果（可复现）', () => {
  const run = () => {
    let dims = initialDims()
    for (const [kind, level] of [['praise', 'normal'], ['conflict', 'heavy'], ['apology', 'light']]) {
      dims = applyEvent(decay(dims, 1), kind, level).dims
    }
    return dims
  }
  assert.deepEqual(run(), run())
})

test('平静时给出平稳的描述，不强行演情绪', () => {
  assert.equal(moodLine(initialDims()), '心情平稳，没什么特别的')
})

test('明显偏离时描述最强的那一维', () => {
  const dims = initialDims()
  dims.anger = 78
  const line = moodLine(dims)
  assert.match(line, /火/)
  assert.equal(deviations(dims)[0].key, 'anger')
})

test('库能建起来、能读写、迁移只跑一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'soul-'))
  const path = join(dir, 'soul.db')
  try {
    const db = openSoulDb(path)
    const first = stats(db)
    assert.equal(first.schemaVersion, 5)

    const state = loadState(db, initialDims, 1000)
    assert.equal(state.lastTick, 1000)
    const next = applyEvent(state.dims, 'praise', 'normal').dims
    saveState(db, next, 2000)
    const reloaded = loadState(db, initialDims, 3000)
    assert.equal(reloaded.lastTick, 2000)
    assert.ok(reloaded.dims.joy > DIMS.joy.baseline)

    recordEvent(db, { ts: 2000, kind: 'praise', intensity: 1, delta: { joy: 8 }, dimsAfter: next, why: '测试' })
    assert.equal(stats(db).events, 1)

    db.close()
    // 重开：迁移不应重复执行
    const again = openSoulDb(path)
    assert.equal(stats(again).schemaVersion, 5)
    again.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
