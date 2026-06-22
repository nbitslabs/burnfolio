PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS user_emails (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  verified_at TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, email)
);

INSERT OR IGNORE INTO user_emails (user_id, email, verified_at, is_primary, created_at)
SELECT id, email, email_verified_at, 1, COALESCE(email_verified_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM users
WHERE email IS NOT NULL AND email != '';

CREATE TABLE memberships_next (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin', 'owner')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (org_id, user_id)
);

INSERT INTO memberships_next (org_id, user_id, role, created_at)
SELECT
  m.org_id,
  m.user_id,
  CASE
    WHEN m.user_id = (
      SELECT m2.user_id
      FROM memberships m2
      WHERE m2.org_id = m.org_id
      ORDER BY CASE m2.role WHEN 'admin' THEN 0 ELSE 1 END, m2.created_at ASC, m2.user_id ASC
      LIMIT 1
    ) THEN 'owner'
    ELSE m.role
  END,
  m.created_at
FROM memberships m;

DROP TABLE memberships;
ALTER TABLE memberships_next RENAME TO memberships;

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_user_emails_email ON user_emails (email);
CREATE INDEX IF NOT EXISTS idx_user_emails_user ON user_emails (user_id);

PRAGMA foreign_keys = ON;
