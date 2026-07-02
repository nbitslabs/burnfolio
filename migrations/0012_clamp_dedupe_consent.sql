ALTER TABLE memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending'));

CREATE INDEX IF NOT EXISTS idx_memberships_org_status ON memberships(org_id, status);

DROP TRIGGER IF EXISTS trg_global_daily_usage_insert;
DROP TRIGGER IF EXISTS trg_global_daily_usage_update;
DROP TRIGGER IF EXISTS trg_global_daily_usage_delete;
DROP TRIGGER IF EXISTS trg_global_openrouter_usage_insert;
DROP TRIGGER IF EXISTS trg_global_openrouter_usage_update;
DROP TRIGGER IF EXISTS trg_global_openrouter_usage_delete;
DROP TABLE IF EXISTS global_daily_usage;
