import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAgency } from '../lib/heartbeat/index.js'

test('ensureSchema=false 时不在只读/空库上建表', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-schema-'))
  const file = join(dir, 'tide.db')
  new DatabaseSync(file).close() // 先落一个空库文件，只读打开才有效
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    assert.doesNotThrow(() => createAgency({ db, logger: { info() {}, warn() {} }, ensureSchema: false }))
    const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'agency_%'").get()
    assert.equal(Number(row.n), 0, '不应该凭空建表')
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('默认仍然确保 schema 存在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-schema2-'))
  const db = new DatabaseSync(join(dir, 'tide.db'))
  try {
    createAgency({ db, logger: { info() {}, warn() {} } })
    const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'agency_%'").get()
    // 2 → 3：新增 agency_budget（累积额度余额），同样在构造时补建
    assert.equal(Number(row.n), 3)
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
})
