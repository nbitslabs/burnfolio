package usage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func collectAmp(ctx context.Context, opts Options) ([]Event, []string, error) {
	return collectJSONSource(ctx, opts, "amp", ampRoots(opts.HomeDir), parseAmpObject)
}

func collectDroid(ctx context.Context, opts Options) ([]Event, []string, error) {
	return collectJSONSource(ctx, opts, "droid", droidRoots(opts.HomeDir), parseDroidObject)
}

func collectCodebuff(ctx context.Context, opts Options) ([]Event, []string, error) {
	return collectJSONSource(ctx, opts, "codebuff", codebuffRoots(opts.HomeDir), parseCodebuffObject)
}

func collectOpenClaw(ctx context.Context, opts Options) ([]Event, []string, error) {
	var events []Event
	var warnings []string
	var parseErrors int
	seen := map[string]bool{}
	for _, root := range openClawRoots(opts.HomeDir) {
		err := walkFiles(root, func(path string) bool {
			base := filepath.Base(path)
			return hasExt(path, ".jsonl") || strings.Contains(base, ".jsonl.deleted.") || strings.Contains(base, ".jsonl.reset.")
		}, func(path string) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
			var model string
			var provider string
			err := readJSONL(path, func(_ int, obj object) error {
				if nextModel := firstString(obj, []string{"model"}, []string{"modelID"}, []string{"model_id"}, []string{"snapshot", "model"}); nextModel != "" {
					if getString(obj, "type") == "model_change" || getString(obj, "type") == "custom" || getString(obj, "event") == "model_change" {
						model = nextModel
					}
				}
				if nextProvider := firstString(obj, []string{"provider"}, []string{"providerID"}, []string{"provider_id"}, []string{"snapshot", "provider"}); nextProvider != "" {
					provider = nextProvider
				}
				event, ok := parseOpenClawObject(path, obj, model, provider)
				if !ok {
					return nil
				}
				key := firstString(obj, []string{"id"}, []string{"message", "id"}, []string{"requestId"})
				if key == "" {
					key = dedupeKey(path, event.DateUTC, event.Model, event.SessionID, formatInt(event.Usage.Burn()))
				}
				if seen[key] {
					return nil
				}
				seen[key] = true
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
	if parseErrors > opts.MaxErrors {
		warnings = append(warnings, "openclaw: additional parse errors suppressed")
	}
	return events, warnings, nil
}

func collectKimi(ctx context.Context, opts Options) ([]Event, []string, error) {
	return collectJSONSource(ctx, opts, "kimi", kimiRoots(opts.HomeDir), parseKimiObject)
}

func collectQwen(ctx context.Context, opts Options) ([]Event, []string, error) {
	return collectJSONSource(ctx, opts, "qwen", qwenRoots(opts.HomeDir), parseQwenObject)
}

func collectCopilot(ctx context.Context, opts Options) ([]Event, []string, error) {
	var roots []string
	if path := strings.TrimSpace(os.Getenv("COPILOT_OTEL_FILE_EXPORTER_PATH")); path != "" {
		roots = append(roots, path)
	}
	roots = append(roots, filepath.Join(opts.HomeDir, ".copilot", "otel"))
	return collectJSONSource(ctx, opts, "copilot", roots, parseCopilotObject)
}

func collectGemini(ctx context.Context, opts Options) ([]Event, []string, error) {
	return collectJSONSource(ctx, opts, "gemini", geminiRoots(opts.HomeDir), parseGeminiObject)
}

type objectParser func(path string, obj object) (Event, bool)

func collectJSONSource(ctx context.Context, opts Options, name string, roots []string, parse objectParser) ([]Event, []string, error) {
	var events []Event
	var warnings []string
	var parseErrors int
	seen := map[string]bool{}
	for _, root := range roots {
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
					event, ok := parse(path, obj)
					if ok {
						key := genericEventKey(event)
						if !seen[key] {
							seen[key] = true
							events = append(events, event)
						}
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
				return nil
			}
			for _, event := range parseObjectTree(path, obj, parse) {
				key := genericEventKey(event)
				if !seen[key] {
					seen[key] = true
					events = append(events, event)
				}
			}
			return nil
		})
		if err != nil {
			return events, warnings, err
		}
	}
	if parseErrors > opts.MaxErrors {
		warnings = append(warnings, name+": additional parse errors suppressed")
	}
	return events, warnings, nil
}

func parseObjectTree(path string, obj object, parse objectParser) []Event {
	var events []Event
	var walk func(any)
	walk = func(value any) {
		if obj, ok := asObject(value); ok {
			if event, ok := parse(path, obj); ok {
				events = append(events, event)
				return
			}
			for _, child := range obj {
				walk(child)
			}
			return
		}
		if arr, ok := value.([]any); ok {
			for _, child := range arr {
				walk(child)
			}
		}
	}
	walk(obj)
	return events
}

func genericEventKey(event Event) string {
	id := event.SessionID
	if event.Timestamp != nil {
		id += event.Timestamp.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return dedupeKey(event.CLIType, event.Source, id, event.Model, formatInt(event.Usage.Burn()), formatCost(event.CostUSD))
}

func parseAmpObject(path string, obj object) (Event, bool) {
	usage := firstObject(obj,
		[]string{"usage"},
		[]string{"message", "usage"},
		[]string{"ledger", "usage"},
		[]string{"metadata", "usage"},
	)
	if usage == nil {
		return Event{}, false
	}
	ts := parseAnyTime(firstAny(obj, []string{"timestamp"}, []string{"createdAt"}, []string{"created_at"}, []string{"time"}))
	model := firstString(obj, []string{"model"}, []string{"modelID"}, []string{"message", "model"})
	session := firstString(obj, []string{"threadID"}, []string{"threadId"}, []string{"sessionId"}, []string{"id"})
	event, ok := eventFromUsage(path, "amp", inferProvider(model, "amp"), model, session, ts, usageFromObject(usage), firstFloat(usage, []string{"cost", "total"}, []string{"costUSD"}, []string{"cost_usd"}))
	return event, ok
}

func parseDroidObject(path string, obj object) (Event, bool) {
	usage := firstObject(obj,
		[]string{"usage"},
		[]string{"tokenUsage"},
		[]string{"tokens"},
		[]string{"metadata", "usage"},
	)
	if usage == nil {
		return Event{}, false
	}
	ts := parseAnyTime(firstAny(obj, []string{"timestamp"}, []string{"createdAt"}, []string{"startedAt"}, []string{"time"}))
	model := firstString(obj, []string{"model"}, []string{"modelID"}, []string{"provider", "model"})
	session := firstString(obj, []string{"sessionId"}, []string{"sessionID"}, []string{"id"})
	event, ok := eventFromUsage(path, "droid", inferProvider(model, "droid"), model, session, ts, usageFromObject(usage), firstFloat(usage, []string{"cost"}, []string{"costUSD"}))
	return event, ok
}

func parseCodebuffObject(path string, obj object) (Event, bool) {
	usage := firstObject(obj,
		[]string{"metadata", "usage"},
		[]string{"metadata", "codebuff", "usage"},
		[]string{"usage"},
		[]string{"provider", "usage"},
		[]string{"runState", "usage"},
	)
	if usage == nil {
		return Event{}, false
	}
	ts := parseAnyTime(firstAny(obj, []string{"timestamp"}, []string{"createdAt"}, []string{"created_at"}, []string{"metadata", "timestamp"}))
	model := firstString(obj, []string{"model"}, []string{"metadata", "model"}, []string{"metadata", "codebuff", "model"}, []string{"provider", "model"})
	session := firstString(obj, []string{"chatId"}, []string{"chatID"}, []string{"sessionId"}, []string{"id"})
	event, ok := eventFromUsage(path, "codebuff", inferProvider(model, "codebuff"), model, session, ts, usageFromObject(usage), firstFloat(usage, []string{"cost"}, []string{"costUSD"}, []string{"cost_usd"}))
	return event, ok
}

func parseOpenClawObject(path string, obj object, activeModel string, activeProvider string) (Event, bool) {
	usage := firstObject(obj,
		[]string{"usage"},
		[]string{"message", "usage"},
		[]string{"token_usage"},
		[]string{"tokens"},
	)
	if usage == nil {
		return Event{}, false
	}
	ts := parseAnyTime(firstAny(obj, []string{"timestamp"}, []string{"createdAt"}, []string{"time"}))
	model := firstString(obj, []string{"model"}, []string{"modelID"}, []string{"message", "model"})
	if model == "" {
		model = activeModel
	}
	provider := firstString(obj, []string{"provider"}, []string{"providerID"})
	if provider == "" {
		provider = activeProvider
	}
	session := firstString(obj, []string{"sessionId"}, []string{"sessionID"})
	event, ok := eventFromUsage(path, "openclaw", provider, model, session, ts, usageFromObject(usage), firstFloat(obj, []string{"cost", "total"}, []string{"costUSD"}))
	return event, ok
}

func parseKimiObject(path string, obj object) (Event, bool) {
	usage := firstObject(obj, []string{"token_usage"}, []string{"usage"})
	if usage == nil {
		return Event{}, false
	}
	if typ := getString(obj, "type"); typ != "" && typ != "StatusUpdate" {
		return Event{}, false
	}
	tokens := TokenUsage{
		Input:      getInt(usage, "input_other"),
		Output:     getInt(usage, "output"),
		CacheRead:  getInt(usage, "input_cache_read"),
		CacheWrite: getInt(usage, "input_cache_creation"),
		Total:      firstInt(usage, "total", "total_tokens"),
	}
	ts := parseAnyTime(firstAny(obj, []string{"timestamp"}, []string{"createdAt"}, []string{"time"}))
	model := firstString(obj, []string{"model"}, []string{"model_name"})
	if model == "" {
		model = "kimi-for-coding"
	}
	session := filepath.Base(filepath.Dir(path))
	event, ok := eventFromUsage(path, "kimi", "moonshot", model, session, ts, tokens, 0)
	return event, ok
}

func parseQwenObject(path string, obj object) (Event, bool) {
	usage := firstObject(obj, []string{"usageMetadata"}, []string{"usage_metadata"}, []string{"usage"})
	if usage == nil {
		return Event{}, false
	}
	tokens := TokenUsage{
		Input:     firstInt(usage, "promptTokenCount", "input", "input_tokens"),
		Output:    firstInt(usage, "candidatesTokenCount", "output", "output_tokens"),
		CacheRead: firstInt(usage, "cachedContentTokenCount", "cache_read"),
		Reasoning: firstInt(usage, "thoughtsTokenCount", "reasoning"),
		Total:     firstInt(usage, "totalTokenCount", "total"),
	}
	ts := parseAnyTime(firstAny(obj, []string{"timestamp"}, []string{"createdAt"}, []string{"time"}))
	model := firstString(obj, []string{"model"}, []string{"modelName"}, []string{"response", "model"})
	session := firstString(obj, []string{"sessionId"}, []string{"sessionID"}, []string{"chatId"})
	event, ok := eventFromUsage(path, "qwen", "qwen", model, session, ts, tokens, 0)
	return event, ok
}

func parseCopilotObject(path string, obj object) (Event, bool) {
	attrs := getObject(obj, "attributes")
	if attrs == nil {
		attrs = obj
	}
	input := firstInt(attrs, "gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens")
	output := firstInt(attrs, "gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens")
	cacheRead := firstInt(attrs, "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cached_input_tokens")
	cacheWrite := firstInt(attrs, "gen_ai.usage.cache_creation.input_tokens")
	reasoning := firstInt(attrs, "gen_ai.usage.reasoning.output_tokens")
	if input == 0 && output == 0 && cacheRead == 0 && cacheWrite == 0 && reasoning == 0 {
		return Event{}, false
	}
	if input >= cacheRead {
		input -= cacheRead
	}
	ts := parseCopilotTime(obj)
	model := firstString(attrs, []string{"gen_ai.response.model"}, []string{"gen_ai.request.model"})
	session := firstString(attrs, []string{"gen_ai.conversation.id"}, []string{"gen_ai.thread.id"}, []string{"sessionId"})
	event, ok := eventFromUsage(path, "copilot", inferProvider(model, "copilot"), model, session, ts, TokenUsage{
		Input:      input,
		Output:     output,
		CacheRead:  cacheRead,
		CacheWrite: cacheWrite,
		Reasoning:  reasoning,
	}, 0)
	return event, ok
}

func parseGeminiObject(path string, obj object) (Event, bool) {
	tokens := firstObject(obj, []string{"tokens"}, []string{"stats"}, []string{"result", "stats"}, []string{"usage"})
	if tokens == nil {
		return Event{}, false
	}
	input := firstInt(tokens, "input", "input_tokens", "promptTokenCount")
	cached := firstInt(tokens, "cached", "cachedContentTokenCount", "cache_read")
	if input >= cached {
		input -= cached
	}
	usage := TokenUsage{
		Input:     input,
		Output:    firstInt(tokens, "output", "output_tokens", "candidatesTokenCount"),
		CacheRead: cached,
		Reasoning: firstInt(tokens, "thoughts", "thoughtsTokenCount", "reasoning"),
		Total:     firstInt(tokens, "total", "totalTokenCount", "total_tokens"),
	}
	ts := parseAnyTime(firstAny(obj, []string{"timestamp"}, []string{"created_at"}, []string{"startTime"}, []string{"lastUpdated"}))
	model := firstString(obj, []string{"model"}, []string{"result", "model"})
	session := firstString(obj, []string{"sessionId"}, []string{"session_id"}, []string{"id"})
	event, ok := eventFromUsage(path, "gemini", inferProvider(model, "gemini"), model, session, ts, usage, 0)
	return event, ok
}

func firstAny(root object, paths ...[]string) any {
	for _, path := range paths {
		var cur any = root
		ok := true
		for _, key := range path {
			obj, isObj := asObject(cur)
			if !isObj {
				ok = false
				break
			}
			cur = obj[key]
		}
		if ok && cur != nil {
			return cur
		}
	}
	return nil
}

func parseCopilotTime(obj object) *time.Time {
	if ts := parseAnyTime(firstAny(obj, []string{"timestamp"}, []string{"time"})); ts != nil {
		return ts
	}
	if arr := getArray(obj, "endTime"); len(arr) >= 2 {
		sec := anyInt(arr[0])
		nano := anyInt(arr[1])
		t := time.Unix(sec, nano)
		return &t
	}
	if arr := getArray(obj, "hrTime"); len(arr) >= 2 {
		sec := anyInt(arr[0])
		nano := anyInt(arr[1])
		t := time.Unix(sec, nano)
		return &t
	}
	return nil
}

func ampRoots(home string) []string {
	return envOrDefaultDirs("AMP_DATA_DIR", filepath.Join(home, ".local", "share", "amp"))
}

func droidRoots(home string) []string {
	return envOrDefaultDirs("DROID_SESSIONS_DIR", filepath.Join(home, ".factory", "sessions"))
}

func codebuffRoots(home string) []string {
	if dirs := envDirs("CODEBUFF_DATA_DIR"); len(dirs) > 0 {
		return dirs
	}
	return existingDirs(
		filepath.Join(home, ".config", "manicode"),
		filepath.Join(home, ".config", "manicode-dev"),
		filepath.Join(home, ".config", "manicode-staging"),
	)
}

func openClawRoots(home string) []string {
	if dirs := envDirs("OPENCLAW_DIR"); len(dirs) > 0 {
		return dirs
	}
	return existingDirs(
		filepath.Join(home, ".openclaw"),
		filepath.Join(home, ".clawdbot"),
		filepath.Join(home, ".moltbot"),
		filepath.Join(home, ".moldbot"),
	)
}

func kimiRoots(home string) []string {
	return envOrDefaultDirs("KIMI_DATA_DIR", filepath.Join(home, ".kimi"))
}

func qwenRoots(home string) []string {
	return envOrDefaultDirs("QWEN_DATA_DIR", filepath.Join(home, ".qwen"))
}

func geminiRoots(home string) []string {
	return envOrDefaultDirs("GEMINI_DATA_DIR", filepath.Join(home, ".gemini", "tmp"))
}

func decodeJSONArrayFile(path string) ([]object, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var arr []object
	err = json.Unmarshal(raw, &arr)
	return arr, err
}
