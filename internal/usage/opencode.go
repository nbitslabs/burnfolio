package usage

import (
	"context"
	"path/filepath"
)

func collectOpenCode(ctx context.Context, opts Options) ([]Event, []string, error) {
	var events []Event
	var warnings []string
	var parseErrors int

	for _, root := range opencodeRoots(opts.HomeDir) {
		err := walkFiles(root, func(path string) bool {
			return hasExt(path, ".jsonl", ".json")
		}, func(path string) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}

			if hasExt(path, ".jsonl") {
				err := readJSONL(path, func(_ int, obj object) error {
					event, ok := parseOpenCodeEvent(path, obj)
					if ok {
						events = append(events, event)
					}
					return nil
				})
				if err != nil {
					parseErrors++
					if parseErrors <= opts.MaxErrors {
						warnings = append(warnings, err.Error())
					}
				}
				return nil
			}

			obj, err := decodeJSONFile(path)
			if err != nil {
				parseErrors++
				if parseErrors <= opts.MaxErrors {
					warnings = append(warnings, err.Error())
				}
			}
			event, ok := parseOpenCodeEvent(path, obj)
			if ok {
				events = append(events, event)
			}
			return nil
		})
		if err != nil {
			return events, warnings, err
		}
	}

	if parseErrors > opts.MaxErrors {
		warnings = append(warnings, "opencode: additional parse errors suppressed")
	}
	return events, warnings, nil
}

func parseOpenCodeEvent(path string, obj object) (Event, bool) {
	usage := firstObject(obj,
		[]string{"tokens"},
		[]string{"usage"},
		[]string{"message", "usage"},
		[]string{"message", "tokens"},
		[]string{"response", "usage"},
		[]string{"info", "usage"},
	)
	if usage == nil {
		return Event{}, false
	}

	ts := parseTimePtr(firstString(obj,
		[]string{"timestamp"},
		[]string{"time"},
		[]string{"createdAt"},
		[]string{"created_at"},
	))
	if ts == nil {
		ts = parseAnyTime(firstObject(obj, []string{"time"})["created"])
	}

	input := firstInt(usage, "input", "input_tokens", "prompt_tokens")
	output := firstInt(usage, "output", "output_tokens", "completion_tokens")
	cacheRead := firstInt(usage, "cacheRead", "cache_read", "cached_input_tokens", "cache_read_input_tokens")
	cacheWrite := firstInt(usage, "cacheWrite", "cache_write", "cache_creation_input_tokens")
	if cache := getObject(usage, "cache"); cache != nil {
		if cacheRead == 0 {
			cacheRead = firstInt(cache, "read")
		}
		if cacheWrite == 0 {
			cacheWrite = firstInt(cache, "write")
		}
	}
	total := firstInt(usage, "total", "totalTokens", "total_tokens")

	event := Event{
		Provider:  firstString(obj, []string{"providerID"}, []string{"provider"}, []string{"message", "provider"}),
		CLIType:   "opencode",
		DateUTC:   eventDateUTC(ts),
		Model:     firstString(obj, []string{"modelID"}, []string{"model"}, []string{"message", "model"}, []string{"response", "model"}),
		Source:    path,
		SessionID: firstString(obj, []string{"sessionID"}, []string{"sessionId"}, []string{"session_id"}),
		Timestamp: ts,
		Usage: TokenUsage{
			Input:      input,
			Output:     output,
			CacheRead:  cacheRead,
			CacheWrite: cacheWrite,
			Reasoning:  firstInt(usage, "reasoning", "reasoning_output_tokens"),
			Total:      total,
		},
		CostUSD: firstFloat(usage, []string{"cost", "total"}, []string{"costUSD"}, []string{"cost_usd"}),
	}
	if event.Provider == "" {
		event.Provider = inferProvider(event.Model, "opencode")
	}
	if event.SessionID == "" {
		event.SessionID = sessionIDFromPath(path, "")
	}
	return event, event.Usage.Burn() > 0
}

func opencodeRoots(home string) []string {
	if dirs := envDirs("OPENCODE_DATA_DIR"); len(dirs) > 0 {
		return dirs
	}
	return existingDirs(
		filepath.Join(home, ".local", "share", "opencode"),
		filepath.Join(home, ".config", "opencode"),
	)
}

func firstString(root object, paths ...[]string) string {
	for _, path := range paths {
		if value := getString(root, path...); value != "" {
			return value
		}
	}
	return ""
}

func firstInt(root object, keys ...string) int64 {
	for _, key := range keys {
		if value := getInt(root, key); value != 0 {
			return value
		}
	}
	return 0
}

func firstFloat(root object, paths ...[]string) float64 {
	for _, path := range paths {
		if value := getFloat(root, path...); value != 0 {
			return value
		}
	}
	return 0
}
