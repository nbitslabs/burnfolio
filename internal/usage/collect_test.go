package usage

import (
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
