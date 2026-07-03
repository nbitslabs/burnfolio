CREATE TABLE IF NOT EXISTS account_badges (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  badge_key TEXT NOT NULL,
  earned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, badge_key)
);

CREATE INDEX IF NOT EXISTS idx_account_badges_earned_at ON account_badges(earned_at);
