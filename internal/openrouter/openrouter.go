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
	"strings"
	"time"
)

const analyticsURL = "https://openrouter.ai/api/v1/analytics/query"

type Day struct {
	DateUTC string `json:"date_utc"`
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

func (c Client) DailyUsage(ctx context.Context, since string, until time.Time) ([]Day, error) {
	key := strings.TrimSpace(c.Key)
	if key == "" {
		return nil, fmt.Errorf("openrouter key is empty")
	}
	start, err := cleanSince(since)
	if err != nil {
		return nil, err
	}
	end := until.UTC()
	if end.IsZero() {
		end = time.Now().UTC()
	}
	end = time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	cursor, _ := time.Parse("2006-01-02", start)
	var all []Day
	for cursor.Before(end) {
		chunkEnd := cursor.AddDate(0, 0, 366)
		if chunkEnd.After(end) {
			chunkEnd = end
		}
		days, err := c.dailyUsageRange(ctx, cursor.Format("2006-01-02"), chunkEnd)
		if err != nil {
			return nil, err
		}
		all = append(all, days...)
		cursor = chunkEnd
	}
	return all, nil
}

func (c Client) dailyUsageRange(ctx context.Context, start string, end time.Time) ([]Day, error) {
	key := strings.TrimSpace(c.Key)
	body := queryRequest{
		Metrics:     []string{"request_count", "tokens_prompt", "tokens_completion", "reasoning_tokens", "cached_tokens", "tokens_total"},
		Dimensions:  []string{},
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
	days := make([]Day, 0, len(decoded.Data.Data))
	for _, row := range decoded.Data.Data {
		input := row.TokensPrompt.Int64()
		output := row.TokensCompletion.Int64()
		reasoning := row.ReasoningTokens.Int64()
		days = append(days, Day{
			DateUTC: row.DateDay,
			Records: int(row.RequestCount.Int64()),
			Usage: Usage{
				Input:     input,
				Output:    output,
				CacheRead: row.CachedTokens.Int64(),
				Reasoning: reasoning,
				Total:     input + output + reasoning,
			},
		})
	}
	return days, nil
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
