package usage

import (
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
