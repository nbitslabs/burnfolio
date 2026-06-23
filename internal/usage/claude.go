package usage

import (
	"context"
	"os"
	"path/filepath"
)

func collectClaude(ctx context.Context, opts Options) ([]Event, []string, error) {
	roots := claudeRoots(opts.HomeDir)
	var events []Event
	var warnings []string
	var parseErrors int
	seen := map[string]bool{}

	for _, root := range roots {
		err := walkFiles(filepath.Join(root, "projects"), func(path string) bool {
			return hasExt(path, ".jsonl")
		}, func(path string) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}

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
		})
		if err != nil {
			return events, warnings, err
		}
	}

	for _, root := range roots {
		if filepath.Base(root) == "projects" {
			continue
		}
		for _, name := range []string{"logs", "transcripts"} {
			err := walkFiles(filepath.Join(root, name), func(path string) bool {
				return hasExt(path, ".jsonl")
			}, func(path string) error {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
				}
				err := readJSONL(path, func(_ int, obj object) error {
					event, ok := parseClaudeEvent(path, obj)
					if !ok {
						return nil
					}
					key := claudeDedupeKey(path, obj)
					if key != "" && seen[key] {
						return nil
					}
					if key != "" {
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
			})
			if err != nil {
				return events, warnings, err
			}
		}
	}

	if parseErrors > opts.MaxErrors {
		warnings = append(warnings, "claude: additional parse errors suppressed")
	}
	return events, warnings, nil
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

func claudeRoots(home string) []string {
	if raw := os.Getenv("CLAUDE_CONFIG_DIR"); raw != "" {
		var roots []string
		for _, path := range splitPathList(raw) {
			if filepath.Base(path) == "projects" {
				path = filepath.Dir(path)
			}
			roots = append(roots, path)
		}
		return existingDirs(roots...)
	}
	return existingDirs(
		filepath.Join(xdgConfigHome(home), "claude"),
		filepath.Join(home, ".claude"),
	)
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
