ALTER TABLE users ADD COLUMN access_key_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_access_key_hash
ON users(access_key_hash)
WHERE access_key_hash IS NOT NULL;
