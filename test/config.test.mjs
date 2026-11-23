import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CONFIG_DEFAULTS, clampConfig, createConfigStore } from '../lib/config.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-config-'))
  const db = new DatabaseSync(join(dir, 'tide.db'))
  const store = createConfigStore({ db, logger: { info() {}, warn() {} } })
  return { dir, db, store }
}

test('默认值齐全', () => {
  const { dir, db, store } = setup()
  try {
    const cfg = store.get()
    for (const key of Object.keys(CONFIG_DEFAULTS)) assert.ok(key in cfg, `缺 ${key}`)
    assert.equal(cfg.maxReachPerDay, 3)
    assert.equal(cfg.injectMood, true)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('改了就生效，并持久化到库', () => {
  const { dir, db, store } = setup()
  try {
    store.update({ maxReachPerDay: 5, quietFrom: 22 })
    assert.equal(store.get().maxReachPerDay, 5)
    // 重新建一个 store 读同一个库
    const again = createConfigStore({ db })
    assert.equal(again.get().maxReachPerDay, 5)
    assert.equal(again.get().quietFrom, 22)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('越界的值会被夹到范围内', () => {
  assert.equal(clampConfig('maxReachPerDay', 999), 20)
  assert.equal(clampConfig('quietFrom', -3), 0)
  assert.equal(clampConfig('minUrge', 3), 1)
  assert.equal(clampConfig('maxMoodChars', 10), 80)
})

test('布尔项只认真假', () => {
  const { dir, db, store } = setup()
  try {
    store.update({ injectMood: false })
    assert.equal(store.get().injectMood, false)
    store.update({ injectMood: true })
    assert.equal(store.get().injectMood, true)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('未知键被忽略，非法值报错', () => {
  const { dir, db, store } = setup()
  try {
    const before = store.get().maxReachPerDay
    store.update({ nonsense: 1 })
    assert.equal(store.get().maxReachPerDay, before)
    assert.throws(() => store.update({ maxReachPerDay: 'abc' }), /不合法/)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('变更会通知订阅者', () => {
  const { dir, db, store } = setup()
  try {
    let seen = null
    const off = store.onChange((cfg) => { seen = cfg.maxReachPerDay })
    store.update({ maxReachPerDay: 2 })
    assert.equal(seen, 2)
    off()
    store.update({ maxReachPerDay: 4 })
    assert.equal(seen, 2)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
