CREATE TABLE IF NOT EXISTS openrouter_daily_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  openrouter_key_hash TEXT NOT NULL,
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
  PRIMARY KEY (account_id, openrouter_key_hash, date_utc)
);

CREATE INDEX IF NOT EXISTS idx_openrouter_daily_usage_account_date
ON openrouter_daily_usage(account_id, date_utc);

CREATE TABLE IF NOT EXISTS openrouter_connections (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  openrouter_key_hash TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_nonce TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled')),
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(account_id, openrouter_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_openrouter_connections_due
ON openrouter_connections(status, last_sync_at);

INSERT OR REPLACE INTO global_daily_usage
  (date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records, updated_at)
SELECT
  date_utc,
  COALESCE((SELECT SUM(input_tokens) FROM daily_machine_usage d WHERE d.date_utc = dates.date_utc), 0) + COALESCE((SELECT SUM(input_tokens) FROM openrouter_daily_usage o WHERE o.date_utc = dates.date_utc), 0),
  COALESCE((SELECT SUM(cache_read_tokens) FROM daily_machine_usage d WHERE d.date_utc = dates.date_utc), 0) + COALESCE((SELECT SUM(cache_read_tokens) FROM openrouter_daily_usage o WHERE o.date_utc = dates.date_utc), 0),
  COALESCE((SELECT SUM(cache_write_tokens) FROM daily_machine_usage d WHERE d.date_utc = dates.date_utc), 0) + COALESCE((SELECT SUM(cache_write_tokens) FROM openrouter_daily_usage o WHERE o.date_utc = dates.date_utc), 0),
  COALESCE((SELECT SUM(output_tokens) FROM daily_machine_usage d WHERE d.date_utc = dates.date_utc), 0) + COALESCE((SELECT SUM(output_tokens) FROM openrouter_daily_usage o WHERE o.date_utc = dates.date_utc), 0),
  COALESCE((SELECT SUM(reasoning_tokens) FROM daily_machine_usage d WHERE d.date_utc = dates.date_utc), 0) + COALESCE((SELECT SUM(reasoning_tokens) FROM openrouter_daily_usage o WHERE o.date_utc = dates.date_utc), 0),
  COALESCE((SELECT SUM(total_tokens) FROM daily_machine_usage d WHERE d.date_utc = dates.date_utc), 0) + COALESCE((SELECT SUM(total_tokens) FROM openrouter_daily_usage o WHERE o.date_utc = dates.date_utc), 0),
  COALESCE((SELECT SUM(records) FROM daily_machine_usage d WHERE d.date_utc = dates.date_utc), 0) + COALESCE((SELECT SUM(records) FROM openrouter_daily_usage o WHERE o.date_utc = dates.date_utc), 0),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT date_utc FROM daily_machine_usage
  UNION
  SELECT date_utc FROM openrouter_daily_usage
) dates;

CREATE TRIGGER IF NOT EXISTS trg_global_openrouter_usage_insert
AFTER INSERT ON openrouter_daily_usage
BEGIN
  INSERT INTO global_daily_usage
    (date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records, updated_at)
  VALUES
    (NEW.date_utc, NEW.input_tokens, NEW.cache_read_tokens, NEW.cache_write_tokens, NEW.output_tokens, NEW.reasoning_tokens, NEW.total_tokens, NEW.records, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(date_utc) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    total_tokens = total_tokens + excluded.total_tokens,
    records = records + excluded.records,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_global_openrouter_usage_update
AFTER UPDATE ON openrouter_daily_usage
BEGIN
  INSERT INTO global_daily_usage
    (date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records, updated_at)
  VALUES
    (NEW.date_utc, NEW.input_tokens - OLD.input_tokens, NEW.cache_read_tokens - OLD.cache_read_tokens, NEW.cache_write_tokens - OLD.cache_write_tokens, NEW.output_tokens - OLD.output_tokens, NEW.reasoning_tokens - OLD.reasoning_tokens, NEW.total_tokens - OLD.total_tokens, NEW.records - OLD.records, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(date_utc) DO UPDATE SET
    input_tokens = MAX(0, input_tokens + excluded.input_tokens),
    cache_read_tokens = MAX(0, cache_read_tokens + excluded.cache_read_tokens),
    cache_write_tokens = MAX(0, cache_write_tokens + excluded.cache_write_tokens),
    output_tokens = MAX(0, output_tokens + excluded.output_tokens),
    reasoning_tokens = MAX(0, reasoning_tokens + excluded.reasoning_tokens),
    total_tokens = MAX(0, total_tokens + excluded.total_tokens),
    records = MAX(0, records + excluded.records),
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_global_openrouter_usage_delete
AFTER DELETE ON openrouter_daily_usage
BEGIN
  UPDATE global_daily_usage SET
    input_tokens = MAX(0, input_tokens - OLD.input_tokens),
    cache_read_tokens = MAX(0, cache_read_tokens - OLD.cache_read_tokens),
    cache_write_tokens = MAX(0, cache_write_tokens - OLD.cache_write_tokens),
    output_tokens = MAX(0, output_tokens - OLD.output_tokens),
    reasoning_tokens = MAX(0, reasoning_tokens - OLD.reasoning_tokens),
    total_tokens = MAX(0, total_tokens - OLD.total_tokens),
    records = MAX(0, records - OLD.records),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE date_utc = OLD.date_utc;
END;
