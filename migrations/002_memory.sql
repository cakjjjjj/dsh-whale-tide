-- 002_memory.sql —— 把长效记忆并进灵魂库。
-- 只增不删：旧的 soul_* 表不动，新增记忆相关的表与字段。

CREATE TABLE IF NOT EXISTS memory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint  TEXT NOT NULL UNIQUE,
  session_id   TEXT,
  source       TEXT NOT NULL,      -- chat / doc
  role         TEXT,
  ref          TEXT,
  ts           INTEGER NOT NULL,
  text         TEXT NOT NULL,
  -- 002 新增：遗忘曲线需要的字段
  importance   REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access  INTEGER,
  pinned       INTEGER NOT NULL DEFAULT 0,
  emotion      TEXT                -- 写入时的情绪快照 JSON
);

CREATE INDEX IF NOT EXISTS idx_memory_ts ON memory(ts);
CREATE INDEX IF NOT EXISTS idx_memory_session ON memory(session_id);
CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory(pinned);
