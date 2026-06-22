CREATE TABLE IF NOT EXISTS global_daily_usage (
  date_utc TEXT PRIMARY KEY,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  records INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR REPLACE INTO global_daily_usage
  (date_utc, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, total_tokens, records, updated_at)
SELECT
  date_utc,
  SUM(input_tokens),
  SUM(cache_read_tokens),
  SUM(cache_write_tokens),
  SUM(output_tokens),
  SUM(reasoning_tokens),
  SUM(total_tokens),
  SUM(records),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM daily_machine_usage
GROUP BY date_utc;

CREATE TRIGGER IF NOT EXISTS trg_global_daily_usage_insert
AFTER INSERT ON daily_machine_usage
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

CREATE TRIGGER IF NOT EXISTS trg_global_daily_usage_update
AFTER UPDATE ON daily_machine_usage
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

CREATE TRIGGER IF NOT EXISTS trg_global_daily_usage_delete
AFTER DELETE ON daily_machine_usage
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
