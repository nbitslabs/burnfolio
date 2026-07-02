UPDATE machines SET token = NULL;
ALTER TABLE machines DROP COLUMN token;

CREATE TABLE magic_links_new (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  purpose TEXT NOT NULL DEFAULT 'login'
);

INSERT INTO magic_links_new (token_hash, user_id, email, created_at, expires_at, consumed_at, purpose)
SELECT token_hash, user_id, email, created_at, expires_at, consumed_at, purpose FROM magic_links;

DROP TABLE magic_links;
ALTER TABLE magic_links_new RENAME TO magic_links;

CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links (email);
