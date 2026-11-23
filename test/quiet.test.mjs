import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgency } from '../lib/heartbeat/index.js'
import { createConfigStore } from '../lib/config.js'
import { initialDims } from '../lib/emotion/model.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-quiet-'))
  const db = new DatabaseSync(join(dir, 'tide.db'))
  const config = createConfigStore({ db, logger: { info() {}, warn() {} } })
  const agency = createAgency({ db, logger: { info() {}, warn() {} }, getConfig: () => config.get() })
  return { dir, db, config, agency }
}

const atHour = (hour) => {
  const d = new Date('2026-11-12T00:00:00')
  d.setHours(hour, 30, 0, 0)
  return d.getTime()
}

test('起点终点相同 = 不设静默，而不是全天静默', () => {
  const { dir, db } = setup()
  try {
    // 模拟历史脏数据：库里已经存了一对相等的值（保存入口现在会拒绝，但旧数据可能留着）
    db.prepare("INSERT INTO tide_config(key, value, updated_ts) VALUES ('quietFrom', '8', 1) ON CONFLICT(key) DO UPDATE SET value = '8'").run()
    db.prepare("INSERT INTO tide_config(key, value, updated_ts) VALUES ('quietTo', '8', 1) ON CONFLICT(key) DO UPDATE SET value = '8'").run()
    const config = createConfigStore({ db, logger: { info() {}, warn() {} } })
    const agency = createAgency({ db, logger: { info() {}, warn() {} }, getConfig: () => config.get() })
    assert.equal(config.get().quietFrom, 8)
    assert.equal(config.get().quietTo, 8)
    assert.equal(agency.inQuietHours(atHour(8)), false)
    assert.equal(agency.inQuietHours(atHour(3)), false)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('跨零点的静默仍然生效', () => {
  const { dir, db, config, agency } = setup()
  try {
    config.update({ quietFrom: 23, quietTo: 8 })
    assert.equal(agency.inQuietHours(atHour(23)), true)
    assert.equal(agency.inQuietHours(atHour(3)), true)
    assert.equal(agency.inQuietHours(atHour(12)), false)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('保存相等的一对会被拒绝，且不改动已有配置', () => {
  const { dir, db, config } = setup()
  try {
    config.update({ quietFrom: 22, quietTo: 7 })
    assert.throws(() => config.update({ quietTo: 22 }), /不能相同/)
    assert.equal(config.get().quietFrom, 22)
    assert.equal(config.get().quietTo, 7)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('只改一半、结果相等时也拒绝', () => {
  const { dir, db, config } = setup()
  try {
    config.update({ quietFrom: 23, quietTo: 8 })
    assert.throws(() => config.update({ quietFrom: 8 }), /不能相同/)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
