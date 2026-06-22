ALTER TABLE magic_links ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';

UPDATE sessions
SET expires_at = datetime('now', '+30 days')
WHERE expires_at IS NULL;

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at
ON rate_limits(updated_at);
