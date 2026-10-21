-- longwire (https://longwire.ai) usage, imported with read-only management keys.
-- Same shape as the OpenRouter tables (0010, 0014) so the two sources share
-- upsert/replace code, plus two scheduling columns on connections:
-- needs_reconnect stops the hourly cron after an auth failure (401/403) until
-- the key is reconnected or a manual sync succeeds, and next_attempt_at defers
-- the cron after a 429.
--
-- No global_daily_usage triggers: 0012 dropped that table and its OpenRouter
-- triggers, and global stats are computed on read (clamped, deduped per key).
-- longwire reaches them through the router_daily_usage view below.

CREATE TABLE IF NOT EXISTS longwire_daily_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  longwire_key_hash TEXT NOT NULL,
  date_utc TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'pyro' CHECK (source IN ('pyro', 'server')),
  updated_by_machine_id TEXT REFERENCES machines(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, longwire_key_hash, date_utc)
);

CREATE INDEX IF NOT EXISTS idx_longwire_daily_usage_account_date
ON longwire_daily_usage(account_id, date_utc);

CREATE TABLE IF NOT EXISTS longwire_daily_model_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  longwire_key_hash TEXT NOT NULL,
  date_utc TEXT NOT NULL,
  model TEXT NOT NULL,
  records INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, longwire_key_hash, date_utc, model)
);

CREATE INDEX IF NOT EXISTS idx_longwire_daily_model_usage_account_date
ON longwire_daily_model_usage(account_id, date_utc);

CREATE TABLE IF NOT EXISTS longwire_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  longwire_key_hash TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_nonce TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled')),
  needs_reconnect INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(account_id, longwire_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_longwire_connections_due
ON longwire_connections(status, last_sync_at);

-- Read-side union of every account-level router source. Profile, leaderboard,
-- badge and dashboard queries read these views; source_key is prefixed with the
-- provider so the per-key dedupe (same key connected to a user and an org)
-- never merges keys across providers.
CREATE VIEW IF NOT EXISTS router_daily_usage AS
SELECT 'openrouter' AS provider, 'openrouter:' || openrouter_key_hash AS source_key,
  account_id, date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records
FROM openrouter_daily_usage
UNION ALL
SELECT 'longwire' AS provider, 'longwire:' || longwire_key_hash AS source_key,
  account_id, date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records
FROM longwire_daily_usage;

CREATE VIEW IF NOT EXISTS router_daily_model_usage AS
SELECT 'openrouter' AS provider, 'openrouter:' || openrouter_key_hash AS source_key,
  account_id, date_utc, model, records, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens
FROM openrouter_daily_model_usage
UNION ALL
SELECT 'longwire' AS provider, 'longwire:' || longwire_key_hash AS source_key,
  account_id, date_utc, model, records, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens
FROM longwire_daily_model_usage;
