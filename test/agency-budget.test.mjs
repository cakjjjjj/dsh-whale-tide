/**
 * 累积额度（agency_budget）：每天发 dailyGrant，用不完攒着，maxBalance 封顶。
 *
 * 关键不变量：
 *   - 没记录过 → 余额就是今天刚发的量（不用先写库）
 *   - 真发出去一次扣一次；planned / skipped / failed 不扣
 *   - 跨天只补发一次，不按离线天数补
 *   - 余额不会超过 maxBalance
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgency } from '../lib/heartbeat/index.js'
import { initialDims } from '../lib/emotion/model.js'

function setup(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tide-budget-'))
  const db = new DatabaseSync(join(dir, 'tide.db'))
  const agency = createAgency({
    db,
    logger: { info() {}, warn() {} },
    config: { dailyGrant: 3, maxBalance: 20, maxReachPerDay: 10, ...config },
  })
  return { dir, db, agency }
}

/** 北京时间某天 12:00 的时间戳 */
const day = (iso) => {
  const d = new Date(`${iso}T12:00:00+08:00`)
  return d.getTime()
}

test('没记过账时，余额就是今天刚发的量', () => {
  const { dir, db, agency } = setup()
  try {
    assert.equal(agency.peekBudget(day('2026-11-17')), 3)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('真发一次扣一次', () => {
  const { dir, db, agency } = setup()
  try {
    const now = day('2026-11-17')
    agency.record({ summary: '第一次', result: 'sent', now })
    assert.equal(agency.peekBudget(now), 2)
    agency.record({ summary: '第二次', result: 'sent', now })
    assert.equal(agency.peekBudget(now), 1)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('planned / skipped / failed 不扣额度', () => {
  const { dir, db, agency } = setup()
  try {
    const now = day('2026-11-17')
    agency.rollBudget(now)
    agency.record({ summary: '计划', result: 'planned', now })
    agency.record({ summary: '跳过', result: 'skipped', now })
    agency.record({ summary: '失败', result: 'failed', now })
    assert.equal(agency.peekBudget(now), 3)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('跨天补发一次，不按离线天数补', () => {
  const { dir, db, agency } = setup({ dailyGrant: 3, maxBalance: 20, maxReachPerDay: 10 })
  try {
    const d1 = day('2026-11-17')
    agency.rollBudget(d1)
    // 离线三天后回来：只补一次 3，而不是 9
    const d4 = day('2026-11-20')
    assert.equal(agency.rollBudget(d4), 6)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('余额攒到 maxBalance 就封顶', () => {
  const { dir, db, agency } = setup({ dailyGrant: 4, maxBalance: 5, maxReachPerDay: 10 })
  try {
    agency.rollBudget(day('2026-11-17')) // 4
    agency.rollBudget(day('2026-11-18')) // min(5, 4+4)=5
    const third = agency.rollBudget(day('2026-11-19')) // 仍是 5
    assert.equal(third, 5)
    assert.equal(agency.peekBudget(day('2026-11-19')), 5)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('plan 的预算取「余额」与「今天还能发几次」的较小值', () => {
  const { dir, db, agency } = setup({ dailyGrant: 5, maxBalance: 20, maxReachPerDay: 2 })
  try {
    const now = day('2026-11-17')
    // 余额 5，但一天最多 2 次
    const plan = agency.plan({ dims: initialDims(), now })
    assert.equal(plan.balance, 5)
    assert.equal(plan.budgetLeft, 2)
    assert.equal(plan.maxBalance, 20)
    assert.equal(plan.dailyGrant, 5)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
