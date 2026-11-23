/**
 * 灵魂库的落库层：node:sqlite + 迁移。
 *
 * 迁移只往前走，不回头：migrations/ 下的 .sql 按文件名排序执行，
 * schema_version 记录已执行到哪一版。已有的迁移文件永不修改。
 */

import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations')

/** 执行所有尚未应用的迁移，返回当前版本。 */
export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    note TEXT
  )`)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()
  const current = Number(row?.v ?? 0)
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  let version = current
  for (const file of files) {
    const target = Number(/^(\d+)/.exec(file)?.[1] ?? 0)
    if (!target || target <= current) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO schema_version(version, applied_at, note) VALUES (?, ?, ?)')
        .run(target, Date.now(), file)
      db.exec('COMMIT')
      version = target
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 ${file} 失败：${error.message}`)
    }
  }
  return version
}

const require = createRequire(import.meta.url)

/**
 * 加载 sqlite-vec。
 * 不用 require 的缓存路径直接载入——目录搬过家之后，缓存里可能还是旧绝对路径。
 * 先验文件是否存在，不存在就退回自己包里的平台二进制。
 */
function loadVectorExtension(db, logPath) {
  const here = dirname(fileURLToPath(import.meta.url))
  const note = (message) => {
    if (!logPath) return
    try {
      writeFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { flag: 'a' })
    } catch {
      // 记不下来也不影响
    }
  }
  const candidates = []
  try {
    candidates.push(require('sqlite-vec').getLoadablePath())
  } catch (error) {
    note(`require failed: ${error?.message ?? error}`)
  }
  candidates.push(join(here, '..', 'node_modules', 'sqlite-vec-linux-x64', 'vec0.so'))
  candidates.push(join(here, '..', 'node_modules', 'sqlite-vec', 'vec0.so'))
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue
    try {
      db.enableLoadExtension?.(true)
      db.loadExtension(candidate)
      note(`loaded ok: ${candidate}`)
      return true
    } catch (error) {
      note(`load failed ${candidate}: ${error?.message ?? error}`)
    }
  }
  note('no loadable path')
  return false
}

export function openSoulDb(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { allowExtension: true })
  loadVectorExtension(db, join(dirname(path), 'vec-load.log'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  migrate(db)
  // 向量表依赖扩展，只能在加载扩展之后建（迁移文件里只放普通表）
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec
             USING vec0(embedding float[512] distance_metric=cosine)`)
  } catch {
    // 没有扩展时跳过，情绪模块不受影响
  }
  return db
}

/** 读出当前状态；没有就写一行基线。 */
export function loadState(db, initialDims, now = Date.now()) {
  const row = db.prepare('SELECT dims, last_tick FROM soul_state WHERE id = 1').get()
  if (!row) {
    const dims = initialDims()
    db.prepare('INSERT INTO soul_state(id, dims, last_tick) VALUES (1, ?, ?)')
      .run(JSON.stringify(dims), now)
    return { dims, lastTick: now }
  }
  return { dims: JSON.parse(row.dims), lastTick: Number(row.last_tick) }
}

export function saveState(db, dims, lastTick) {
  db.prepare('UPDATE soul_state SET dims = ?, last_tick = ? WHERE id = 1')
    .run(JSON.stringify(dims), lastTick)
}

export function recordEvent(db, { ts, kind, intensity, delta, dimsAfter, why, memoryId, pinned }) {
  const result = db.prepare(`
    INSERT INTO soul_event(ts, kind, intensity, delta, dims_after, why, memory_id, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ts,
    kind,
    intensity,
    JSON.stringify(delta),
    JSON.stringify(dimsAfter),
    why ?? null,
    memoryId ?? null,
    pinned ? 1 : 0,
  )
  return Number(result.lastInsertRowid)
}

export function recordSnapshot(db, { ts, dims, moodLine, sessionId }) {
  db.prepare('INSERT INTO soul_snapshot(ts, dims, mood_line, session_id) VALUES (?, ?, ?, ?)')
    .run(ts, JSON.stringify(dims), moodLine ?? null, sessionId ?? null)
}

export function stats(db) {
  const events = db.prepare('SELECT COUNT(*) AS n FROM soul_event').get()
  const snapshots = db.prepare('SELECT COUNT(*) AS n FROM soul_snapshot').get()
  const version = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()
  return {
    schemaVersion: Number(version?.v ?? 0),
    events: Number(events?.n ?? 0),
    snapshots: Number(snapshots?.n ?? 0),
  }
}
