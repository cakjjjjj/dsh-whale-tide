-- 005_memory_soft_delete.sql —— 软删除。
--
-- 之前 forget() 直接 DELETE，删错无法恢复。
-- 现在先标记 deleted_at（检索立刻看不到），30 天后由鲸梦真删；
-- 期间可以 restore。向量行保留，恢复时不用重新 embedding。

ALTER TABLE memory ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_memory_deleted ON memory(deleted_at);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory(importance);
