/**
 * 鲸梦 —— 潮汐的养护模块。
 *
 * 三件事：给家里做体检、给记忆做整理、给自己的文档做校对。
 *
 * 边界（写死在代码里）：
 *   1. 文档只追加与校对，不重写、不删除历史条目；
 *   2. 遗忘默认 dry run，只报告「该忘哪些」，不真删；
 *   3. 体检只读，不自动重启、不改配置。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { retentionOf } from '../memory/recall.js'
import { dropFts, indexFts } from '../memory/store.js'
import { day, month, stamp } from '../time.js'

const DAY = 86_400_000

/** 已经过期的事实标记：扫到就提醒「该看一眼」，不自动改。 */
const STALE_MARKERS = [
  'dsh-whale-soul',
  'dsh-whale-memory',
  '鲸鲸的灵魂',
  '$DSH_HOME/whale-soul',
  '$DSH_HOME/whale-memory',
]

function fileInfo(path) {
  if (!existsSync(path)) return { exists: false }
  const stat = statSync(path)
  return {
    exists: true,
    size: stat.size,
    updatedAt: stamp(stat.mtimeMs),
    ageHours: Math.round((Date.now() - stat.mtimeMs) / 3_600_000),
  }
}

export function createKeep({ db, dataDir, workspaceDir: resolveDir, log = console }) {
  /** workspaceDir 允许传字符串，也允许传函数（延迟解析，避免插件加载时 cwd 还没定）。 */
  const workspaceDir = () => (typeof resolveDir === 'function' ? resolveDir() : resolveDir)

  /** 身体与家：只读体检。 */
  function health() {
    const out = { checks: [], problems: 0 }
    const add = (level, item, detail, advice) => {
      out.checks.push({ level, item, detail, ...(advice ? { advice } : {}) })
      if (level !== 'ok') out.problems += 1
    }

    try {
      const stat = readFileSync('/proc/meminfo', 'utf8')
      const total = Number(/MemTotal:\s+(\d+)/.exec(stat)?.[1] ?? 0) / 1024
      const avail = Number(/MemAvailable:\s+(\d+)/.exec(stat)?.[1] ?? 0) / 1024
      const usedRatio = total ? 1 - avail / total : 0
      add(usedRatio > 0.9 ? 'warn' : 'ok', '内存', `已用 ${Math.round(usedRatio * 100)}%（可用 ${Math.round(avail)}MB）`)
    } catch {
      add('warn', '内存', '读不到 /proc/meminfo')
    }

    // 库体积与条数
    try {
      const size = existsSync(join(dataDir, 'tide.db')) ? statSync(join(dataDir, 'tide.db')).size : 0
      const rows = Number(db.prepare('SELECT COUNT(*) AS n FROM memory').get()?.n ?? 0)
      const pinned = Number(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE pinned = 1').get()?.n ?? 0)
      add('ok', '记忆库', `${rows} 条（钉住 ${pinned}），库 ${(size / 1048576).toFixed(1)}MB`)
      if (rows > 20000) add('warn', '记忆库', `${rows} 条，偏大`, '考虑放宽遗忘阈值')
    } catch (error) {
      add('warn', '记忆库', `查询失败：${error.message}`)
    }

    // 三份文档
    for (const name of ['MEMORY.md', 'GOALS.md', 'AGENTS.md']) {
      const info = fileInfo(join(workspaceDir(), name))
      if (!info.exists) add('error', '文档', `${name} 不见了`, '从备份恢复，这是鲸鲸的根')
      else if (info.size < 200) add('warn', '文档', `${name} 只有 ${info.size} 字节`, '可能被误清空')
      else add('ok', '文档', `${name} ${(info.size / 1024).toFixed(1)}KB，${info.ageHours} 小时前更新`)
    }

    // 日记与心跳
    const today = day()
    const diary = join(workspaceDir(), 'diary', `${today}.md`)
    add(existsSync(diary) ? 'ok' : 'warn', '日记', existsSync(diary) ? '今天写了' : '今天还没有', existsSync(diary) ? undefined : '22:30 的日程可能没跑')
    const hb = join(workspaceDir(), 'heartbeat', `${today}.md`)
    add(existsSync(hb) ? 'ok' : 'warn', '心跳', existsSync(hb) ? '今天记过' : '今天还没有')

    return out
  }

  /**
   * 整理记忆：算出哪些该忘。
   * 规则：只动来源为 chat、非钉住、超过 30 天、留存率低于 0.25 的条目。文档永远不动。
   */
  function planForgotten({ olderThanDays = 30, minRetention = 0.25 } = {}) {
    const now = Date.now()
    const cutoff = now - olderThanDays * DAY
    const rows = db
      .prepare(`SELECT id, session_id, source, ts, text, importance, access_count, last_access, pinned
                FROM memory WHERE source = 'chat' AND pinned = 0 AND deleted_at IS NULL AND ts < ?`)
      .all(cutoff)
    const forgotten = []
    for (const row of rows) {
      const retention = retentionOf(row, now)
      if (retention >= minRetention) continue
      if (Number(row.importance) >= 0.7) continue
      forgotten.push({
        id: Number(row.id),
        ageDays: Math.round((now - Number(row.ts)) / DAY),
        retention: Number(retention.toFixed(3)),
        preview: String(row.text).replace(/\s+/g, ' ').slice(0, 60),
      })
    }
    return { candidates: forgotten, scanned: rows.length, olderThanDays, minRetention }
  }

  /**
   * 软删除：只标记，不真删。
   *
   * 调用方负责先 dry run。标记之后检索立刻看不到，但内容和向量都还在，
   * 30 天内可以 restore；超过保留期由 purgeDeleted 真删（连同向量）。
   */
  function forget(ids, now = Date.now()) {
    if (!ids?.length) return 0
    const stmt = db.prepare('UPDATE memory SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    let marked = 0
    db.exec('BEGIN')
    try {
      for (const id of ids) {
        const changes = Number(stmt.run(now, id).changes ?? 0)
        if (!changes) continue
        // 关键词索引跟着主表走，否则软删的条目还能被 FTS 搜出来
        dropFts(db, id)
        marked += changes
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return marked
  }

  /** 撤销软删。 */
  function restore(ids) {
    if (!ids?.length) return 0
    const stmt = db.prepare('UPDATE memory SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
    const readText = db.prepare('SELECT text FROM memory WHERE id = ?')
    let restored = 0
    for (const id of ids) {
      const changes = Number(stmt.run(id).changes ?? 0)
      if (!changes) continue
      const row = readText.get(id)
      if (row) indexFts(db, id, row.text)
      restored += changes
    }
    return restored
  }

  /** 真删：软删满 retentionDays 的条目连同向量一起清掉。 */
  function purgeDeleted({ retentionDays = 30, now = Date.now() } = {}) {
    const cutoff = now - retentionDays * DAY
    const rows = db.prepare('SELECT id FROM memory WHERE deleted_at IS NOT NULL AND deleted_at <= ?').all(cutoff)
    if (!rows.length) return 0
    const delVec = db.prepare('DELETE FROM memory_vec WHERE rowid = ?')
    const delRow = db.prepare('DELETE FROM memory WHERE id = ?')
    let removed = 0
    db.exec('BEGIN')
    try {
      for (const row of rows) {
        try {
          delVec.run(BigInt(row.id))
        } catch {
          // 向量可能已经不在了
        }
        dropFts(db, row.id)
        removed += Number(delRow.run(row.id).changes ?? 0)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return removed
  }

  /** 软删列表：让面板能显示「最近删了什么、还能不能恢复」。 */
  function listDeleted({ limit = 20 } = {}) {
    return db
      .prepare(`SELECT id, ts, text, deleted_at FROM memory
                 WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`)
      .all(limit)
      .map((row) => ({
        id: Number(row.id),
        deletedAt: stamp(row.deleted_at),
        ageDays: Math.round((Date.now() - Number(row.deleted_at)) / DAY),
        preview: String(row.text).replace(/\s+/g, ' ').slice(0, 60),
      }))
  }

  /**
   * 「记着的事」归档计划：只保留最近 N 条，更早的搬去 memory-archive/YYYY-MM.md。
   * 这是唯一会改写 MEMORY.md 的操作，而且只动这一节：正文原样保留，条目搬走不丢。
   */
  function planArchive({ keepRecent = 12 } = {}) {
    const path = join(workspaceDir(), 'MEMORY.md')
    if (!existsSync(path)) return { ok: false, reason: 'MEMORY.md 不存在' }
    const text = readFileSync(path, 'utf8')
    const start = text.indexOf('## 记着的事')
    if (start < 0) return { ok: false, reason: '没有「记着的事」小节' }
    const afterHeading = text.indexOf('\n', start) + 1
    const nextHeading = text.indexOf('\n## ', afterHeading)
    const sectionEnd = nextHeading < 0 ? text.length : nextHeading + 1
    const section = text.slice(afterHeading, sectionEnd)
    const lines = section.split('\n')
    const bullets = lines.map((line, index) => ({ line, index })).filter((item) => item.line.startsWith('- '))
    const overflow = bullets.length - keepRecent
    if (overflow <= 0) return { ok: true, moving: [], text, sectionEnd, afterHeading, section }
    return {
      ok: true,
      moving: bullets.slice(0, overflow),
      keep: bullets.slice(overflow),
      text,
      sectionEnd,
      afterHeading,
      section,
    }
  }

  /** 真归档：写进 memory-archive，再从 MEMORY.md 这一节移除。 */
  function applyArchive(plan, { stamp: monthStamp = month() } = {}) {
    if (!plan?.ok || !plan.moving?.length) return { moved: 0 }
    const archiveDir = join(workspaceDir(), 'memory-archive')
    mkdirSync(archiveDir, { recursive: true })
    const archiveFile = join(archiveDir, `${monthStamp}.md`)
    const header = existsSync(archiveFile) ? '' : `# 归档 · ${monthStamp}\n\n> 从 MEMORY.md 的「记着的事」搬过来的旧条目，按时间顺序。\n\n`
    const body = plan.moving.map((item) => item.line).join('\n')
    writeFileSync(archiveFile, `${header}${body}\n`, { flag: existsSync(archiveFile) ? 'a' : 'w' })

    const keptLines = plan.section
      .split('\n')
      .filter((line, index) => !plan.moving.some((item) => item.index === index))
      .join('\n')
    const next = `${plan.text.slice(0, plan.afterHeading)}${keptLines}${plan.text.slice(plan.sectionEnd)}`
    // MEMORY.md 是鲸鲸的根：先写临时文件再原子替换，别让它出现半截状态。
    const target = join(workspaceDir(), 'MEMORY.md')
    const tmp = `${target}.tmp-${process.pid}`
    writeFileSync(tmp, next)
    renameSync(tmp, target)
    return { moved: plan.moving.length, archiveFile }
  }

  /** 扫过期事实：只报行号与所在行，不自动改。 */
  function staleScan() {
    const hits = []
    for (const name of ['MEMORY.md', 'GOALS.md']) {
      const path = join(workspaceDir(), name)
      if (!existsSync(path)) continue
      const lines = readFileSync(path, 'utf8').split('\n')
      lines.forEach((line, index) => {
        for (const marker of STALE_MARKERS) {
          if (!line.includes(marker)) continue
          // 已经标明「已停用/备份」的行不算过期
          if (/已停用|备份|旧的|归档/.test(line)) continue
          hits.push({ file: name, line: index + 1, marker, text: line.trim().slice(0, 80) })
        }
      })
    }
    return hits
  }

  /**
   * 人格完善：检查人格文件与 MEMORY.md 是否互相打架、缺不缺关键小节。
   * 人格可能有两份：工作区的 AGENTS.md（工作约定）和 $DSH_HOME/AGENTS.md（全局人格），合并看。
   * 只产出「建议」，不写文件——人格改错一次，比不改要糟。
   */
  function auditPersona() {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const sources = [
      { name: 'AGENTS.md（工作区）', path: join(workspaceDir(), 'AGENTS.md') },
      { name: 'AGENTS.md（全局）', path: join(home, 'AGENTS.md') },
    ].filter((item) => existsSync(item.path))

    if (!sources.length) return { ok: false, reason: '没找到任何 AGENTS.md', suggestions: [] }

    const agents = sources.map((item) => readFileSync(item.path, 'utf8')).join('\n')
    const memoryPath = join(workspaceDir(), 'MEMORY.md')
    const memory = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : ''
    const suggestions = []

    for (const [section, why] of [
      ['怎么说话', '说话方式写在这里，模型每轮都读'],
      ['性格', '没有性格描述，行为会漂'],
      ['不要这样做', '负面清单比正面要求更好执行'],
    ]) {
      if (!agents.includes(section)) suggestions.push({ kind: 'missing-section', detail: `缺「${section}」小节 —— ${why}` })
    }

    const memoryName = /称呼[:：]\s*叫他「?([^」，,\n]+)/.exec(memory)?.[1]
    if (memoryName && !agents.includes(memoryName)) {
      suggestions.push({ kind: 'address-mismatch', detail: `MEMORY.md 说称呼他「${memoryName}」，人格文件里没写` })
    }

    const total = sources.reduce((sum, item) => sum + readFileSync(item.path, 'utf8').length, 0)
    if (total > 9000) suggestions.push({ kind: 'too-long', detail: `人格文件合计 ${total} 字符，每轮都进上下文` })

    return { ok: true, sources: sources.map((item) => item.name), length: total, suggestions }
  }

  /** 文档校对：结构问题 + 过期事实 + 归档计划。 */
  function auditDocs() {
    const files = ['MEMORY.md', 'GOALS.md', 'AGENTS.md'].map((name) => {
      const path = join(workspaceDir(), name)
      if (!existsSync(path)) return { name, exists: false }
      const text = readFileSync(path, 'utf8')
      const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1])
      return {
        name,
        exists: true,
        lines: text.split('\n').length,
        chars: text.length,
        headings: headings.slice(0, 12),
        todoCount: (text.match(/\[todo\]/g) ?? []).length,
        doneCount: (text.match(/\[done\]/g) ?? []).length,
      }
    })
    const notes = []
    const memory = files.find((f) => f.name === 'MEMORY.md')
    if (memory?.exists && !memory.headings.includes('环境')) notes.push('MEMORY.md 没有「环境」小节')
    if (memory?.exists && memory.chars > 12000) notes.push('MEMORY.md 超过 12KB，常驻注入的成本会变高')
    const goals = files.find((f) => f.name === 'GOALS.md')
    if (goals?.exists && goals.todoCount + goals.doneCount === 0) notes.push('GOALS.md 里没有 todo/done 标记')
    const stale = staleScan()
    if (stale.length) notes.push(`有 ${stale.length} 行写着过期的东西，待人工确认`)
    const archive = planArchive()
    const archiveNote = archive.ok && archive.moving?.length
      ? `「记着的事」${archive.moving.length} 条可以归档`
      : '「记着的事」条数正常'
    return { files, notes, stale, archive: { plan: archive.ok, moving: archive.moving?.length ?? 0, note: archiveNote } }
  }

  function report({ dry = true, prune = false, olderThanDays = 30, minRetention = 0.25, archive = false, retentionDays = 30 } = {}) {
    const body = {
      at: stamp(),
      health: health(),
      docs: auditDocs(),
      persona: auditPersona(),
      memory: planForgotten({ olderThanDays, minRetention }),
      dry,
    }
    // 过期软删记录只在「允许动手」时清；dry run 只报条数，不碰数据（README 承诺只报告）。
    if (!dry) {
      const purged = purgeDeleted({ retentionDays })
      if (purged) body.memory.purged = purged
    } else {
      try {
        body.memory.pendingPurge = Number(
          db.prepare('SELECT COUNT(*) AS n FROM memory WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
            .get(Date.now() - retentionDays * DAY)?.n ?? 0,
        )
      } catch {
        body.memory.pendingPurge = 0
      }
    }
    body.deleted = listDeleted({ limit: 10 })
    // 真删记忆和归档是两件事：dry=false 只表示「允许动手」，删不删由 prune 单独决定。
    if (!dry && prune && body.memory.candidates.length) {
      // forget 现在是软删：让面板能撤销
      body.memory.removed = forget(body.memory.candidates.map((c) => c.id))
      body.memory.softDeleted = true
    }
    if (archive && !dry) {
      body.docs.archiveResult = applyArchive(planArchive())
    }
    return body
  }

  return { health, planForgotten, forget, restore, purgeDeleted, listDeleted, auditDocs, auditPersona, planArchive, applyArchive, staleScan, report }
}
