package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nbitslabs/burnfolio/internal/usage"
)

// captureStderr redirects os.Stderr for the duration of fn and returns
// whatever was written to it.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = orig }()

	fn()

	_ = w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestSyncReportPostsDailyTotals(t *testing.T) {
	var gotAuth string
	var gotPayload syncPayload

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ingest" {
			t.Fatalf("path = %q, want /api/ingest", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q, want POST", r.Method)
		}
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(syncResult{OK: true, UpsertedDays: 2, SkippedDays: 1})
	}))
	defer server.Close()

	report := usage.Report{
		Segments: []usage.Bucket{
			{DateUTC: "2026-06-22", Records: 2, Usage: usage.TokenUsage{Input: 10, Output: 5}},
			{DateUTC: "2026-06-21", Records: 1, Usage: usage.TokenUsage{Total: 42}},
			{DateUTC: "2026-06-22", Records: 3, Usage: usage.TokenUsage{CacheRead: 7, CacheWrite: 8}},
			{DateUTC: "(unknown)", Records: 99, Usage: usage.TokenUsage{Total: 99}},
		},
	}

	result, err := syncReport(context.Background(), server.URL, "bf_profile", "bfm_secret", report)
	if err != nil {
		t.Fatal(err)
	}
	if result.UpsertedDays != 2 {
		t.Fatalf("upserted days = %d, want 2", result.UpsertedDays)
	}
	if result.SkippedDays != 1 {
		t.Fatalf("skipped days = %d, want 1", result.SkippedDays)
	}
	if gotAuth != "Bearer bfm_secret" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if gotPayload.Profile != "bf_profile" {
		t.Fatalf("profile = %q", gotPayload.Profile)
	}
	if gotPayload.PyroVersion == "" {
		t.Fatal("pyro version was not sent")
	}
	if len(gotPayload.Days) != 2 {
		t.Fatalf("days = %d, want 2: %#v", len(gotPayload.Days), gotPayload.Days)
	}
	if gotPayload.Days[0].DateUTC != "2026-06-21" || gotPayload.Days[0].Usage.Total != 42 || gotPayload.Days[0].Records != 1 {
		t.Fatalf("bad first day: %#v", gotPayload.Days[0])
	}
	if gotPayload.Days[1].DateUTC != "2026-06-22" || gotPayload.Days[1].Usage.Total != 30 || gotPayload.Days[1].Records != 5 {
		t.Fatalf("bad second day: %#v", gotPayload.Days[1])
	}
}

func TestSyncStatusIncludesSkippedDays(t *testing.T) {
	got := syncStatus(syncResult{UpsertedDays: 2, SkippedDays: 1})
	want := "ok: 2 days, 1 skipped"
	if got != want {
		t.Fatalf("status = %q, want %q", got, want)
	}
}

func TestFlagSetProvided(t *testing.T) {
	fs := flag.NewFlagSet("test", flag.ContinueOnError)
	providers := fs.String("providers", "all", "")
	if err := fs.Parse([]string{"--providers", "all"}); err != nil {
		t.Fatal(err)
	}
	if !flagSetProvided(fs, "providers") {
		t.Fatal("expected providers to be marked as provided")
	}
	if *providers != "all" {
		t.Fatalf("providers = %q", *providers)
	}
	if flagSetProvided(fs, "machine") {
		t.Fatal("did not expect machine to be marked as provided")
	}
}

func TestLoadConfigOrWarnSilentWhenConfigMissing(t *testing.T) {
	home := t.TempDir()
	stderr := captureStderr(t, func() {
		cfg := loadConfigOrWarn(home)
		if cfg.Installed {
			t.Fatalf("expected fresh-install defaults, got %#v", cfg)
		}
	})
	if stderr != "" {
		t.Fatalf("expected no warning for a missing config file, got %q", stderr)
	}
}

func TestLoadConfigOrWarnWarnsOnParseError(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".pyro"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath(home), []byte("{not valid json"), 0o600); err != nil {
		t.Fatal(err)
	}

	var cfg config
	stderr := captureStderr(t, func() {
		cfg = loadConfigOrWarn(home)
	})
	if !strings.Contains(stderr, configPath(home)) {
		t.Fatalf("expected warning mentioning %s, got %q", configPath(home), stderr)
	}
	// Do NOT abort: still usable, fresh-install-shaped defaults.
	if cfg.Server == "" || cfg.Providers == "" {
		t.Fatalf("expected defaults to be filled in despite the parse error: %#v", cfg)
	}
	if cfg.Installed {
		t.Fatalf("expected Installed=false after a parse error, got %#v", cfg)
	}
}

func TestCredentialsAlreadySaved(t *testing.T) {
	cases := []struct {
		name string
		cfg  config
		want bool
	}{
		{"neither set", config{}, false},
		{"only profile", config{Profile: "acct1"}, false},
		{"only machine", config{Machine: "tok"}, false},
		{"whitespace only", config{Profile: "  ", Machine: "  "}, false},
		{"both set", config{Profile: "acct1", Machine: "tok"}, true},
	}
	for _, tc := range cases {
		if got := credentialsAlreadySaved(tc.cfg); got != tc.want {
			t.Errorf("%s: credentialsAlreadySaved(%#v) = %v, want %v", tc.name, tc.cfg, got, tc.want)
		}
	}
}

func TestMaskedHandlesShortValues(t *testing.T) {
	cases := []struct {
		value string
		want  string
	}{
		{"", "(not configured)"},
		{"a", "*"},
		{"ab", "**"},
		{"abc", "***"},
		{"abcdefghijklm", "abcdefgh...jklm"},
	}
	for _, tc := range cases {
		if got := masked(tc.value); got != tc.want {
			t.Fatalf("masked(%q) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestSyncReportReturnsServerErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(syncResult{Error: "profile_machine_mismatch"})
	}))
	defer server.Close()

	_, err := syncReport(context.Background(), server.URL, "someone_else", "bfm_secret", usage.Report{})
	if err == nil {
		t.Fatal("expected error")
	}
	if err.Error() != "profile_machine_mismatch" {
		t.Fatalf("error = %q", err.Error())
	}
}
