-- 003_agency.sql —— 能动性的地基：私心、行动账本。
-- 只增不删：之前两版的表不动。

CREATE TABLE IF NOT EXISTS agency_desire (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_ts  INTEGER NOT NULL,
  text        TEXT NOT NULL,           -- 想做的事，自己写的
  why         TEXT,                    -- 为什么想
  weight      REAL NOT NULL DEFAULT 0.5,
  status      TEXT NOT NULL DEFAULT 'open',  -- open / done / dropped
  done_ts     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_desire_status ON agency_desire(status);

CREATE TABLE IF NOT EXISTS agency_action (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  kind        TEXT NOT NULL,           -- reach_out / share / task
  channel     TEXT,                    -- qq / bili_dm / session
  summary     TEXT NOT NULL,
  mood        TEXT,                    -- 当时的情绪快照
  result      TEXT NOT NULL DEFAULT 'planned'  -- planned / sent / failed / skipped
);

CREATE INDEX IF NOT EXISTS idx_action_ts ON agency_action(ts);
