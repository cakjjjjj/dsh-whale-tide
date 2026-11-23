-- 001_init.sql —— 灵魂库的初始结构。
-- 规则：只增不删。后续改动一律新建 002_xxx.sql，不改这个文件。

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER NOT NULL,
  applied_at  INTEGER NOT NULL,
  note        TEXT
);

-- 当前情绪状态：只有一行（id = 1）
CREATE TABLE IF NOT EXISTS soul_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  dims        TEXT NOT NULL,   -- JSON: {joy:45, anger:30, ...}
  last_tick   INTEGER NOT NULL -- 上次结算的时间戳（ms）
);

-- 每一次改变情绪的事件：可回放、可审计
CREATE TABLE IF NOT EXISTS soul_event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,   -- praise / rebuke / conflict ...
  intensity   REAL NOT NULL,   -- 0.5 / 1.0 / 1.6
  delta       TEXT NOT NULL,   -- JSON: 实际变了多少
  dims_after  TEXT,            -- JSON: 事件后的完整快照
  why         TEXT,            -- 为什么（原话摘要）
  memory_id   INTEGER,         -- 关联的记忆条目，可空
  pinned      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_soul_event_ts ON soul_event(ts);

-- 会话结束时的状态快照：用来「带着当时的感觉回忆」
CREATE TABLE IF NOT EXISTS soul_snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  dims        TEXT NOT NULL,
  mood_line   TEXT,
  session_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_soul_snapshot_ts ON soul_snapshot(ts);
