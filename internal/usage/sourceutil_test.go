package usage

import (
	"testing"
	"time"
)

func TestParseFlexibleTimeDoesNotMisreadDateStringsAsUnixSeconds(t *testing.T) {
	// Regression test: parseInt used to use fmt.Sscanf("%d", ...), which
	// accepts a digit *prefix* of an arbitrary string. "2026-01-05..."
	// would scan as the integer 2026 and get reinterpreted as a Unix
	// timestamp near the epoch, silently corrupting every zoned/zone-less
	// date string routed through parseFlexibleTime.
	got := parseFlexibleTime("2026-01-05T12:30:00Z")
	if got == nil {
		t.Fatal("expected a parsed time")
	}
	if got.Year() < 2000 {
		t.Fatalf("got = %v, want a 2026 date, not a near-epoch one", got)
	}
	if want := time.Date(2026, 1, 5, 12, 30, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("got = %v, want %v", got, want)
	}
}

func TestParseFlexibleTimeParsesZonelessTimestampsAsLocal(t *testing.T) {
	got := parseFlexibleTime("2026-01-05 12:30:00")
	if got == nil {
		t.Fatal("expected a parsed time")
	}
	want, err := time.ParseInLocation("2006-01-02 15:04:05", "2026-01-05 12:30:00", time.Local)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Equal(want) {
		t.Fatalf("got = %v, want %v (local zone, not UTC)", got, want)
	}
}

func TestParseFlexibleTimeStillParsesUnixSeconds(t *testing.T) {
	got := parseFlexibleTime("1780000000")
	if got == nil {
		t.Fatal("expected a parsed time")
	}
	if got.Year() < 2020 {
		t.Fatalf("got = %v, want a recent date from a real unix timestamp", got)
	}
}
