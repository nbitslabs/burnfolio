package usage

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func homeJoin(home string, parts ...string) string {
	all := append([]string{home}, parts...)
	return filepath.Join(all...)
}

func splitPathList(raw string) []string {
	var paths []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			paths = append(paths, part)
		}
	}
	return paths
}

func existingDirs(paths ...string) []string {
	var out []string
	seen := map[string]bool{}
	for _, path := range paths {
		if path == "" || seen[path] {
			continue
		}
		info, err := os.Stat(path)
		if err == nil && info.IsDir() {
			out = append(out, path)
			seen[path] = true
		}
	}
	return out
}

func envDirs(envName string) []string {
	raw := os.Getenv(envName)
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	return existingDirs(splitPathList(raw)...)
}

func envOrDefaultDirs(envName string, defaults ...string) []string {
	if dirs := envDirs(envName); len(dirs) > 0 {
		return dirs
	}
	return existingDirs(defaults...)
}

func xdgConfigHome(home string) string {
	if value := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); value != "" {
		return value
	}
	return filepath.Join(home, ".config")
}

func parseAnyTime(value any) *time.Time {
	switch v := value.(type) {
	case string:
		return parseFlexibleTime(v)
	case []byte:
		return parseFlexibleTime(string(v))
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return unixNumberTime(i)
		}
		if f, err := v.Float64(); err == nil {
			return unixNumberTime(int64(f))
		}
	case float64:
		return unixNumberTime(int64(v))
	case int64:
		return unixNumberTime(v)
	case int:
		return unixNumberTime(int64(v))
	}
	return nil
}

func parseFlexibleTime(raw string) *time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if i, err := parseInt(raw); err == nil {
		return unixNumberTime(i)
	}
	// Zoned layouts carry their own offset, so parse them as-is.
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, raw); err == nil {
			return &t
		}
	}
	// Zone-less layouts: several sources (e.g. Goose's created_at/
	// updated_at) store local wall-clock time here, not UTC. Parsing them
	// with time.Parse implicitly assumes UTC, which shifts day-bucketing
	// by the machine's UTC offset. Parse in the local zone instead.
	for _, layout := range []string{"2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, raw, time.Local); err == nil {
			return &t
		}
	}
	return nil
}

// parseInt parses raw as a base-10 integer, requiring the whole string to
// be consumed. (fmt.Sscanf("%d", ...) would previously accept a digit
// *prefix* of an arbitrary string — e.g. "2026-01-05T00:00:00Z" scanned as
// the integer 2026 — which silently corrupted any RFC3339 timestamp routed
// through this function into a near-epoch date. strconv.ParseInt has no
// such partial-match behavior.)
func parseInt(raw string) (int64, error) {
	return strconv.ParseInt(raw, 10, 64)
}

func unixNumberTime(value int64) *time.Time {
	if value <= 0 {
		return nil
	}
	var t time.Time
	if value > 1_000_000_000_000 {
		t = time.UnixMilli(value)
	} else {
		t = time.Unix(value, 0)
	}
	return &t
}

func getArray(root object, path ...string) []any {
	var cur any = root
	for _, key := range path {
		obj, ok := asObject(cur)
		if !ok {
			return nil
		}
		cur = obj[key]
	}
	if arr, ok := cur.([]any); ok {
		return arr
	}
	return nil
}

func objectArray(value any) []object {
	arr, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]object, 0, len(arr))
	for _, item := range arr {
		if obj, ok := asObject(item); ok {
			out = append(out, obj)
		}
	}
	return out
}

func firstObject(root object, paths ...[]string) object {
	for _, path := range paths {
		if obj := getObject(root, path...); obj != nil {
			return obj
		}
	}
	return nil
}

func eventFromUsage(path, cliType string, provider string, model string, sessionID string, ts *time.Time, usage TokenUsage, cost float64) (Event, bool) {
	if provider == "" {
		provider = inferProvider(model, cliType)
	}
	if sessionID == "" {
		sessionID = sessionIDFromPath(path, "")
	}
	event := Event{
		Provider:  provider,
		CLIType:   cliType,
		DateUTC:   eventDateUTC(ts),
		Model:     model,
		Source:    path,
		SessionID: sessionID,
		Timestamp: ts,
		Usage:     usage,
		CostUSD:   cost,
	}
	return event, event.Usage.Burn() > 0 || event.CostUSD > 0
}

func inferProvider(model string, fallback string) string {
	lower := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.HasPrefix(lower, "claude"):
		return "anthropic"
	case strings.HasPrefix(lower, "gpt-"), strings.HasPrefix(lower, "o1"), strings.HasPrefix(lower, "o3"), strings.HasPrefix(lower, "o4"), strings.HasPrefix(lower, "o5"), strings.HasPrefix(lower, "chatgpt"):
		return "openai"
	case strings.HasPrefix(lower, "gemini"):
		return "google"
	case strings.HasPrefix(lower, "qwen"):
		return "qwen"
	case strings.Contains(lower, "kimi"), strings.Contains(lower, "moonshot"):
		return "moonshot"
	default:
		return fallback
	}
}

func usageFromObject(obj object) TokenUsage {
	cache := getObject(obj, "cache")
	input := firstInt(obj, "input", "input_tokens", "prompt_tokens", "inputTokens")
	output := firstInt(obj, "output", "output_tokens", "completion_tokens", "outputTokens")
	cacheRead := firstInt(obj, "cacheRead", "cache_read", "cache_read_input_tokens", "cached_input_tokens", "cachedContentTokenCount", "cacheReadTokens")
	cacheWrite := firstInt(obj, "cacheWrite", "cache_write", "cache_creation_input_tokens", "cacheCreationTokens")
	if cache != nil {
		if cacheRead == 0 {
			cacheRead = firstInt(cache, "read", "input_tokens")
		}
		if cacheWrite == 0 {
			cacheWrite = firstInt(cache, "write", "input_tokens")
		}
	}
	return TokenUsage{
		Input:      input,
		Output:     output,
		CacheRead:  cacheRead,
		CacheWrite: cacheWrite,
		Reasoning:  firstInt(obj, "reasoning", "reasoning_output_tokens", "reasoningTokens", "thoughtsTokenCount", "thoughts", "thinking"),
		Total:      firstInt(obj, "total", "totalTokens", "total_tokens", "totalTokenCount"),
	}
}

func dedupeKey(parts ...string) string {
	h := sha1.New()
	for _, part := range parts {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}
