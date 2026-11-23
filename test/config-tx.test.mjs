import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createConfigStore } from '../lib/config.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-cfg-tx-'))
  const real = new DatabaseSync(join(dir, 'tide.db'))
  return { dir, real }
}

test('一次改多个键：中途失败时库里一条都不留', () => {
  const { dir, real } = setup()
  try {
    const store = createConfigStore({ db: real, logger: { info() {}, warn() {} } })
    store.update({ maxReachPerDay: 4 })

    // 第二把写入时抛错，模拟磁盘/约束问题
    let writes = 0
    const flaky = {
      exec: (...args) => real.exec(...args),
      prepare: (sql) => {
        const stmt = real.prepare(sql)
        return {
          run: (...args) => {
            writes += 1
            if (writes === 2) throw new Error('模拟写入失败')
            return stmt.run(...args)
          },
        }
      },
    }
    const broken = createConfigStore({ db: flaky, logger: { info() {}, warn() {} } })
    assert.throws(() => broken.update({ quietFrom: 22, quietTo: 7, maxReachPerDay: 9 }), /模拟写入失败/)

    // 库里的三个键都不该出现（第一条也被回滚）
    const rows = real.prepare("SELECT key FROM tide_config WHERE key IN ('quietFrom','quietTo','maxReachPerDay')").all()
    assert.deepEqual(rows.map((r) => String(r.key)), ['maxReachPerDay'])
    const kept = real.prepare("SELECT value FROM tide_config WHERE key = 'maxReachPerDay'").get()
    assert.equal(JSON.parse(kept.value), 4)
  } finally { real.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('成功时全部落库', () => {
  const { dir, real } = setup()
  try {
    const store = createConfigStore({ db: real, logger: { info() {}, warn() {} } })
    store.update({ quietFrom: 22, quietTo: 7, maxReachPerDay: 2 })
    const again = createConfigStore({ db: real })
    assert.equal(again.get().quietFrom, 22)
    assert.equal(again.get().quietTo, 7)
    assert.equal(again.get().maxReachPerDay, 2)
  } finally { real.close(); rmSync(dir, { recursive: true, force: true }) }
})
