package usage

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func mustObject(t *testing.T, raw string) object {
	t.Helper()
	obj, err := decodeObject([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return obj
}

func TestParseClaudeEvent(t *testing.T) {
	obj := mustObject(t, `{"type":"assistant","timestamp":"2026-06-21T01:02:03Z","sessionId":"s1","requestId":"r1","message":{"model":"claude-opus-4-7","usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":40}}}`)

	event, ok := parseClaudeEvent("claude.jsonl", obj)
	if !ok {
		t.Fatal("expected event")
	}
	if event.CLIType != "claude" || event.Provider != "anthropic" || event.DateUTC != "2026-06-21" {
		t.Fatalf("bad dimensions: %#v", event)
	}
	if event.Usage.Burn() != 100 {
		t.Fatalf("burn = %d, want 100", event.Usage.Burn())
	}
}

func TestParseCodexEvent(t *testing.T) {
	obj := mustObject(t, `{"timestamp":"2026-06-21T14:41:42.508Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":120}}}}`)

	event, ok := parseCodexEvent("rollout.jsonl", obj, "gpt-5.5", "s1")
	if !ok {
		t.Fatal("expected event")
	}
	if event.CLIType != "codex" || event.Provider != "openai" || event.Model != "gpt-5.5" {
		t.Fatalf("bad dimensions: %#v", event)
	}
	if event.Usage.Burn() != 120 || event.Usage.CacheRead != 80 || event.Usage.Reasoning != 5 {
		t.Fatalf("bad usage: %#v", event.Usage)
	}
}

func TestParseCodexTotalDelta(t *testing.T) {
	first := mustObject(t, `{"timestamp":"2026-06-21T14:41:42Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":2,"total_tokens":132}}}}`)
	second := mustObject(t, `{"timestamp":"2026-06-21T14:42:42Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":180,"cached_input_tokens":50,"output_tokens":30,"reasoning_output_tokens":4,"total_tokens":264}}}}`)
	var previous TokenUsage

	event, ok := parseCodexEventWithPrevious("rollout.jsonl", first, "gpt-5.5", "s1", &previous)
	if !ok || event.Usage.Burn() != 132 {
		t.Fatalf("bad first event: ok=%t %#v", ok, event.Usage)
	}
	event, ok = parseCodexEventWithPrevious("rollout.jsonl", second, "gpt-5.5", "s1", &previous)
	if !ok {
		t.Fatal("expected second event")
	}
	if event.Usage.Input != 80 || event.Usage.CacheRead != 30 || event.Usage.Output != 20 || event.Usage.Reasoning != 2 || event.Usage.Burn() != 132 {
		t.Fatalf("bad delta usage: %#v", event.Usage)
	}
}

func TestParsePiEvent(t *testing.T) {
	obj := mustObject(t, `{"type":"message","timestamp":"2026-06-21T14:40:28.617Z","message":{"role":"assistant","provider":"openai-codex","model":"gpt-5.5","usage":{"input":1317,"output":11,"cacheRead":0,"cacheWrite":2,"totalTokens":1330,"cost":{"total":0.006915}}}}`)

	event, ok := parsePiEvent("pi.jsonl", obj)
	if !ok {
		t.Fatal("expected event")
	}
	if event.CLIType != "pi" || event.DateUTC != "2026-06-21" {
		t.Fatalf("bad dimensions: %#v", event)
	}
	if event.Usage.Burn() != 1330 || event.CostUSD == 0 {
		t.Fatalf("bad usage/cost: %#v cost=%f", event.Usage, event.CostUSD)
	}
}

func TestParseOpenCodeModernMessage(t *testing.T) {
	obj := mustObject(t, `{"id":"msg_1","sessionID":"s1","modelID":"gemini-3-pro-high","providerID":"google","time":{"created":1780000000000},"tokens":{"input":100,"output":20,"cache":{"read":30,"write":4},"total":154},"cost":0}`)

	event, ok := parseOpenCodeEvent("msg.json", obj)
	if !ok {
		t.Fatal("expected event")
	}
	if event.Provider != "google" || event.Model != "gemini-3-pro-high" || event.SessionID != "s1" {
		t.Fatalf("bad dimensions: %#v", event)
	}
	if event.Usage.Input != 100 || event.Usage.CacheRead != 30 || event.Usage.CacheWrite != 4 || event.Usage.Burn() != 154 {
		t.Fatalf("bad usage: %#v", event.Usage)
	}
}

func TestParseAdditionalJSONSources(t *testing.T) {
	tests := []struct {
		name  string
		parse objectParser
		raw   string
		cli   string
		burn  int64
	}{
		{
			name:  "qwen",
			parse: parseQwenObject,
			raw:   `{"timestamp":"2026-06-21T00:00:00Z","sessionId":"q1","model":"qwen3-coder","usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":40,"candidatesTokenCount":20,"thoughtsTokenCount":5,"totalTokenCount":165}}`,
			cli:   "qwen",
			burn:  165,
		},
		{
			name:  "gemini",
			parse: parseGeminiObject,
			raw:   `{"timestamp":"2026-06-21T00:00:00Z","sessionId":"g1","model":"gemini-3-flash","tokens":{"input":150,"cached":50,"output":25,"thoughts":10,"total":185}}`,
			cli:   "gemini",
			burn:  185,
		},
		{
			name:  "copilot",
			parse: parseCopilotObject,
			raw:   `{"type":"span","endTime":[1780000000,0],"attributes":{"gen_ai.response.model":"claude-sonnet-4","gen_ai.conversation.id":"c1","gen_ai.usage.input_tokens":100,"gen_ai.usage.cache_read.input_tokens":25,"gen_ai.usage.output_tokens":10,"gen_ai.usage.reasoning.output_tokens":3}}`,
			cli:   "copilot",
			burn:  113,
		},
		{
			name:  "kimi",
			parse: parseKimiObject,
			raw:   `{"type":"StatusUpdate","timestamp":"2026-06-21T00:00:00Z","token_usage":{"input_other":10,"input_cache_read":20,"input_cache_creation":30,"output":40}}`,
			cli:   "kimi",
			burn:  100,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			event, ok := tt.parse(tt.name+".jsonl", mustObject(t, tt.raw))
			if !ok {
				t.Fatal("expected event")
			}
			if event.CLIType != tt.cli || event.Usage.Burn() != tt.burn {
				t.Fatalf("bad event: %#v", event)
			}
		})
	}
}

func TestParseCopilotAndGeminiClampCacheSubtraction(t *testing.T) {
	// input < cacheRead is an edge case the source data shouldn't normally
	// produce, but when it does the old code skipped the subtraction
	// entirely (leaving input untouched), double-counting the cache tokens
	// in both Input and CacheRead. Input should now clamp to 0 instead.
	copilotObj := mustObject(t, `{"attributes":{"gen_ai.response.model":"claude-sonnet-4","gen_ai.usage.input_tokens":10,"gen_ai.usage.cache_read.input_tokens":25,"gen_ai.usage.output_tokens":5}}`)
	event, ok := parseCopilotObject("copilot.jsonl", copilotObj)
	if !ok {
		t.Fatal("expected copilot event")
	}
	if event.Usage.Input != 0 {
		t.Fatalf("copilot input = %d, want 0 (clamped)", event.Usage.Input)
	}
	if event.Usage.CacheRead != 25 {
		t.Fatalf("copilot cache_read = %d, want 25", event.Usage.CacheRead)
	}

	geminiObj := mustObject(t, `{"timestamp":"2026-06-21T00:00:00Z","sessionId":"g1","model":"gemini-3-flash","tokens":{"input":10,"cached":50,"output":25}}`)
	event, ok = parseGeminiObject("gemini.jsonl", geminiObj)
	if !ok {
		t.Fatal("expected gemini event")
	}
	if event.Usage.Input != 0 {
		t.Fatalf("gemini input = %d, want 0 (clamped)", event.Usage.Input)
	}
	if event.Usage.CacheRead != 50 {
		t.Fatalf("gemini cache_read = %d, want 50", event.Usage.CacheRead)
	}
}

func TestSQLiteReaders(t *testing.T) {
	dir := t.TempDir()
	hermesPath := filepath.Join(dir, "state.db")
	db, err := sql.Open("sqlite", hermesPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE sessions (
		id TEXT, model TEXT, billing_provider TEXT, started_at REAL, message_count INTEGER,
		input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
		reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL
	);
	INSERT INTO sessions VALUES ('h1', 'claude-sonnet-4', 'anthropic', 1780000000.0, 2, 10, 20, 30, 40, 5, 0.1, 0.2);`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	events, err := readHermesDB(hermesPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Usage.Burn() != 105 || events[0].CostUSD != 0.2 {
		t.Fatalf("bad hermes events: %#v", events)
	}

	kiloPath := filepath.Join(dir, "kilo.db")
	db, err = sql.Open("sqlite", kiloPath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE message (id TEXT, session_id TEXT, data TEXT);
	INSERT INTO message VALUES ('row1', 'k1', '{"role":"assistant","modelID":"gpt-5","providerID":"openai","time":{"created":1780000000000},"tokens":{"input":10,"output":20,"cache":{"read":30,"write":40},"reasoning":5}}');`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	events, err = readKiloDB(kiloPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Usage.Burn() != 105 {
		t.Fatalf("bad kilo events: %#v", events)
	}
}

func TestSQLiteReadersPreferUpdatedAtOverStartedAt(t *testing.T) {
	dir := t.TempDir()

	hermesPath := filepath.Join(dir, "state.db")
	db, err := sql.Open("sqlite", hermesPath)
	if err != nil {
		t.Fatal(err)
	}
	// started_at is day one of a multi-day session; updated_at is the last
	// activity, on a later day. If the reader still buckets by started_at,
	// DateUTC below will be wrong.
	_, err = db.Exec(`CREATE TABLE sessions (
		id TEXT, model TEXT, billing_provider TEXT, started_at REAL, updated_at REAL, message_count INTEGER,
		input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
		reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL
	);
	INSERT INTO sessions VALUES ('h1', 'claude-sonnet-4', 'anthropic', 1780000000.0, 1780300000.0, 2, 10, 20, 30, 40, 5, 0.1, 0.2);`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	events, err := readHermesDB(hermesPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("hermes events = %d, want 1", len(events))
	}
	wantDate := parseAnyTime(1780300000.0).UTC().Format("2006-01-02")
	if events[0].DateUTC != wantDate {
		t.Fatalf("hermes DateUTC = %q, want %q (should use updated_at, not started_at)", events[0].DateUTC, wantDate)
	}

	goosePath := filepath.Join(dir, "sessions.db")
	db, err = sql.Open("sqlite", goosePath)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE sessions (
		id TEXT, model_config_json TEXT, provider_name TEXT, created_at TEXT, updated_at TEXT,
		total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER,
		accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER
	);
	INSERT INTO sessions VALUES ('g1', '{"model_name":"gpt-5"}', 'openai', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z', 30, 10, 20, 0, 0, 0);`)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	events, err = readGooseDB(goosePath)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("goose events = %d, want 1", len(events))
	}
	if events[0].DateUTC != "2026-01-05" {
		t.Fatalf("goose DateUTC = %q, want 2026-01-05 (should use updated_at, not created_at)", events[0].DateUTC)
	}
}

func TestSummarizeSegments(t *testing.T) {
	events := []Event{
		{Provider: "openai", CLIType: "codex", DateUTC: "2026-06-21", Model: "gpt-5.5", SessionID: "s1", Source: "a", Usage: TokenUsage{Total: 10}},
		{Provider: "openai", CLIType: "codex", DateUTC: "2026-06-21", Model: "gpt-5.5", SessionID: "s1", Source: "a", Usage: TokenUsage{Total: 20}},
		{Provider: "anthropic", CLIType: "claude", DateUTC: "2026-06-20", Model: "claude", SessionID: "s2", Source: "b", Usage: TokenUsage{Input: 1, Output: 2}},
	}

	segments := summarizeSegments(events)
	if len(segments) != 2 {
		t.Fatalf("segments = %d, want 2", len(segments))
	}
	if segments[0].DateUTC != "2026-06-21" || segments[0].CLIType != "codex" || segments[0].Usage.Burn() != 30 {
		t.Fatalf("bad first segment: %#v", segments[0])
	}
}
