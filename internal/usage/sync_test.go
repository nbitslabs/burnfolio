package usage

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestDailyTotalsSkipsInvalidSyncData(t *testing.T) {
	validDate := time.Now().UTC().Format("2006-01-02")
	report := Report{
		Segments: []Bucket{
			{DateUTC: validDate, Records: 2, Usage: TokenUsage{Input: 10, Output: 5}},
			{DateUTC: "1970-01-01", Records: 1, Usage: TokenUsage{Total: 99}},
			{DateUTC: "2026-02-31", Records: 1, Usage: TokenUsage{Total: 99}},
			{DateUTC: "2999-01-01", Records: 1, Usage: TokenUsage{Total: 99}},
			{DateUTC: "(unknown)", Records: 1, Usage: TokenUsage{Total: 99}},
			{DateUTC: validDate, Records: 1, Usage: TokenUsage{Total: -1}},
			{DateUTC: validDate, Records: maxSyncRecords + 1, Usage: TokenUsage{Total: 1}},
		},
	}

	days := DailyTotals(report)
	if len(days) != 1 {
		t.Fatalf("days = %d, want 1: %#v", len(days), days)
	}
	if days[0].DateUTC != validDate || days[0].Records != 2 || days[0].Usage.Burn() != 15 {
		t.Fatalf("bad day: %#v", days[0])
	}
}

func TestDailyTotalsSourcesSumToDayTotals(t *testing.T) {
	day1 := time.Now().UTC().Format("2006-01-02")
	day2 := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")

	events := []Event{
		{Provider: "anthropic", CLIType: "claude", DateUTC: day1, Model: "claude-opus-4-7", Usage: TokenUsage{Input: 100, Output: 50}},
		{Provider: "anthropic", CLIType: "claude", DateUTC: day1, Model: "claude-opus-4-7", Usage: TokenUsage{Input: 20, Output: 10}},
		{Provider: "openai", CLIType: "codex", DateUTC: day1, Model: "gpt-5.5", Usage: TokenUsage{Input: 200, Output: 80, Reasoning: 15}},
		{Provider: "openai", CLIType: "codex", DateUTC: day1, Model: "", Usage: TokenUsage{Input: 5}},
		{Provider: "sst", CLIType: "opencode", DateUTC: day2, Model: "GPT-5.5  ", Usage: TokenUsage{Input: 7, Output: 3}},
	}

	report := Report{Segments: summarizeSegments(events)}
	days := DailyTotals(report)

	if len(days) != 2 {
		t.Fatalf("days = %d, want 2: %#v", len(days), days)
	}

	for _, day := range days {
		if len(day.Sources) == 0 {
			t.Fatalf("day %s has no sources", day.DateUTC)
		}
		var sumRecords int
		var sumUsage TokenUsage
		for _, src := range day.Sources {
			if src.CLI == "" || src.Model == "" {
				t.Fatalf("source has empty cli/model: %#v", src)
			}
			if src.CLI != strings.ToLower(src.CLI) || src.Model != strings.ToLower(src.Model) {
				t.Fatalf("source not normalized to lowercase: %#v", src)
			}
			sumRecords += src.Records
			sumUsage.Add(src.Usage)
		}
		if sumRecords > day.Records {
			t.Fatalf("day %s: source records %d exceed day total %d", day.DateUTC, sumRecords, day.Records)
		}
		if sumUsage.Burn() > day.Usage.Burn() {
			t.Fatalf("day %s: source usage burn %d exceeds day total %d", day.DateUTC, sumUsage.Burn(), day.Usage.Burn())
		}
		// In this synthetic dataset every event carries a valid CLI, so
		// sources should account for every record and every token exactly.
		if sumRecords != day.Records || sumUsage.Burn() != day.Usage.Burn() {
			t.Fatalf("day %s: sources (%d records, %d burn) should equal day totals (%d records, %d burn)",
				day.DateUTC, sumRecords, sumUsage.Burn(), day.Records, day.Usage.Burn())
		}
	}

	// The two claude-opus-4-7 events on day1 should collapse into one
	// source row, and the empty-model codex event should normalize to
	// "unknown" rather than being dropped.
	day1Sources := map[string]SyncSource{}
	for _, day := range days {
		if day.DateUTC != day1 {
			continue
		}
		for _, src := range day.Sources {
			day1Sources[src.CLI+"/"+src.Model] = src
		}
	}
	claudeSrc, ok := day1Sources["claude/claude-opus-4-7"]
	if !ok || claudeSrc.Records != 2 || claudeSrc.Usage.Input != 120 || claudeSrc.Usage.Output != 60 {
		t.Fatalf("claude source = %#v", claudeSrc)
	}
	if _, ok := day1Sources["codex/unknown"]; !ok {
		t.Fatalf("expected codex/unknown source for the empty-model event: %#v", day1Sources)
	}

	// The whitespace/case-mangled model on day2 should normalize down to a
	// clean lowercase key.
	for _, day := range days {
		if day.DateUTC != day2 {
			continue
		}
		if len(day.Sources) != 1 || day.Sources[0].CLI != "opencode" || day.Sources[0].Model != "gpt-5.5" {
			t.Fatalf("day2 sources = %#v", day.Sources)
		}
	}
}

func TestDailyTotalsJSONShape(t *testing.T) {
	validDate := time.Now().UTC().Format("2006-01-02")
	report := Report{
		Segments: []Bucket{
			{CLIType: "claude", DateUTC: validDate, Model: "claude-opus-4-7", Records: 3, Usage: TokenUsage{Input: 10, Output: 5, CacheRead: 2, CacheWrite: 1, Reasoning: 0}},
		},
	}

	days := DailyTotals(report)
	if len(days) != 1 {
		t.Fatalf("days = %d, want 1", len(days))
	}

	raw, err := json.Marshal(days[0])
	if err != nil {
		t.Fatal(err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	for _, field := range []string{"date_utc", "records", "usage", "sources"} {
		if _, ok := decoded[field]; !ok {
			t.Fatalf("missing top-level field %q in %s", field, raw)
		}
	}

	sources, ok := decoded["sources"].([]any)
	if !ok || len(sources) != 1 {
		t.Fatalf("sources = %#v, want a single-element array", decoded["sources"])
	}
	source, ok := sources[0].(map[string]any)
	if !ok {
		t.Fatalf("source entry is not an object: %#v", sources[0])
	}
	for _, field := range []string{"cli", "model", "records", "usage"} {
		if _, ok := source[field]; !ok {
			t.Fatalf("missing source field %q in %s", field, raw)
		}
	}
	if source["cli"] != "claude" || source["model"] != "claude-opus-4-7" {
		t.Fatalf("source cli/model = %#v/%#v", source["cli"], source["model"])
	}
	usage, ok := source["usage"].(map[string]any)
	if !ok {
		t.Fatalf("source usage is not an object: %#v", source["usage"])
	}
	for _, field := range []string{"input", "output", "cache_read", "cache_write", "reasoning", "total"} {
		if _, ok := usage[field]; !ok {
			t.Fatalf("missing usage field %q in %s", field, raw)
		}
	}
}
