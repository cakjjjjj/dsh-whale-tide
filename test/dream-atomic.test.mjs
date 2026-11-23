import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKeep } from '../lib/dream/index.js'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tide-dream-'))
  const memory = [
    '# MEMORY',
    '',
    '## 记着的事',
    ...Array.from({ length: 14 }, (_, i) => `- 第 ${i + 1} 条`),
    '',
    '## 其他',
    '- 结尾',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'MEMORY.md'), memory)
  const db = new DatabaseSync(join(dir, 'tide.db'))
  const keep = createKeep({ db, dataDir: dir, workspaceDir: dir, log: { info() {}, warn() {} } })
  return { dir, db, keep, memory }
}

test('归档是原子替换：失败时 MEMORY.md 一点都不变', () => {
  const { dir, db, keep, memory } = setup()
  try {
    const plan = keep.planArchive({ keepRecent: 5 })
    assert.ok(plan.moving.length > 0, '应有可归档条目')
    // 让目录只读，写入必然失败
    chmodSync(dir, 0o500)
    assert.throws(() => keep.applyArchive(plan))
    chmodSync(dir, 0o700)
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), memory)
  } finally {
    chmodSync(dir, 0o700)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('成功归档后主文件变短，归档文件有内容', () => {
  const { dir, db, keep } = setup()
  try {
    const plan = keep.planArchive({ keepRecent: 5 })
    const result = keep.applyArchive(plan)
    assert.ok(result.moved > 0)
    const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.ok(!after.includes('第 1 条'), '最老的条目应已搬走')
    assert.ok(after.includes('第 14 条'), '最新的条目要留着')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
