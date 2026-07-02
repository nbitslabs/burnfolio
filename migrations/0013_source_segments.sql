CREATE TABLE IF NOT EXISTS daily_machine_source_usage (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date_utc TEXT NOT NULL,
  cli TEXT NOT NULL,
  model TEXT NOT NULL,
  records INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (machine_id, date_utc, cli, model)
);

CREATE INDEX IF NOT EXISTS idx_daily_machine_source_usage_user_date
ON daily_machine_source_usage(user_id, date_utc);
