package openrouter

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDailyUsageMapsAnalyticsRows(t *testing.T) {
	var gotAuth string
	var gotBody queryRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"data":{"data":[{"date__day":"2026-06-23","request_count":"2","tokens_prompt":"100","tokens_completion":"30","reasoning_tokens":"7","cached_tokens":"50","tokens_total":"130"}]}}`))
	}))
	defer server.Close()

	days, err := Client{Key: "sk-or-v1-test", BaseURL: server.URL}.DailyUsage(context.Background(), "2026-06-01", time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer sk-or-v1-test" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if gotBody.Granularity != "day" || gotBody.Limit != 3000 || gotBody.TimeRange.Start != "2026-06-01T00:00:00Z" {
		t.Fatalf("bad request body: %#v", gotBody)
	}
	if len(days) != 1 {
		t.Fatalf("days = %d, want 1", len(days))
	}
	day := days[0]
	if day.DateUTC != "2026-06-23" || day.Records != 2 {
		t.Fatalf("bad day dimensions: %#v", day)
	}
	if day.Usage.Input != 100 || day.Usage.Output != 30 || day.Usage.Reasoning != 7 || day.Usage.CacheRead != 50 || day.Usage.Total != 130 {
		t.Fatalf("bad usage: %#v", day.Usage)
	}
}

func TestDailyUsageTotalIsInputPlusOutputOnly(t *testing.T) {
	// Total must equal input+output regardless of how large reasoning_tokens
	// or tokens_total are in the response, matching the platform-wide
	// standard (reasoning is informational only, assumed included in
	// output).
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"data":[{"date__day":"2026-06-23","request_count":"1","tokens_prompt":"10","tokens_completion":"5","reasoning_tokens":"1000","cached_tokens":"2","tokens_total":"9999"}]}}`))
	}))
	defer server.Close()

	days, err := Client{Key: "sk-or-v1-test", BaseURL: server.URL}.DailyUsage(context.Background(), "2026-06-01", time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(days) != 1 {
		t.Fatalf("days = %d, want 1", len(days))
	}
	if got := days[0].Usage.Total; got != 15 {
		t.Fatalf("Total = %d, want 15 (input+output, ignoring reasoning_tokens and tokens_total)", got)
	}
}
