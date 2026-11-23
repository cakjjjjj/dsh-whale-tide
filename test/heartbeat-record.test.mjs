import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgency } from '../lib/heartbeat/index.js'
import { initialDims } from '../lib/emotion/model.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-rec-'))
  const db = new DatabaseSync(join(dir, 'tide.db'))
  const agency = createAgency({ db, logger: { info() {}, warn() {} } })
  return { dir, db, agency }
}

const noon = () => {
  const d = new Date('2026-11-12T00:00:00')
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

test('不传 result 也算已发生，预算要扣', () => {
  const { dir, db, agency } = setup()
  try {
    const now = noon()
    agency.record({ summary: '忘传 result 的一次' , now })
    assert.equal(agency.usedToday(now), 1)
    const plan = agency.plan({ dims: initialDims(), now })
    assert.equal(plan.used, 1)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('显式 planned 不计入预算', () => {
  const { dir, db, agency } = setup()
  try {
    const now = noon()
    agency.record({ summary: '只是计划', result: 'planned', now })
    assert.equal(agency.usedToday(now), 0)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
