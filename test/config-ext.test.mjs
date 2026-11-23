/**
 * S1：0.4.0 新增的调度类配置项。
 *
 * 这些键决定心跳多久醒一次、鲸梦几点做、额度怎么攒。
 * 类型比原来的标量复杂（布尔 / HH:MM / 白名单数组），要单独守着。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { CONFIG_DEFAULTS, clampConfig, createConfigStore } from '../lib/config.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-cfg-'))
  const db = new DatabaseSync(join(dir, 'tide.db'))
  const store = createConfigStore({ db, logger: { info() {}, warn() {} } })
  return { dir, db, store }
}

test('新键都有默认值', () => {
  for (const key of [
    'wakeEnabled', 'wakeEveryMinutes', 'wakeGapMinutes',
    'dreamAt', 'dreamTasks', 'dreamPrune',
    'dailyGrant', 'maxBalance', 'memoryArchive',
  ]) {
    assert.ok(key in CONFIG_DEFAULTS, `缺 ${key}`)
  }
  assert.equal(CONFIG_DEFAULTS.wakeEveryMinutes, 180)
  assert.equal(CONFIG_DEFAULTS.dreamAt, '22:30')
  assert.equal(CONFIG_DEFAULTS.dreamPrune, false)
})

test('dreamAt 只接受合法的 HH:MM', () => {
  assert.equal(clampConfig('dreamAt', '03:05'), '03:05')
  assert.equal(clampConfig('dreamAt', '23:59'), '23:59')
  assert.equal(clampConfig('dreamAt', '24:00'), undefined)
  assert.equal(clampConfig('dreamAt', '9:5'), undefined)
  assert.equal(clampConfig('dreamAt', '晚上十点'), undefined)
})

test('dreamTasks 只留白名单里的项，并保持稳定顺序', () => {
  assert.deepEqual(clampConfig('dreamTasks', ['memory', 'health']), ['health', 'memory'])
  assert.deepEqual(clampConfig('dreamTasks', ['memory', 'hack', 'memory']), ['memory'])
  assert.deepEqual(clampConfig('dreamTasks', []), [])
})

test('唤醒间隔有上下限', () => {
  assert.equal(clampConfig('wakeEveryMinutes', 10), 30)
  assert.equal(clampConfig('wakeEveryMinutes', 9999), 720)
  assert.equal(clampConfig('wakeEveryMinutes', 240), 240)
  assert.equal(clampConfig('wakeGapMinutes', 1), 10)
})

test('布尔项接受真值转换', () => {
  assert.equal(clampConfig('wakeEnabled', 0), false)
  assert.equal(clampConfig('wakeEnabled', 'yes'), true)
  assert.equal(clampConfig('dreamPrune', 1), true)
})

test('存进去能读出来，类型不丢', () => {
  const { dir, db, store } = setup()
  try {
    store.update({
      dreamAt: '23:10',
      dreamTasks: ['health', 'persona'],
      wakeEveryMinutes: 240,
      wakeEnabled: false,
    })
    const reopened = createConfigStore({ db, logger: { info() {}, warn() {} } })
    const cfg = reopened.get()
    assert.equal(cfg.dreamAt, '23:10')
    assert.deepEqual(cfg.dreamTasks, ['health', 'persona'])
    assert.equal(cfg.wakeEveryMinutes, 240)
    assert.equal(cfg.wakeEnabled, false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非法时间提交会抛错，不会静默吞掉', () => {
  const { dir, db, store } = setup()
  try {
    assert.throws(() => store.update({ dreamAt: '25:00' }), /不合法/)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sessionMode 是标量枚举，不是数组', () => {
  // 曾经在 LIST_KEYS 里 → 被包成 ['background']，面板下拉框对不上
  assert.equal(clampConfig('sessionMode', 'main'), 'main')
  assert.equal(clampConfig('sessionMode', 'background'), 'background')
  assert.equal(clampConfig('sessionMode', 'new'), 'new')
  assert.equal(clampConfig('sessionMode', 'hack'), undefined)
  // 旧脏数据要能解包救回来
  assert.equal(clampConfig('sessionMode', ['main']), 'main')
})

test('sessionMode 存进去读出来是字符串', () => {
  const { dir, db, store } = setup()
  try {
    store.update({ sessionMode: 'main' })
    const raw = db.prepare("SELECT value FROM tide_config WHERE key = 'sessionMode'").get()
    assert.equal(JSON.parse(raw.value), 'main', '不能存成 ["main"]')
    const cfg = createConfigStore({ db, logger: { info() {}, warn() {} } }).get()
    assert.equal(cfg.sessionMode, 'main')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dreamTasks 仍然是数组，没被枚举改动带偏', () => {
  assert.deepEqual(clampConfig('dreamTasks', ['memory', 'health']), ['health', 'memory'])
  assert.deepEqual(clampConfig('dreamTasks', 'memory'), ['memory'])
})
