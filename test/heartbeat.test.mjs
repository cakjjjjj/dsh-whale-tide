import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgency } from '../lib/heartbeat/index.js'
import { initialDims } from '../lib/emotion/model.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-agency-'))
  const db = new DatabaseSync(join(dir, 'tide.db'))
  const agency = createAgency({ db, logger: { info() {}, warn() {} } })
  return { dir, db, agency }
}

const noon = (date) => {
  const d = new Date(date)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

test('平静状态、正常时段：允许主动', () => {
  const { dir, db, agency } = setup()
  try {
    const plan = agency.plan({ dims: initialDims(), now: noon('2026-11-11T03:00:00Z') })
    assert.equal(plan.allowed, true)
    assert.equal(plan.budgetLeft, 3)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('深夜属于静默时段，不许主动', () => {
  const { dir, db, agency } = setup()
  try {
    const midnight = new Date('2026-11-11T15:30:00Z').getTime() // 北京时间 23:30
    const plan = agency.plan({ dims: initialDims(), now: midnight })
    assert.equal(plan.allowed, false)
    assert.match(plan.reason, /静默/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('主动三次之后预算用尽', () => {
  const { dir, db, agency } = setup()
  try {
    const now = noon('2026-11-11T03:00:00Z')
    for (let i = 0; i < 3; i += 1) {
      agency.record({ summary: `第${i + 1}次`, result: 'sent', now: now + i * 1000 })
    }
    const plan = agency.plan({ dims: initialDims(), now: now + 5000 })
    assert.equal(plan.allowed, false)
    assert.equal(plan.budgetLeft, 0)
    // 额度改成「余额 + 每日上限」双闸后，文案也跟着变；这里只要求说清是用尽
    assert.match(plan.reason, /额度|次数/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('生气时即使有预算也不主动', () => {
  const { dir, db, agency } = setup()
  try {
    const dims = initialDims()
    dims.anger = 70
    const plan = agency.plan({ dims, now: noon('2026-11-11T03:00:00Z') })
    assert.equal(plan.allowed, false)
    assert.match(plan.reason, /情绪/)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('私心会提高冲动值，并作为候选出现', () => {
  const { dir, db, agency } = setup()
  try {
    const now = noon('2026-11-11T03:00:00Z')
    const before = agency.plan({ dims: initialDims(), now })
    agency.addDesire({ text: '想给他做个周报', weight: 1, now })
    const after = agency.plan({ dims: initialDims(), now })
    assert.ok(after.urge > before.urge)
    assert.equal(after.candidates.length, 1)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('关掉的私心不再出现', () => {
  const { dir, db, agency } = setup()
  try {
    const id = agency.addDesire({ text: '想学一首歌' })
    assert.equal(agency.listDesires().length, 1)
    agency.closeDesire(id)
    assert.equal(agency.listDesires().length, 0)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('plan 带出「他最后一次说话」的时间', () => {
  const { dir, db, agency } = setup()
  try {
    const now = noon('2026-11-11T03:00:00Z')
    // 这个 setup 不跑迁移，memory 表要自己建（只建这几种列就够 plan 查）
    db.exec(`CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT, session_id TEXT, source TEXT,
      role TEXT, ts INTEGER, text TEXT, deleted_at INTEGER)`)
    db.prepare(`INSERT INTO memory (fingerprint, session_id, source, role, ts, text, deleted_at)
                VALUES ('fp1', 's1', 'chat', 'user', ?, '用户: 你在吗', NULL)`).run(now - 2 * 3600_000)
    const plan = agency.plan({ dims: initialDims(), now })
    assert.equal(plan.lastUserAt, now - 2 * 3600_000)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})

test('没有对话记录时 lastUserAt 为 null', () => {
  const { dir, db, agency } = setup()
  try {
    const plan = agency.plan({ dims: initialDims(), now: noon('2026-11-11T03:00:00Z') })
    assert.equal(plan.lastUserAt, null)
  } finally {
    db.close(); rmSync(dir, { recursive: true, force: true })
  }
})
