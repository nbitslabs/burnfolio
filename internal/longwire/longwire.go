// Package longwire reads daily token usage from the longwire management API
// (https://longwire.ai) with a read-only management key (lw_mk_…), so pyro can
// upload daily totals without the key ever leaving the user's machine.
package longwire

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	defaultBaseURL = "https://longwire.ai"

	// Since is the earliest date worth asking for: longwire launched in 2026.
	Since = "2026-01-01"

	// windowDays is the most days the usage endpoint accepts per request
	// (start and end inclusive).
	windowDays = 366

	// maxModelsPerDay caps per-model rows per day, matching the server's cap.
	maxModelsPerDay = 200
)

type Day struct {
	DateUTC string  `json:"date_utc"`
	Records int     `json:"records"`
	Usage   Usage   `json:"usage"`
	Models  []Model `json:"models,omitempty"`
}

// Model is a per-model breakdown of a single Day: counts only. longwire's
// usage endpoint never returns prompts or completions.
type Model struct {
	Model   string `json:"model"`
	Records int    `json:"records"`
	Usage   Usage  `json:"usage"`
}

// Usage mirrors the burnfolio ingest shape. longwire doesn't track cache or
// reasoning tokens, so only input, output and total are set.
type Usage struct {
	Input  int64 `json:"input"`
	Output int64 `json:"output"`
	Total  int64 `json:"total"`
}

type Client struct {
	Key        string
	HTTPClient *http.Client
	BaseURL    string
}

// APIError is a non-2xx response from the management API.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string {
	hint := ""
	switch e.Status {
	case http.StatusUnauthorized:
		hint = " (the key is missing, unknown, revoked, or expired)"
	case http.StatusForbidden:
		hint = " (use a management key, check the key's IP lock, or check the account isn't suspended)"
	case http.StatusTooManyRequests:
		hint = " (rate limited; try again in a minute)"
	}
	if e.Message != "" {
		return fmt.Sprintf("longwire: %s%s", e.Message, hint)
	}
	return fmt.Sprintf("longwire: HTTP %d%s", e.Status, hint)
}

// CheckKey rejects keys that can't be management keys before any request.
func CheckKey(key string) error {
	key = strings.TrimSpace(key)
	switch {
	case key == "":
		return fmt.Errorf("longwire key is empty")
	case strings.HasPrefix(key, "lw_sk_"):
		return fmt.Errorf("that's a longwire inference key (lw_sk_…); create a read-only management key under API Keys → Management keys")
	case !strings.HasPrefix(key, "lw_mk_"):
		return fmt.Errorf("longwire management keys start with lw_mk_")
	}
	return nil
}

// DailyUsage returns per-UTC-day consumed usage between since and until
// (inclusive), with a per-model breakdown on each day where available. The
// returned warnings are non-fatal problems, e.g. the per-model query failing,
// that didn't prevent day totals from being collected.
func (c Client) DailyUsage(ctx context.Context, since string, until time.Time) ([]Day, []string, error) {
	if err := CheckKey(c.Key); err != nil {
		return nil, nil, err
	}
	start, err := cleanSince(since)
	if err != nil {
		return nil, nil, err
	}
	if until.IsZero() {
		until = time.Now()
	}
	end := until.UTC().Format("2006-01-02")
	var all []Day
	var warnings []string
	for _, window := range Windows(start, end) {
		days, windowWarnings, err := c.dailyUsageRange(ctx, window[0], window[1])
		if err != nil {
			return nil, warnings, err
		}
		warnings = append(warnings, windowWarnings...)
		all = append(all, days...)
	}
	return all, warnings, nil
}

// Windows splits the inclusive range [start, end] (YYYY-MM-DD) into
// consecutive inclusive windows of at most 366 days.
func Windows(start, end string) [][2]string {
	cursor, err := time.Parse("2006-01-02", start)
	if err != nil {
		return nil
	}
	last, err := time.Parse("2006-01-02", end)
	if err != nil {
		return nil
	}
	var windows [][2]string
	for !cursor.After(last) {
		windowEnd := cursor.AddDate(0, 0, windowDays-1)
		if windowEnd.After(last) {
			windowEnd = last
		}
		windows = append(windows, [2]string{cursor.Format("2006-01-02"), windowEnd.Format("2006-01-02")})
		cursor = windowEnd.AddDate(0, 0, 1)
	}
	return windows
}

func (c Client) dailyUsageRange(ctx context.Context, start, end string) ([]Day, []string, error) {
	dayRows, err := c.usage(ctx, start, end, false)
	if err != nil {
		return nil, nil, err
	}
	byDate := map[string]*Day{}
	var dates []string
	for _, row := range dayRows {
		date := row.Date
		if len(date) != 10 {
			continue
		}
		day, ok := byDate[date]
		if !ok {
			day = &Day{DateUTC: date}
			byDate[date] = day
			dates = append(dates, date)
		}
		day.Records += int(row.Requests)
		day.Usage = addUsage(day.Usage, usageFromRow(row))
	}

	// The per-model breakdown is a second request; it only adds detail to the
	// day totals above, so a failure here must never fail the import.
	var warnings []string
	modelRows, err := c.usage(ctx, start, end, true)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("longwire: per-model usage query failed, continuing with day totals only: %v", err))
		modelRows = nil
	}
	models := map[string]map[string]*Model{}
	for _, row := range modelRows {
		model := normalizeModelName(row.Model)
		if model == "" || byDate[row.Date] == nil {
			continue
		}
		if models[row.Date] == nil {
			models[row.Date] = map[string]*Model{}
		}
		m, ok := models[row.Date][model]
		if !ok {
			m = &Model{Model: model}
			models[row.Date][model] = m
		}
		m.Records += int(row.Requests)
		m.Usage = addUsage(m.Usage, usageFromRow(row))
	}

	days := make([]Day, 0, len(dates))
	for _, date := range dates {
		day := *byDate[date]
		for _, m := range models[date] {
			day.Models = append(day.Models, *m)
		}
		sort.Slice(day.Models, func(a, b int) bool {
			if day.Models[a].Usage.Total != day.Models[b].Usage.Total {
				return day.Models[a].Usage.Total > day.Models[b].Usage.Total
			}
			return day.Models[a].Model < day.Models[b].Model
		})
		if len(day.Models) > maxModelsPerDay {
			day.Models = day.Models[:maxModelsPerDay]
		}
		days = append(days, day)
	}
	return days, warnings, nil
}

// usageFromRow applies burnfolio's total = input + output; longwire's own
// total_tokens is the same sum, so it isn't needed.
func usageFromRow(row usageRow) Usage {
	return Usage{Input: row.PromptTokens, Output: row.CompletionTokens, Total: row.PromptTokens + row.CompletionTokens}
}

func addUsage(a, b Usage) Usage {
	return Usage{Input: a.Input + b.Input, Output: a.Output + b.Output, Total: a.Total + b.Total}
}

// normalizeModelName trims, lowercases, and caps a model name the same way
// the OpenRouter import and the server do.
func normalizeModelName(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if len(value) > 200 {
		value = value[:200]
	}
	return value
}

func (c Client) usage(ctx context.Context, start, end string, byModel bool) ([]usageRow, error) {
	params := url.Values{}
	params.Set("start", start)
	params.Set("end", end)
	params.Set("tz", "UTC")
	params.Set("view", "consumed")
	if byModel {
		params.Set("group_by", "model")
	}
	var decoded usageResponse
	if err := c.get(ctx, "/v1/management/usage?"+params.Encode(), &decoded); err != nil {
		return nil, err
	}
	return decoded.Data, nil
}

func (c Client) get(ctx context.Context, path string, out any) error {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = defaultBaseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.Key))
	req.Header.Set("Accept", "application/json")
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var apiErr errorResponse
		_ = json.Unmarshal(body, &apiErr)
		return &APIError{Status: res.StatusCode, Message: strings.TrimSpace(apiErr.Error.Message)}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("unexpected longwire response: %s", strings.TrimSpace(string(body)))
	}
	return nil
}

func KeyHash(key string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(key)))
	return hex.EncodeToString(sum[:])
}

func cleanSince(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = Since
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil || parsed.Format("2006-01-02") != value {
		return "", fmt.Errorf("invalid longwire since date")
	}
	if value < Since {
		return Since, nil
	}
	return value, nil
}

type usageResponse struct {
	Data []usageRow `json:"data"`
}

type usageRow struct {
	Date             string `json:"date"`
	Model            string `json:"model"`
	Requests         int64  `json:"requests"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
}

type errorResponse struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}
