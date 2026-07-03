ALTER TABLE accounts ADD COLUMN show_model_breakdown INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS openrouter_daily_model_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  openrouter_key_hash TEXT NOT NULL,
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
  PRIMARY KEY (account_id, openrouter_key_hash, date_utc, model)
);

CREATE INDEX IF NOT EXISTS idx_openrouter_daily_model_usage_account_date
ON openrouter_daily_model_usage(account_id, date_utc);
