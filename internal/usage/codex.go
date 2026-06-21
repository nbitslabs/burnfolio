package usage

import (
	"context"
	"path/filepath"
)

func collectCodex(ctx context.Context, opts Options) ([]Event, []string, error) {
	root := filepath.Join(opts.HomeDir, ".codex", "sessions")
	var events []Event
	var warnings []string
	var parseErrors int

	err := walkFiles(root, func(path string) bool {
		return hasExt(path, ".jsonl")
	}, func(path string) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		var currentModel string
		var sessionID string
		err := readJSONL(path, func(_ int, obj object) error {
			if getString(obj, "type") == "session_meta" {
				sessionID = getString(obj, "payload", "id")
			}
			if getString(obj, "type") == "turn_context" {
				currentModel = getString(obj, "payload", "model")
			}
			event, ok := parseCodexEvent(path, obj, currentModel, sessionID)
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

	if parseErrors > opts.MaxErrors {
		warnings = append(warnings, "codex: additional parse errors suppressed")
	}
	return events, warnings, err
}

func parseCodexEvent(path string, obj object, currentModel string, sessionID string) (Event, bool) {
	if getString(obj, "type") != "event_msg" || getString(obj, "payload", "type") != "token_count" {
		return Event{}, false
	}

	usageObj := getObject(obj, "payload", "info", "last_token_usage")
	if usageObj == nil {
		return Event{}, false
	}

	ts := parseTimePtr(getString(obj, "timestamp"))
	event := Event{
		Provider:  "openai",
		CLIType:   "codex",
		DateUTC:   eventDateUTC(ts),
		Model:     currentModel,
		Source:    path,
		SessionID: sessionIDFromPath(path, sessionID),
		Timestamp: ts,
		Usage: TokenUsage{
			Input:     getInt(usageObj, "input_tokens"),
			Output:    getInt(usageObj, "output_tokens"),
			CacheRead: getInt(usageObj, "cached_input_tokens"),
			Reasoning: getInt(usageObj, "reasoning_output_tokens"),
			Total:     getInt(usageObj, "total_tokens"),
		},
	}
	return event, event.Usage.Burn() > 0
}

func sessionIDFromPath(path string, fallback string) string {
	if fallback != "" {
		return fallback
	}
	base := filepath.Base(path)
	if ext := filepath.Ext(base); ext != "" {
		base = base[:len(base)-len(ext)]
	}
	return base
}
