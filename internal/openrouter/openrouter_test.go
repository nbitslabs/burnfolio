package openrouter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

	days, warnings, err := Client{Key: "sk-or-v1-test", BaseURL: server.URL}.DailyUsage(context.Background(), "2026-06-01", time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
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

	days, _, err := Client{Key: "sk-or-v1-test", BaseURL: server.URL}.DailyUsage(context.Background(), "2026-06-01", time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC))
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

func TestDailyUsageIncludesPerModelBreakdown(t *testing.T) {
	var gotDimensions [][]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body queryRequest
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		gotDimensions = append(gotDimensions, body.Dimensions)

		if len(body.Dimensions) == 0 {
			_, _ = w.Write([]byte(`{"data":{"data":[{"date__day":"2026-06-23","request_count":"3","tokens_prompt":"150","tokens_completion":"50","reasoning_tokens":"0","cached_tokens":"0","tokens_total":"200"}]}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":{"data":[
			{"date__day":"2026-06-23","request_count":"2","tokens_prompt":"100","tokens_completion":"30","reasoning_tokens":"0","cached_tokens":"0","model":"Anthropic/Claude-3.5-Sonnet"},
			{"date__day":"2026-06-23","request_count":"1","tokens_prompt":"50","tokens_completion":"20","reasoning_tokens":"0","cached_tokens":"0","model_permaslug":"openai/gpt-4o"}
		]}}`))
	}))
	defer server.Close()

	days, warnings, err := Client{Key: "sk-or-v1-test", BaseURL: server.URL}.DailyUsage(context.Background(), "2026-06-01", time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}

	// One query with no dimensions (day totals) and one with ["model"].
	foundEmpty, foundModel := false, false
	for _, dims := range gotDimensions {
		if len(dims) == 0 {
			foundEmpty = true
		}
		if len(dims) == 1 && dims[0] == "model" {
			foundModel = true
		}
	}
	if !foundEmpty || !foundModel {
		t.Fatalf("expected one query with no dimensions and one with [\"model\"], got %v", gotDimensions)
	}

	if len(days) != 1 {
		t.Fatalf("days = %d, want 1", len(days))
	}
	day := days[0]
	if len(day.Models) != 2 {
		t.Fatalf("models = %d, want 2: %#v", len(day.Models), day.Models)
	}
	// Sorted by Total descending: claude (130) before gpt-4o (70).
	if day.Models[0].Model != "anthropic/claude-3.5-sonnet" || day.Models[0].Records != 2 || day.Models[0].Usage.Input != 100 || day.Models[0].Usage.Output != 30 || day.Models[0].Usage.Total != 130 {
		t.Fatalf("bad first model row: %#v", day.Models[0])
	}
	if day.Models[1].Model != "openai/gpt-4o" || day.Models[1].Records != 1 || day.Models[1].Usage.Total != 70 {
		t.Fatalf("bad second model row (should fall back to model_permaslug): %#v", day.Models[1])
	}
}

func TestDailyUsageModelQueryFailureFallsBackToDayTotals(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body queryRequest
		raw, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Dimensions) == 0 {
			_, _ = w.Write([]byte(`{"data":{"data":[{"date__day":"2026-06-23","request_count":"2","tokens_prompt":"100","tokens_completion":"30","reasoning_tokens":"0","cached_tokens":"0"}]}}`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
	}))
	defer server.Close()

	days, warnings, err := Client{Key: "sk-or-v1-test", BaseURL: server.URL}.DailyUsage(context.Background(), "2026-06-01", time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("expected day totals to succeed despite the model query failing, got error: %v", err)
	}
	if len(days) != 1 || days[0].Records != 2 || days[0].Usage.Total != 130 {
		t.Fatalf("day totals should still be present: %#v", days)
	}
	if len(days[0].Models) != 0 {
		t.Fatalf("expected no per-model breakdown when the model query fails, got %#v", days[0].Models)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "per-model") {
		t.Fatalf("expected one warning mentioning the per-model query, got %v", warnings)
	}
}
