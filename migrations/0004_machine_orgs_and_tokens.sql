ALTER TABLE machines ADD COLUMN org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL;
ALTER TABLE machines ADD COLUMN token TEXT;

CREATE INDEX IF NOT EXISTS idx_machines_user_created
ON machines(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_machines_org
ON machines(org_id);
