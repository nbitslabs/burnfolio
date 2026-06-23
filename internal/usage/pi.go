package usage

import (
	"context"
	"path/filepath"
)

func collectPi(ctx context.Context, opts Options) ([]Event, []string, error) {
	var events []Event
	var warnings []string
	var parseErrors int

	for _, root := range piRoots(opts.HomeDir) {
		err := walkFiles(root, func(path string) bool {
			return hasExt(path, ".jsonl")
		}, func(path string) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}

			err := readJSONL(path, func(_ int, obj object) error {
				event, ok := parsePiEvent(path, obj)
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
		})
		if err != nil {
			return events, warnings, err
		}
	}

	if parseErrors > opts.MaxErrors {
		warnings = append(warnings, "pi: additional parse errors suppressed")
	}
	return events, warnings, nil
}

func parsePiEvent(path string, obj object) (Event, bool) {
	if getString(obj, "type") != "message" || getString(obj, "message", "role") != "assistant" {
		return Event{}, false
	}
	usage := getObject(obj, "message", "usage")
	if usage == nil {
		return Event{}, false
	}

	ts := parseTimePtr(getString(obj, "timestamp"))
	event := Event{
		Provider:  getString(obj, "message", "provider"),
		CLIType:   "pi",
		DateUTC:   eventDateUTC(ts),
		Model:     getString(obj, "message", "model"),
		Source:    path,
		SessionID: sessionIDFromPath(path, ""),
		Timestamp: ts,
		Usage: TokenUsage{
			Input:      getInt(usage, "input"),
			Output:     getInt(usage, "output"),
			CacheRead:  getInt(usage, "cacheRead"),
			CacheWrite: getInt(usage, "cacheWrite"),
			Total:      getInt(usage, "totalTokens"),
		},
		CostUSD: getFloat(usage, "cost", "total"),
	}
	if event.Provider == "" {
		event.Provider = inferProvider(event.Model, "pi")
	}
	return event, event.Usage.Burn() > 0
}

func piRoots(home string) []string {
	if dirs := envDirs("PI_AGENT_DIR"); len(dirs) > 0 {
		return dirs
	}
	return existingDirs(filepath.Join(home, ".pi", "agent", "sessions"))
}
