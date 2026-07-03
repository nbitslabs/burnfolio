package openrouter

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

const analyticsURL = "https://openrouter.ai/api/v1/analytics/query"

// maxModelsPerDay caps how many per-model rows are sent for a single day.
// The server independently enforces its own cap; this just keeps the
// payload from growing unbounded for accounts with a very long tail of
// distinct models on a given day.
const maxModelsPerDay = 200

type Day struct {
	DateUTC string  `json:"date_utc"`
	Records int     `json:"records"`
	Usage   Usage   `json:"usage"`
	Models  []Model `json:"models,omitempty"`
}

// Model is a per-model breakdown of a single Day, counts only (no prompts,
// code, or transcripts — OpenRouter's analytics endpoint never returns
// those in the first place).
type Model struct {
	Model   string `json:"model"`
	Records int    `json:"records"`
	Usage   Usage  `json:"usage"`
}

type Usage struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	CacheRead int64 `json:"cache_read"`
	Reasoning int64 `json:"reasoning"`
	Total     int64 `json:"total"`
}

type Client struct {
	Key        string
	HTTPClient *http.Client
	BaseURL    string
}

// DailyUsage returns per-day OpenRouter usage (with a per-model breakdown
// on each day where available) between since and until. The returned
// warnings are non-fatal problems — e.g. the per-model breakdown query
// failing for one date range — that didn't prevent day totals from being
// collected.
func (c Client) DailyUsage(ctx context.Context, since string, until time.Time) ([]Day, []string, error) {
	key := strings.TrimSpace(c.Key)
	if key == "" {
		return nil, nil, fmt.Errorf("openrouter key is empty")
	}
	start, err := cleanSince(since)
	if err != nil {
		return nil, nil, err
	}
	end := until.UTC()
	if end.IsZero() {
		end = time.Now().UTC()
	}
	end = time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	cursor, _ := time.Parse("2006-01-02", start)
	var all []Day
	var warnings []string
	for cursor.Before(end) {
		chunkEnd := cursor.AddDate(0, 0, 366)
		if chunkEnd.After(end) {
			chunkEnd = end
		}
		days, chunkWarnings, err := c.dailyUsageRange(ctx, cursor.Format("2006-01-02"), chunkEnd)
		if err != nil {
			return nil, warnings, err
		}
		warnings = append(warnings, chunkWarnings...)
		all = append(all, days...)
		cursor = chunkEnd
	}
	return all, warnings, nil
}

func (c Client) dailyUsageRange(ctx context.Context, start string, end time.Time) ([]Day, []string, error) {
	dayRows, err := c.query(ctx, start, end, []string{})
	if err != nil {
		return nil, nil, err
	}

	days := make([]Day, 0, len(dayRows))
	for _, row := range dayRows {
		days = append(days, Day{
			DateUTC: row.DateDay,
			Records: int(row.RequestCount.Int64()),
			Usage:   usageFromRow(row),
		})
	}

	// The per-model breakdown is a second, separate query (same metrics and
	// time range, dimensioned by model). It's purely additive detail on top
	// of the day totals above, so a failure here must never fail the whole
	// import — just skip the breakdown and say why.
	var warnings []string
	modelRows, err := c.query(ctx, start, end, []string{"model"})
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("openrouter: per-model usage query failed, continuing with day totals only: %v", err))
		return days, warnings, nil
	}

	byDate := map[string][]Model{}
	for _, row := range modelRows {
		model := normalizeModelName(row.Model)
		if model == "" {
			model = normalizeModelName(row.ModelPermaslug)
		}
		if model == "" {
			continue
		}
		byDate[row.DateDay] = append(byDate[row.DateDay], Model{
			Model:   model,
			Records: int(row.RequestCount.Int64()),
			Usage:   usageFromRow(row),
		})
	}
	for i := range days {
		models := byDate[days[i].DateUTC]
		if len(models) == 0 {
			continue
		}
		sort.Slice(models, func(a, b int) bool { return models[a].Usage.Total > models[b].Usage.Total })
		if len(models) > maxModelsPerDay {
			models = models[:maxModelsPerDay]
		}
		days[i].Models = models
	}

	return days, warnings, nil
}

// usageFromRow builds a Usage from a query row, regardless of whether it
// came from the day-totals query or the per-model query — both request the
// same metrics, just with a different Dimensions split.
func usageFromRow(row queryRow) Usage {
	input := row.TokensPrompt.Int64()
	output := row.TokensCompletion.Int64()
	return Usage{
		Input:     input,
		Output:    output,
		CacheRead: row.CachedTokens.Int64(),
		Reasoning: row.ReasoningTokens.Int64(),
		// Standardized platform-wide: total = input + output. Reasoning
		// tokens are informational only (OpenRouter, like the other
		// providers, includes them in output). The analytics endpoint also
		// returns tokens_total (captured in TokensTotal below), but we
		// don't use it: it's redundant with input+output and OpenRouter
		// doesn't expose a cache write/prompt split here, so there's
		// nothing extra it would let us add.
		Total: input + output,
	}
}

// normalizeModelName trims, lowercases, and caps a model identifier from
// the analytics API for the sync payload, matching the normalization the
// day-level sync path uses for CLI/model fields.
func normalizeModelName(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if len(value) > 200 {
		value = value[:200]
	}
	return value
}

// query issues one analytics query (day totals when dimensions is empty,
// or a per-model breakdown when dimensions is ["model"]) and returns the
// raw rows.
func (c Client) query(ctx context.Context, start string, end time.Time, dimensions []string) ([]queryRow, error) {
	key := strings.TrimSpace(c.Key)
	body := queryRequest{
		Metrics:     []string{"request_count", "tokens_prompt", "tokens_completion", "reasoning_tokens", "cached_tokens", "tokens_total"},
		Dimensions:  dimensions,
		Granularity: "day",
		Limit:       3000,
		TimeRange: queryRange{
			Start: start + "T00:00:00Z",
			End:   end.Format(time.RFC3339),
		},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	endpoint := strings.TrimRight(c.BaseURL, "/")
	if endpoint == "" {
		endpoint = analyticsURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return nil, err
	}
	var decoded queryResponse
	if err := json.Unmarshal(responseBody, &decoded); err != nil {
		return nil, fmt.Errorf("unexpected OpenRouter response: %s", strings.TrimSpace(string(responseBody)))
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		if decoded.Error.Message != "" {
			return nil, fmt.Errorf("openrouter: %s", decoded.Error.Message)
		}
		return nil, fmt.Errorf("openrouter: %s", res.Status)
	}
	return decoded.Data.Data, nil
}

func KeyHash(key string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(key)))
	return hex.EncodeToString(sum[:])
}

func cleanSince(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "2020-01-01"
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil || parsed.Format("2006-01-02") != value {
		return "", fmt.Errorf("invalid OpenRouter since date")
	}
	if value < "2020-01-01" {
		return "2020-01-01", nil
	}
	return value, nil
}

type queryRequest struct {
	Metrics     []string   `json:"metrics"`
	Dimensions  []string   `json:"dimensions"`
	Granularity string     `json:"granularity"`
	Limit       int        `json:"limit"`
	TimeRange   queryRange `json:"time_range"`
}

type queryRange struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type queryResponse struct {
	Data struct {
		Data []queryRow `json:"data"`
	} `json:"data"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

type queryRow struct {
	DateDay          string     `json:"date__day"`
	RequestCount     jsonNumber `json:"request_count"`
	TokensPrompt     jsonNumber `json:"tokens_prompt"`
	TokensCompletion jsonNumber `json:"tokens_completion"`
	ReasoningTokens  jsonNumber `json:"reasoning_tokens"`
	CachedTokens     jsonNumber `json:"cached_tokens"`
	// TokensTotal is requested in dailyUsageRange's Metrics but currently
	// unused: it's redundant with TokensPrompt+TokensCompletion under the
	// input+output total standard. Captured here so it's not silently
	// dropped and is available if that changes.
	TokensTotal jsonNumber `json:"tokens_total"`
	// Model/ModelPermaslug are only populated when the query is dimensioned
	// by ["model"]; both empty on the plain day-totals query.
	Model          string `json:"model"`
	ModelPermaslug string `json:"model_permaslug"`
}

type jsonNumber string

func (n *jsonNumber) UnmarshalJSON(raw []byte) error {
	value := strings.Trim(string(raw), `"`)
	*n = jsonNumber(value)
	return nil
}

func (n jsonNumber) Int64() int64 {
	var value int64
	_, _ = fmt.Sscan(string(n), &value)
	return value
}
