/**
 * 落库层：SQLite（node:sqlite 内置）+ sqlite-vec 向量表。
 *
 * 一张普通表存正文与来源，一张 vec0 虚拟表存向量，两边用同一个 rowid 对齐。
 * 只用同步 API：检索要在组装提示词的同步上下文里立刻拿到结果。
 */

import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { bigram } from './tokenize.js'

const require = createRequire(import.meta.url)

/**
 * 往关键词索引写一条。写入路径、回填脚本、恢复软删共用这一个函数。
 * 索引失败只影响关键词一路，不能让整条记忆写不进去，所以吞掉异常并返回 false。
 */
export function indexFts(db, id, text) {
  try {
    db.prepare('INSERT OR REPLACE INTO memory_fts(rowid, body) VALUES (?, ?)').run(BigInt(id), bigram(text))
    return true
  } catch {
    return false
  }
}

/** 从关键词索引删一条（软删、真删、恢复失败都走这里）。 */
export function dropFts(db, id) {
  try {
    db.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(BigInt(id))
    return true
  } catch {
    return false
  }
}

/** 把普通数组转成 sqlite-vec 认识的 float32 blob。 */
export function toBlob(vector) {
  return new Uint8Array(Float32Array.from(vector).buffer)
}

export class MemoryStore {
  /**
   * @param {{ path: string, dims?: number }} options
   */
  constructor({ path, dims = 512, db = null }) {
    this.path = path
    this.dims = dims
    if (db) {
      // 复用灵魂库的连接：记忆和情绪住在同一个文件里
      this.db = db
    } else {
      mkdirSync(dirname(path), { recursive: true })
      const sqliteVec = require('sqlite-vec')
      this.db = new DatabaseSync(path, { allowExtension: true })
      this.db.loadExtension(sqliteVec.getLoadablePath())
    }
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    // 表结构由 migrations 负责（002_memory.sql），这里不再重复定义。
    // 之前这里建的表只有 8 列，缺 emotion / importance / pinned，
    // 一旦有人不传 db 独立构造，put() 就会 no such column。
    this.vecReady = true
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec
        USING vec0(embedding float[${dims}] distance_metric=cosine)
      `)
    } catch (error) {
      // 与 db.js 的承诺保持一致：没有向量扩展时，情绪模块不受影响。
      // 记忆检索退化为「永远查不到」，但整个插件不能因此加载失败。
      this.vecReady = false
      this.vecError = error?.message ?? String(error)
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS memory_session ON memory(session_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS memory_ts ON memory(ts)')

    // 关键词索引：FTS5 是 SQLite 内置，不需要扩展，所以和 memory_vec 一样
    // 在构造时补建，而不是放进 migrations（迁移只放普通表，且已有测试锁定 schema 版本号）。
    // 存的是 bigram 之后的文本（不是原文），所以不能用 content='memory'。
    this.ftsReady = true
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
        USING fts5(body, tokenize='unicode61')
      `)
    } catch (error) {
      this.ftsReady = false
      this.ftsError = error?.message ?? String(error)
    }

    this.stmtInsert = this.db.prepare(`
      INSERT OR IGNORE INTO memory(fingerprint, session_id, source, role, ref, ts, text, emotion, importance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    // 没有向量扩展时表不存在，连 prepare 都不能做
    this.stmtVec = this.vecReady
      ? this.db.prepare('INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)')
      : null
    this.stmtById = this.db.prepare('SELECT * FROM memory WHERE id = ?')
    this.stmtHas = this.db.prepare('SELECT 1 AS x FROM memory WHERE fingerprint = ?')
    this.stmtCount = this.db.prepare('SELECT COUNT(*) AS n FROM memory')
    this.stmtLastTs = this.db.prepare('SELECT MAX(ts) AS ts FROM memory')
  }

  /**
   * 一个写操作要么全落，要么全不落。
   *
   * 之前 put() 是两次独立写：先插主表（fingerprint UNIQUE），再插向量表。
   * 第二步失败时主表已经提交，同一条内容下次会被 INSERT OR IGNORE 静默跳过，
   * 于是这条记忆永远没有向量、永远检索不到，也永远无法重试。
   */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 可能已自动回滚
      }
      throw error
    }
  }

  /**
   * 写入一条并落向量；已存在（同指纹）时返回 null。
   * 主表与向量表在同一个事务里，不会出现「有正文没向量」的孤儿。
   * @param {{ fingerprint: string, sessionId?: string|null, source: string, role?: string|null, ref?: string|null, ts: number, text: string }} entry
   * @param {number[]} vector
   */
  /**
   * 最近 N 小时的对话切片，按时间倒序。
   *
   * 为什么要有这个：心跳/鲸梦跑在各自的会话里，上下文里没有聊天窗口的对话，
   * 向量检索又只会命中跟提示词语义相近的「心跳」类记忆，于是它以为「好几天没见」。
   * 这里按时间窗直接查（不走向量），把「他最近说过什么」注入进去。
   */
  recentChats({ hours = 48, limit = 6, now = Date.now() } = {}) {
    const since = now - hours * 3_600_000
    try {
      return this.db
        .prepare(`SELECT id, ts, session_id, text FROM memory
                  WHERE source = 'chat' AND deleted_at IS NULL AND ts >= ?
                  ORDER BY ts DESC LIMIT ?`)
        .all(since, Math.max(1, Number(limit) || 6))
    } catch {
      return []
    }
  }

  /** 库里是否已有这条切片（按指纹）。导入前先问一句，别白跑 embedding。 */
  has(fingerprint) {
    try {
      return Boolean(this.stmtHas.get(String(fingerprint)))
    } catch {
      return false
    }
  }

  put(entry, vector) {
    return this.tx(() => {
      const result = this.stmtInsert.run(
        entry.fingerprint,
        entry.sessionId ?? null,
        entry.source,
        entry.role ?? null,
        entry.ref ?? null,
        Math.trunc(entry.ts),
        entry.text,
        entry.emotion ?? null,
        entry.importance ?? 0.5,
      )
      if (!result.changes) return null
      const id = Number(result.lastInsertRowid)
      // 没有向量扩展时只存正文：检索查不到，但内容不丢，装上扩展后可以重建索引
      this.stmtVec?.run(BigInt(id), toBlob(vector))
      // 关键词索引与主表同一个事务：不会出现「有正文、搜不到」的记忆
      indexFts(this.db, id, entry.text)
      return id
    })
  }

  /** 批量写入，返回实际新增条数。 */
  putMany(items) {
    let added = 0
    for (const item of items) {
      if (this.put(item.entry, item.vector) !== null) added += 1
    }
    return added
  }

  /**
   * 向量近邻检索。
   * @param {number[]} vector
   * @param {number} k
   * @returns {Array<Record<string, unknown> & { distance: number }>}
   */
  search(vector, k = 24) {
    // 没有向量扩展：装得上正文，查不回来。宁可空结果，也不要抛错拖垮会话。
    if (!this.vecReady) return []
    const limit = Math.max(1, Math.min(200, Math.trunc(k)))
    const rows = this.db
      .prepare(`SELECT rowid AS id, distance FROM memory_vec WHERE embedding MATCH ? AND k = ${limit} ORDER BY distance`)
      .all(toBlob(vector))
    const out = []
    for (const row of rows) {
      const record = this.stmtById.get(BigInt(row.id))
      // 软删的条目向量还在，但不能再被检索出来
      if (record && !record.deleted_at) out.push({ ...record, distance: Number(row.distance) })
    }
    return out
  }

  /**
   * 关键词检索（FTS5 / BM25）。
   *
   * 向量路答不了命令名、路径、错误码这类精确词：它们在句子里占比太小，
   * 整句 embedding 被语义淹没（实测 18 个精确词 top-6 只中 5 个）。
   * @param {string|null} expr ftsQuery() 生成的安全表达式
   * @param {number} k
   * @returns {Array<Record<string, unknown> & { bm25: number }>}
   */
  searchFts(expr, k = 24) {
    if (!this.ftsReady || !expr) return []
    const limit = Math.max(1, Math.min(200, Math.trunc(k)))
    let rows
    try {
      // bm25 越小越相关（负值），按它升序就是 BM25 排序
      rows = this.db
        .prepare(`SELECT rowid AS id, bm25(memory_fts) AS score FROM memory_fts WHERE body MATCH ? ORDER BY score LIMIT ${limit}`)
        .all(expr)
    } catch {
      // 表达式异常时退化成只有向量一路，不拖垮本轮检索
      return []
    }
    const out = []
    for (const row of rows) {
      const record = this.stmtById.get(BigInt(row.id))
      if (record && !record.deleted_at) out.push({ ...record, bm25: Number(row.score) })
    }
    return out
  }

  /**
   * 清掉向量表里主表已不存在的行（真删之后残留的孤儿）。
   * 软删的条目**保留**向量（恢复时不用重新 embedding），它们仍在 memory 表里，不会被清掉。
   */
  pruneOrphanVectors() {
    if (!this.vecReady) return 0
    const result = this.db.prepare('DELETE FROM memory_vec WHERE rowid NOT IN (SELECT id FROM memory)').run()
    return Number(result.changes ?? 0)
  }

  /**
   * 清掉命中噪声标记的旧切片（连同向量与关键词索引）。
   * 规则变了、历史库脏了的时候，启动时自愈一次。
   */
  purgeNoise(markers) {
    if (!markers?.length) return 0
    const where = markers.map(() => 'text LIKE ?').join(' OR ')
    const params = markers.map((m) => `%${m}%`)
    return this.tx(() => this.#deleteWhere(where, params))
  }

  /** 删掉某个会话的全部切片（子 agent 会话不该进记忆）。 */
  deleteBySession(sessionId) {
    if (!sessionId) return 0
    return this.tx(() => this.#deleteWhere('session_id = ?', [sessionId]))
  }

  /** 按路径后缀删切片（比如不再进库的 MEMORY.md / AGENTS.md）。 */
  purgeByRefSuffix(suffixes) {
    if (!suffixes?.length) return 0
    const where = suffixes.map(() => 'ref LIKE ?').join(' OR ')
    const params = suffixes.map((suffix) => `%${suffix}`)
    try {
      return this.tx(() => this.#deleteWhere(where, params))
    } catch {
      return 0
    }
  }

  /** 删掉某个来源（文件）的全部旧切片，用于重建笔记索引。 */
  deleteByRef(ref) {
    return this.tx(() => this.#deleteWhere('ref = ?', [ref]))
  }

  /** 主表 + 向量表 + 关键词索引一起删，调用方负责事务。 */
  #deleteWhere(where, params) {
    const rows = this.db.prepare(`SELECT id FROM memory WHERE ${where}`).all(...params)
    if (!rows.length) return 0
    if (this.stmtVec) {
      const delVec = this.db.prepare('DELETE FROM memory_vec WHERE rowid = ?')
      for (const row of rows) {
        try {
          delVec.run(BigInt(row.id))
        } catch {
          // 向量行可能已经不在
        }
      }
    }
    for (const row of rows) dropFts(this.db, row.id)
    this.db.prepare(`DELETE FROM memory WHERE ${where}`).run(...params)
    return rows.length
  }

  /** 记一次访问：用于艾宾浩斯稳定度（想起来一次，就更难忘）。 */
  touch(ids, now = Date.now()) {
    if (!ids?.length) return 0
    // 被反复想起来的记忆显然有用：召回满 3 次就把重要度抬到 0.75，
    // 让它更难被遗忘曲线压下去，也免于被鲸梦判成可删。
    const stmt = this.db.prepare(
      `UPDATE memory
          SET access_count = access_count + 1,
              last_access = ?,
              importance = CASE
                WHEN access_count + 1 >= 3 AND importance < 0.75 THEN 0.75
                ELSE importance
              END
        WHERE id = ?`,
    )
    let n = 0
    for (const id of ids) {
      try {
        stmt.run(now, id)
        n += 1
      } catch {
        // 行可能已经被清掉
      }
    }
    return n
  }

  /** 现有条数与最新时间戳。 */
  stats() {
    const { n } = this.stmtCount.get()
    const { ts } = this.stmtLastTs.get()
    return { count: Number(n), lastTs: ts === null || ts === undefined ? null : Number(ts) }
  }

  close() {
    try {
      this.db.close()
    } catch {
      // 关闭失败不影响宿主退出
    }
  }
}
