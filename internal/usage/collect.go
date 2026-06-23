package usage

import (
	"context"
	"fmt"
	"sort"
	"time"
)

type collector func(context.Context, Options) ([]Event, []string, error)

var collectors = map[string]collector{
	"amp":      collectAmp,
	"claude":   collectClaude,
	"codebuff": collectCodebuff,
	"codex":    collectCodex,
	"copilot":  collectCopilot,
	"droid":    collectDroid,
	"gemini":   collectGemini,
	"goose":    collectGoose,
	"hermes":   collectHermes,
	"kilo":     collectKilo,
	"kimi":     collectKimi,
	"openclaw": collectOpenClaw,
	"opencode": collectOpenCode,
	"pi":       collectPi,
	"qwen":     collectQwen,
}

func Collect(ctx context.Context, opts Options) (Report, error) {
	if opts.MaxErrors <= 0 {
		opts.MaxErrors = 20
	}

	report := Report{
		GeneratedAt: time.Now().UTC(),
		HomeDir:     opts.HomeDir,
	}

	var events []Event
	for _, name := range sortedProviderNames(opts.Providers) {
		collect, ok := collectors[name]
		if !ok {
			report.Warnings = append(report.Warnings, fmt.Sprintf("unknown provider %q", name))
			continue
		}
		providerEvents, warnings, err := collect(ctx, opts)
		report.Warnings = append(report.Warnings, warnings...)
		if err != nil {
			report.Warnings = append(report.Warnings, fmt.Sprintf("%s: %v", name, err))
		}
		events = append(events, providerEvents...)
	}

	report.Providers = summarize(events)
	report.Segments = summarizeSegments(events)
	for _, provider := range report.Providers {
		report.Totals.Add(provider.Usage)
		report.CostUSD += provider.CostUSD
	}
	if opts.IncludeRaw {
		report.Events = events
	}
	return report, nil
}

func summarize(events []Event) []ProviderReport {
	byProvider := map[string]*ProviderReport{}
	byModel := map[string]map[string]*Bucket{}
	providerSessions := map[string]map[string]bool{}
	providerFiles := map[string]map[string]bool{}

	for _, event := range events {
		provider := event.Provider
		model := normalizeModel(event.Model)

		pr := byProvider[provider]
		if pr == nil {
			pr = &ProviderReport{Provider: provider}
			byProvider[provider] = pr
			byModel[provider] = map[string]*Bucket{}
			providerSessions[provider] = map[string]bool{}
			providerFiles[provider] = map[string]bool{}
		}

		pr.Records++
		pr.Usage.Add(event.Usage)
		pr.CostUSD += event.CostUSD
		if event.SessionID != "" {
			providerSessions[provider][event.SessionID] = true
		}
		if event.Source != "" {
			providerFiles[provider][event.Source] = true
		}

		bucket := byModel[provider][model]
		if bucket == nil {
			bucket = &Bucket{
				Provider:   provider,
				Model:      model,
				sessionSet: map[string]bool{},
				fileSet:    map[string]bool{},
			}
			byModel[provider][model] = bucket
		}
		bucket.Records++
		bucket.Usage.Add(event.Usage)
		bucket.CostUSD += event.CostUSD
		if event.SessionID != "" {
			bucket.sessionSet[event.SessionID] = true
		}
		if event.Source != "" {
			bucket.fileSet[event.Source] = true
		}
	}

	providers := make([]ProviderReport, 0, len(byProvider))
	for provider, pr := range byProvider {
		pr.Sessions = len(providerSessions[provider])
		pr.Files = len(providerFiles[provider])

		models := make([]Bucket, 0, len(byModel[provider]))
		for _, bucket := range byModel[provider] {
			bucket.Sessions = len(bucket.sessionSet)
			bucket.Files = len(bucket.fileSet)
			bucket.sessionSet = nil
			bucket.fileSet = nil
			models = append(models, *bucket)
		}
		sort.Slice(models, func(i, j int) bool {
			left := models[i].Usage.Burn()
			right := models[j].Usage.Burn()
			if left == right {
				return models[i].Model < models[j].Model
			}
			return left > right
		})
		pr.Models = models
		providers = append(providers, *pr)
	}

	sort.Slice(providers, func(i, j int) bool {
		return providers[i].Provider < providers[j].Provider
	})
	return providers
}

func summarizeSegments(events []Event) []Bucket {
	buckets := map[string]*Bucket{}

	for _, event := range events {
		dateUTC := event.DateUTC
		if dateUTC == "" {
			dateUTC = eventDateUTC(event.Timestamp)
		}
		cliType := event.CLIType
		if cliType == "" {
			cliType = event.Provider
		}
		model := normalizeModel(event.Model)
		key := dateUTC + "\x00" + cliType + "\x00" + model

		bucket := buckets[key]
		if bucket == nil {
			bucket = &Bucket{
				Provider:   event.Provider,
				CLIType:    cliType,
				DateUTC:    dateUTC,
				Model:      model,
				sessionSet: map[string]bool{},
				fileSet:    map[string]bool{},
			}
			buckets[key] = bucket
		}
		bucket.Records++
		bucket.Usage.Add(event.Usage)
		bucket.CostUSD += event.CostUSD
		if event.SessionID != "" {
			bucket.sessionSet[event.SessionID] = true
		}
		if event.Source != "" {
			bucket.fileSet[event.Source] = true
		}
	}

	segments := make([]Bucket, 0, len(buckets))
	for _, bucket := range buckets {
		bucket.Sessions = len(bucket.sessionSet)
		bucket.Files = len(bucket.fileSet)
		bucket.sessionSet = nil
		bucket.fileSet = nil
		segments = append(segments, *bucket)
	}

	sort.Slice(segments, func(i, j int) bool {
		if segments[i].DateUTC != segments[j].DateUTC {
			return segments[i].DateUTC > segments[j].DateUTC
		}
		if segments[i].CLIType != segments[j].CLIType {
			return segments[i].CLIType < segments[j].CLIType
		}
		if segments[i].Usage.Burn() != segments[j].Usage.Burn() {
			return segments[i].Usage.Burn() > segments[j].Usage.Burn()
		}
		return segments[i].Model < segments[j].Model
	})
	return segments
}
