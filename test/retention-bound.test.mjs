import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retentionOf } from '../lib/memory/recall.js'

const now = 1_800_000_000_000
const HOUR = 3_600_000

test('访问次数封顶：超过 12 次与 12 次等价', () => {
  const base = { ts: now - 500 * HOUR, last_access: now - 500 * HOUR, importance: 0.5 }
  const at12 = retentionOf({ ...base, access_count: 12 }, now)
  const at200 = retentionOf({ ...base, access_count: 200 }, now)
  assert.equal(at200, at12)
})

test('封顶不影响「想起得越多越难忘」这个趋势', () => {
  const base = { ts: now - 500 * HOUR, last_access: now - 500 * HOUR, importance: 0.5 }
  const none = retentionOf({ ...base, access_count: 0 }, now)
  const some = retentionOf({ ...base, access_count: 5 }, now)
  assert.ok(some > none)
})
