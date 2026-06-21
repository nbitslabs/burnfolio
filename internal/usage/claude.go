package usage

import (
	"context"
	"path/filepath"
)

func collectClaude(ctx context.Context, opts Options) ([]Event, []string, error) {
	root := filepath.Join(opts.HomeDir, ".claude")
	var events []Event
	var warnings []string
	var parseErrors int
	seen := map[string]bool{}

	err := walkFiles(root, func(path string) bool {
		if !hasExt(path, ".jsonl", ".json") {
			return false
		}
		base := filepath.Base(path)
		if base == "settings.json" || base == "settings.local.json" {
			return false
		}
		return true
	}, func(path string) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if hasExt(path, ".jsonl") {
			err := readJSONL(path, func(_ int, obj object) error {
				event, ok := parseClaudeEvent(path, obj)
				if !ok {
					return nil
				}
				key := claudeDedupeKey(path, obj)
				if key != "" {
					if seen[key] {
						return nil
					}
					seen[key] = true
				}
				events = append(events, event)
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
			return nil
		}
		event, ok := parseClaudeEvent(path, obj)
		if ok {
			key := claudeDedupeKey(path, obj)
			if key == "" || !seen[key] {
				if key != "" {
					seen[key] = true
				}
				events = append(events, event)
			}
		}
		return nil
	})

	if parseErrors > opts.MaxErrors {
		warnings = append(warnings, "claude: additional parse errors suppressed")
	}
	return events, warnings, err
}

func parseClaudeEvent(path string, obj object) (Event, bool) {
	if getString(obj, "type") != "assistant" {
		return Event{}, false
	}
	usage := getObject(obj, "message", "usage")
	if usage == nil {
		return Event{}, false
	}

	ts := parseTimePtr(getString(obj, "timestamp"))
	event := Event{
		Provider:  "anthropic",
		CLIType:   "claude",
		DateUTC:   eventDateUTC(ts),
		Model:     getString(obj, "message", "model"),
		Source:    path,
		SessionID: getString(obj, "sessionId"),
		Timestamp: ts,
		Usage: TokenUsage{
			Input:      getInt(usage, "input_tokens"),
			Output:     getInt(usage, "output_tokens"),
			CacheRead:  getInt(usage, "cache_read_input_tokens"),
			CacheWrite: getInt(usage, "cache_creation_input_tokens"),
		},
	}
	return event, event.Usage.Burn() > 0
}

func claudeDedupeKey(path string, obj object) string {
	requestID := getString(obj, "requestId")
	if requestID != "" {
		return "request:" + requestID
	}
	messageID := getString(obj, "message", "id")
	if messageID != "" {
		return "message:" + messageID
	}
	uuid := getString(obj, "uuid")
	if uuid != "" {
		return "uuid:" + path + ":" + uuid
	}
	return ""
}
