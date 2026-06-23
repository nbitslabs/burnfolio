package usage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

func collectCodex(ctx context.Context, opts Options) ([]Event, []string, error) {
	var events []Event
	var warnings []string
	var parseErrors int
	seenFiles := map[string]bool{}

	for _, root := range codexRoots(opts.HomeDir) {
		for _, dir := range codexUsageDirs(root) {
			err := walkFiles(dir, func(path string) bool {
				return hasExt(path, ".jsonl")
			}, func(path string) error {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}

				rel := path
				if r, err := filepath.Rel(dir, path); err == nil {
					rel = r
				}
				fileKey := root + "\x00" + rel
				if seenFiles[fileKey] {
					return nil
				}
				seenFiles[fileKey] = true

				var currentModel string
				var sessionID string
				var previous TokenUsage
				err := readJSONL(path, func(_ int, obj object) error {
					if getString(obj, "type") == "session_meta" {
						sessionID = firstString(obj, []string{"payload", "id"}, []string{"payload", "session_id"})
					}
					if getString(obj, "type") == "turn_context" {
						currentModel = firstString(obj, []string{"payload", "model"}, []string{"payload", "info", "model"})
					}
					event, ok := parseCodexEventWithPrevious(path, obj, currentModel, sessionID, &previous)
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
	}

	if parseErrors > opts.MaxErrors {
		warnings = append(warnings, "codex: additional parse errors suppressed")
	}
	return events, warnings, nil
}

func parseCodexEvent(path string, obj object, currentModel string, sessionID string) (Event, bool) {
	var previous TokenUsage
	return parseCodexEventWithPrevious(path, obj, currentModel, sessionID, &previous)
}

func parseCodexEventWithPrevious(path string, obj object, currentModel string, sessionID string, previous *TokenUsage) (Event, bool) {
	if getString(obj, "type") != "event_msg" || getString(obj, "payload", "type") != "token_count" {
		return Event{}, false
	}

	usageObj := getObject(obj, "payload", "info", "last_token_usage")
	if usageObj == nil {
		usageObj = getObject(obj, "payload", "info", "total_token_usage")
		if usageObj == nil {
			return Event{}, false
		}
	}
	rawUsage := TokenUsage{
		Input:     getInt(usageObj, "input_tokens"),
		Output:    getInt(usageObj, "output_tokens"),
		CacheRead: getInt(usageObj, "cached_input_tokens"),
		Reasoning: getInt(usageObj, "reasoning_output_tokens"),
		Total:     getInt(usageObj, "total_tokens"),
	}
	usage := rawUsage
	if getObject(obj, "payload", "info", "last_token_usage") == nil && previous != nil {
		usage = TokenUsage{
			Input:     nonNegative(rawUsage.Input - previous.Input),
			Output:    nonNegative(rawUsage.Output - previous.Output),
			CacheRead: nonNegative(rawUsage.CacheRead - previous.CacheRead),
			Reasoning: nonNegative(rawUsage.Reasoning - previous.Reasoning),
			Total:     nonNegative(rawUsage.Total - previous.Total),
		}
		*previous = rawUsage
	} else if previous != nil {
		previous.Input += rawUsage.Input
		previous.Output += rawUsage.Output
		previous.CacheRead += rawUsage.CacheRead
		previous.Reasoning += rawUsage.Reasoning
		previous.Total += rawUsage.Total
	}
	if currentModel == "" {
		currentModel = firstString(obj, []string{"payload", "info", "model"}, []string{"payload", "info", "model_context"})
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
		Usage:     usage,
	}
	return event, event.Usage.Burn() > 0
}

func nonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func codexRoots(home string) []string {
	if raw := os.Getenv("CODEX_HOME"); strings.TrimSpace(raw) != "" {
		return existingDirs(splitPathList(raw)...)
	}
	return existingDirs(filepath.Join(home, ".codex"))
}

func codexUsageDirs(root string) []string {
	sessions := filepath.Join(root, "sessions")
	archived := filepath.Join(root, "archived_sessions")
	dirs := existingDirs(sessions, archived)
	if len(dirs) > 0 {
		return dirs
	}
	return existingDirs(root)
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
