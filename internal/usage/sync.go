package usage

import "sort"

type SyncDay struct {
	DateUTC string     `json:"date_utc"`
	Records int        `json:"records"`
	Usage   TokenUsage `json:"usage"`
}

func DailyTotals(report Report) []SyncDay {
	byDate := map[string]*SyncDay{}
	for _, segment := range report.Segments {
		if segment.DateUTC == "" || segment.DateUTC == "(unknown)" {
			continue
		}
		day := byDate[segment.DateUTC]
		if day == nil {
			day = &SyncDay{DateUTC: segment.DateUTC}
			byDate[segment.DateUTC] = day
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
