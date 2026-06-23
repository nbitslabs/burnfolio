package usage

import (
	"sort"
	"strings"
	"time"
)

type Options struct {
	HomeDir    string
	Providers  map[string]bool
	MaxErrors  int
	IncludeRaw bool
}

const defaultProviderList = "amp,claude,codebuff,codex,copilot,droid,gemini,goose,hermes,kilo,kimi,openclaw,opencode,pi,qwen"

func DefaultProviderList() string {
	return defaultProviderList
}

type TokenUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
	Reasoning  int64 `json:"reasoning"`
	Total      int64 `json:"total"`
}

func (t TokenUsage) Burn() int64 {
	if t.Total > 0 {
		return t.Total
	}
	return t.Input + t.Output + t.CacheRead + t.CacheWrite + t.Reasoning
}

func (t *TokenUsage) Add(other TokenUsage) {
	t.Input += other.Input
	t.Output += other.Output
	t.CacheRead += other.CacheRead
	t.CacheWrite += other.CacheWrite
	t.Reasoning += other.Reasoning
	t.Total += other.Burn()
}

type Event struct {
	Provider  string     `json:"provider"`
	CLIType   string     `json:"cli_type"`
	DateUTC   string     `json:"date_utc"`
	Model     string     `json:"model"`
	Source    string     `json:"source,omitempty"`
	SessionID string     `json:"session_id,omitempty"`
	Timestamp *time.Time `json:"timestamp,omitempty"`
	Usage     TokenUsage `json:"usage"`
	CostUSD   float64    `json:"cost_usd,omitempty"`
}

type Bucket struct {
	Provider string     `json:"provider"`
	CLIType  string     `json:"cli_type,omitempty"`
	DateUTC  string     `json:"date_utc,omitempty"`
	Model    string     `json:"model"`
	Records  int        `json:"records"`
	Sessions int        `json:"sessions"`
	Files    int        `json:"files"`
	Usage    TokenUsage `json:"usage"`
	CostUSD  float64    `json:"cost_usd,omitempty"`

	sessionSet map[string]bool
	fileSet    map[string]bool
}

type ProviderReport struct {
	Provider string     `json:"provider"`
	Records  int        `json:"records"`
	Sessions int        `json:"sessions"`
	Files    int        `json:"files"`
	Usage    TokenUsage `json:"usage"`
	CostUSD  float64    `json:"cost_usd,omitempty"`
	Models   []Bucket   `json:"models"`
}

type Report struct {
	GeneratedAt time.Time        `json:"generated_at"`
	HomeDir     string           `json:"home_dir"`
	Providers   []ProviderReport `json:"providers"`
	Segments    []Bucket         `json:"segments"`
	Totals      TokenUsage       `json:"totals"`
	CostUSD     float64          `json:"cost_usd,omitempty"`
	Warnings    []string         `json:"warnings,omitempty"`
	Events      []Event          `json:"events,omitempty"`
}

func ParseProviderList(raw string) map[string]bool {
	selected := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		name := strings.ToLower(strings.TrimSpace(part))
		if name != "" {
			selected[name] = true
		}
	}
	return selected
}

func normalizeModel(model string) string {
	model = strings.TrimSpace(model)
	if model == "" {
		return "(unknown)"
	}
	return model
}

func eventDateUTC(ts *time.Time) string {
	if ts == nil {
		return "(unknown)"
	}
	return ts.UTC().Format("2006-01-02")
}

func sortedProviderNames(selected map[string]bool) []string {
	if len(selected) == 0 {
		return strings.Split(defaultProviderList, ",")
	}
	names := make([]string, 0, len(selected))
	for name := range selected {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
