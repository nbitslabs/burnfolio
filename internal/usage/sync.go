package usage

import (
	"sort"
	"strings"
	"time"
)

const (
	maxSyncTokenField = int64(1_000_000_000_000)
	maxSyncRecords    = 1_000_000
	minSyncDate       = "2020-01-01"
	maxSyncFieldLen   = 200
)

// SyncSource is a per-CLI/per-model breakdown of a single synced day. It
// carries counts only (records + token usage) — no prompts, file paths, or
// session identifiers — so it's safe to send to the server.
type SyncSource struct {
	CLI     string     `json:"cli"`
	Model   string     `json:"model"`
	Records int        `json:"records"`
	Usage   TokenUsage `json:"usage"`
}

type SyncDay struct {
	DateUTC string       `json:"date_utc"`
	Records int          `json:"records"`
	Usage   TokenUsage   `json:"usage"`
	Sources []SyncSource `json:"sources,omitempty"`
}

func DailyTotals(report Report) []SyncDay {
	byDate := map[string]*SyncDay{}
	bySource := map[string]map[string]*SyncSource{}
	now := time.Now().UTC()
	for _, segment := range report.Segments {
		if !validSyncDate(segment.DateUTC, now) || !validSyncUsage(segment.Usage) || segment.Records < 0 || segment.Records > maxSyncRecords {
			continue
		}
		day := byDate[segment.DateUTC]
		if day == nil {
			day = &SyncDay{DateUTC: segment.DateUTC}
			byDate[segment.DateUTC] = day
		}
		if day.Records+segment.Records > maxSyncRecords || !canAddSyncUsage(day.Usage, segment.Usage) {
			continue
		}
		day.Records += segment.Records
		day.Usage.Add(segment.Usage)

		cli := normalizeSyncField(segment.CLIType)
		model := normalizeSyncModel(segment.Model)
		srcMap := bySource[segment.DateUTC]
		if srcMap == nil {
			srcMap = map[string]*SyncSource{}
			bySource[segment.DateUTC] = srcMap
		}
		key := cli + "\x00" + model
		src := srcMap[key]
		if src == nil {
			src = &SyncSource{CLI: cli, Model: model}
			srcMap[key] = src
		}
		src.Records += segment.Records
		src.Usage.Add(segment.Usage)
	}

	days := make([]SyncDay, 0, len(byDate))
	for _, day := range byDate {
		srcMap := bySource[day.DateUTC]
		sources := make([]SyncSource, 0, len(srcMap))
		for _, src := range srcMap {
			sources = append(sources, *src)
		}
		sort.Slice(sources, func(i, j int) bool {
			if sources[i].CLI != sources[j].CLI {
				return sources[i].CLI < sources[j].CLI
			}
			return sources[i].Model < sources[j].Model
		})
		day.Sources = sources
		days = append(days, *day)
	}
	sort.Slice(days, func(i, j int) bool {
		return days[i].DateUTC < days[j].DateUTC
	})
	return days
}

// normalizeSyncField trims and lowercases a free-form identifier (CLI/
// provider key) for the sync payload, capping its length and falling back
// to "unknown" when empty.
func normalizeSyncField(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return "unknown"
	}
	if len(value) > maxSyncFieldLen {
		value = value[:maxSyncFieldLen]
	}
	return value
}

// normalizeSyncModel is like normalizeSyncField but also treats the
// collector's own "(unknown)" placeholder as empty, so it maps to the same
// "unknown" value used for the sync payload.
func normalizeSyncModel(model string) string {
	model = strings.ToLower(strings.TrimSpace(model))
	if model == "" || model == "(unknown)" {
		return "unknown"
	}
	if len(model) > maxSyncFieldLen {
		model = model[:maxSyncFieldLen]
	}
	return model
}

func validSyncDate(value string, now time.Time) bool {
	if len(value) != len("2006-01-02") || value < minSyncDate {
		return false
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil || parsed.Format("2006-01-02") != value {
		return false
	}
	tomorrow := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	return !parsed.After(tomorrow)
}

func validSyncUsage(usage TokenUsage) bool {
	return syncTokenFieldOK(usage.Input) &&
		syncTokenFieldOK(usage.Output) &&
		syncTokenFieldOK(usage.CacheRead) &&
		syncTokenFieldOK(usage.CacheWrite) &&
		syncTokenFieldOK(usage.Reasoning) &&
		syncTokenFieldOK(usage.Total) &&
		syncTokenFieldOK(usage.Burn())
}

func canAddSyncUsage(left TokenUsage, right TokenUsage) bool {
	return left.Input <= maxSyncTokenField-right.Input &&
		left.Output <= maxSyncTokenField-right.Output &&
		left.CacheRead <= maxSyncTokenField-right.CacheRead &&
		left.CacheWrite <= maxSyncTokenField-right.CacheWrite &&
		left.Reasoning <= maxSyncTokenField-right.Reasoning &&
		left.Total <= maxSyncTokenField-right.Burn()
}

func syncTokenFieldOK(value int64) bool {
	return value >= 0 && value <= maxSyncTokenField
}
