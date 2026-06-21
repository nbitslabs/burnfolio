package usage

import (
	"fmt"
	"strings"
)

func FormatReport(report Report) string {
	var b strings.Builder

	fmt.Fprintf(&b, "Token burn by UTC date, CLI, and model\n")
	fmt.Fprintf(&b, "Generated: %s\n\n", report.GeneratedAt.Format("2006-01-02 15:04:05 UTC"))

	if len(report.Segments) == 0 {
		fmt.Fprintf(&b, "No usage records found.\n")
		return b.String()
	}

	fmt.Fprintf(&b, "%-10s  %-8s  %-34s  %7s  %8s  %12s  %12s  %12s  %12s  %12s  %10s\n",
		"UTC date", "CLI", "Model", "Records", "Sessions", "Input", "Cache read", "Cache write", "Output", "Total", "Cost")
	fmt.Fprintf(&b, "%s\n", strings.Repeat("-", 152))

	for _, row := range report.Segments {
		fmt.Fprintf(&b, "%-10s  %-8s  %-34s  %7d  %8d  %12s  %12s  %12s  %12s  %12s  %10s\n",
			row.DateUTC,
			row.CLIType,
			truncate(row.Model, 34),
			row.Records,
			row.Sessions,
			formatInt(row.Usage.Input),
			formatInt(row.Usage.CacheRead),
			formatInt(row.Usage.CacheWrite),
			formatInt(row.Usage.Output),
			formatInt(row.Usage.Burn()),
			formatCost(row.CostUSD),
		)
	}

	fmt.Fprintf(&b, "%s\n", strings.Repeat("-", 152))
	fmt.Fprintf(&b, "%-10s  %-8s  %-34s  %7s  %8s  %12s  %12s  %12s  %12s  %12s  %10s\n",
		"TOTAL", "", "", "", "",
		formatInt(report.Totals.Input),
		formatInt(report.Totals.CacheRead),
		formatInt(report.Totals.CacheWrite),
		formatInt(report.Totals.Output),
		formatInt(report.Totals.Burn()),
		formatCost(report.CostUSD),
	)

	return b.String()
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	if max <= 3 {
		return value[:max]
	}
	return value[:max-3] + "..."
}

func formatInt(value int64) string {
	raw := fmt.Sprintf("%d", value)
	if len(raw) <= 3 {
		return raw
	}
	var parts []string
	for len(raw) > 3 {
		parts = append([]string{raw[len(raw)-3:]}, parts...)
		raw = raw[:len(raw)-3]
	}
	parts = append([]string{raw}, parts...)
	return strings.Join(parts, ",")
}

func formatCost(value float64) string {
	if value == 0 {
		return "-"
	}
	return fmt.Sprintf("$%.4f", value)
}
