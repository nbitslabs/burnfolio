package longwire

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

const testKey = "lw_mk_testkey"

func TestDailyUsageMapsDayAndModelRows(t *testing.T) {
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+testKey {
			t.Fatalf("authorization = %q", got)
		}
		if r.URL.Path != "/v1/management/usage" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		queries = append(queries, r.URL.RawQuery)
		if r.URL.Query().Get("group_by") == "model" {
			_, _ = w.Write([]byte(`{"view":"consumed","data":[
				{"date":"2026-10-01","model":"qwen3-coder","requests":42,"errors":0,"prompt_tokens":81234,"completion_tokens":9120,"total_tokens":90354},
				{"date":"2026-10-01","model":"Qwen/Qwen3-8B","requests":3,"errors":1,"prompt_tokens":1000,"completion_tokens":200,"total_tokens":1200},
				{"date":"2026-10-01","model":" qwen/qwen3-8b","requests":1,"errors":0,"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
			]}`))
			return
		}
		_, _ = w.Write([]byte(`{"view":"consumed","data":[
			{"date":"2026-10-01","requests":46,"errors":1,"prompt_tokens":82244,"completion_tokens":9325,"total_tokens":91569},
			{"date":"2026-10-02","requests":7,"errors":0,"prompt_tokens":500,"completion_tokens":50,"total_tokens":550}
		]}`))
	}))
	defer server.Close()

	days, warnings, err := Client{Key: testKey, BaseURL: server.URL}.DailyUsage(context.Background(), "2026-10-01", time.Date(2026, 10, 21, 18, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	wantQueries := []string{
		"end=2026-10-21&start=2026-10-01&tz=UTC&view=consumed",
		"end=2026-10-21&group_by=model&start=2026-10-01&tz=UTC&view=consumed",
	}
	if !reflect.DeepEqual(queries, wantQueries) {
		t.Fatalf("queries = %v", queries)
	}
	want := []Day{
		{DateUTC: "2026-10-01", Records: 46, Usage: Usage{Input: 82244, Output: 9325, Total: 91569}, Models: []Model{
			{Model: "qwen3-coder", Records: 42, Usage: Usage{Input: 81234, Output: 9120, Total: 90354}},
			{Model: "qwen/qwen3-8b", Records: 4, Usage: Usage{Input: 1010, Output: 205, Total: 1215}},
		}},
		{DateUTC: "2026-10-02", Records: 7, Usage: Usage{Input: 500, Output: 50, Total: 550}},
	}
	if !reflect.DeepEqual(days, want) {
		t.Fatalf("days = %#v", days)
	}
}

func TestWindowsChunkAt366InclusiveDays(t *testing.T) {
	got := Windows("2026-01-01", "2028-03-01")
	want := [][2]string{
		{"2026-01-01", "2027-01-01"},
		{"2027-01-02", "2028-01-02"},
		{"2028-01-03", "2028-03-01"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Windows = %v", got)
	}
	if got := Windows("2026-10-21", "2026-10-21"); !reflect.DeepEqual(got, [][2]string{{"2026-10-21", "2026-10-21"}}) {
		t.Fatalf("single day = %v", got)
	}
}

func TestDailyUsageClampsSinceToLaunch(t *testing.T) {
	var starts []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		starts = append(starts, r.URL.Query().Get("start"))
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	_, _, err := Client{Key: testKey, BaseURL: server.URL}.DailyUsage(context.Background(), "2020-01-01", time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(starts, []string{"2026-01-01", "2026-01-01"}) {
		t.Fatalf("starts = %v", starts)
	}
}

func TestPerModelFailureKeepsDayTotals(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("group_by") == "model" {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"boom","type":"server_error"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"date":"2026-10-01","requests":1,"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}]}`))
	}))
	defer server.Close()
	days, warnings, err := Client{Key: testKey, BaseURL: server.URL}.DailyUsage(context.Background(), "2026-10-01", time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(days) != 1 || days[0].Usage.Total != 15 || len(days[0].Models) != 0 {
		t.Fatalf("days = %#v", days)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "per-model") {
		t.Fatalf("warnings = %v", warnings)
	}
}

func TestRejectsInferenceKeysWithoutCallingTheAPI(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer server.Close()
	for _, key := range []string{"lw_sk_abc", "sk-or-v1-abc", ""} {
		_, _, err := Client{Key: key, BaseURL: server.URL}.DailyUsage(context.Background(), "", time.Now())
		if err == nil {
			t.Fatalf("key %q: expected error", key)
		}
	}
	if _, _, err := (Client{Key: "lw_sk_abc", BaseURL: server.URL}).DailyUsage(context.Background(), "", time.Now()); !strings.Contains(err.Error(), "inference key") {
		t.Fatalf("err = %v", err)
	}
	if calls != 0 {
		t.Fatalf("calls = %d, want 0", calls)
	}
}

func TestAuthErrorsAreReported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"message":"IP not allowed for this key","type":"invalid_request_error"}}`))
	}))
	defer server.Close()
	_, _, err := Client{Key: testKey, BaseURL: server.URL}.DailyUsage(context.Background(), "2026-10-01", time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden {
		t.Fatalf("err = %v", err)
	}
	if !strings.Contains(err.Error(), "IP not allowed") {
		t.Fatalf("err = %v", err)
	}
}
