package usage

import (
	"sort"
	"time"
)

const (
	maxSyncTokenField = int64(1_000_000_000_000)
	maxSyncRecords    = 1_000_000
	minSyncDate       = "2020-01-01"
)

type SyncDay struct {
	DateUTC string     `json:"date_utc"`
	Records int        `json:"records"`
	Usage   TokenUsage `json:"usage"`
}

func DailyTotals(report Report) []SyncDay {
	byDate := map[string]*SyncDay{}
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
	}

	days := make([]SyncDay, 0, len(byDate))
	for _, day := range byDate {
		days = append(days, *day)
	}
	sort.Slice(days, func(i, j int) bool {
		return days[i].DateUTC < days[j].DateUTC
	})
	return days
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
