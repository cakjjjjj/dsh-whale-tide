-- 004_config.sql —— 运行时可改的配置。
-- 只存覆盖项：没写过的键走代码里的默认值，方便升级。

CREATE TABLE IF NOT EXISTS tide_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,     -- JSON
  updated_ts INTEGER NOT NULL
);
