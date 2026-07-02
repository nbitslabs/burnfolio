package usage

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

func collectHermes(ctx context.Context, opts Options) ([]Event, []string, error) {
	var events []Event
	var warnings []string
	for _, dbPath := range hermesDBPaths(opts.HomeDir) {
		select {
		case <-ctx.Done():
			return events, warnings, ctx.Err()
		default:
		}
		dbEvents, err := readHermesDB(dbPath)
		if err != nil {
			warnings = append(warnings, "hermes: "+err.Error())
			continue
		}
		events = append(events, dbEvents...)
	}
	return events, warnings, nil
}

func collectGoose(ctx context.Context, opts Options) ([]Event, []string, error) {
	var events []Event
	var warnings []string
	for _, dbPath := range gooseDBPaths(opts.HomeDir) {
		select {
		case <-ctx.Done():
			return events, warnings, ctx.Err()
		default:
		}
		dbEvents, err := readGooseDB(dbPath)
		if err != nil {
			warnings = append(warnings, "goose: "+err.Error())
			continue
		}
		events = append(events, dbEvents...)
	}
	return events, warnings, nil
}

func collectKilo(ctx context.Context, opts Options) ([]Event, []string, error) {
	var events []Event
	var warnings []string
	seen := map[string]bool{}
	for _, dbPath := range kiloDBPaths(opts.HomeDir) {
		select {
		case <-ctx.Done():
			return events, warnings, ctx.Err()
		default:
		}
		dbEvents, err := readKiloDB(dbPath)
		if err != nil {
			warnings = append(warnings, "kilo: "+err.Error())
			continue
		}
		for _, event := range dbEvents {
			key := genericEventKey(event)
			if seen[key] {
				continue
			}
			seen[key] = true
			events = append(events, event)
		}
	}
	return events, warnings, nil
}

// openReadOnlyDB opens a possibly-live SQLite database for reading. Opening
// a live database with mode=ro&immutable=1 bypasses SQLite's locking/WAL
// machinery, which can return corrupt or torn reads while the owning app is
// writing to it. To avoid that, we snapshot the database file (and any -wal
// / -shm siblings) into a temp directory and open the immutable copy
// instead. The returned cleanup func removes the temp copy and must always
// be called, even on error.
func openReadOnlyDB(path string) (*sql.DB, func(), error) {
	noop := func() {}
	if copyPath, cleanup, err := snapshotSQLiteDB(path); err == nil {
		u := url.URL{Scheme: "file", Path: copyPath, RawQuery: "mode=ro&immutable=1"}
		db, openErr := sql.Open("sqlite", u.String())
		if openErr != nil {
			cleanup()
			return nil, noop, openErr
		}
		return db, cleanup, nil
	}
	// Fall back to opening the original file directly, without the
	// immutable flag, so SQLite still respects locking/WAL semantics.
	u := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, noop, err
	}
	return db, noop, nil
}

// snapshotSQLiteDB copies path (and its -wal/-shm siblings, if present) into
// a fresh temp directory and returns the path to the copied main database
// file along with a cleanup func that removes the temp directory.
func snapshotSQLiteDB(path string) (string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "pyro-sqlite-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.RemoveAll(tmpDir) }

	base := filepath.Base(path)
	dstPath := filepath.Join(tmpDir, base)
	if err := copyFile(path, dstPath); err != nil {
		cleanup()
		return "", nil, err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		src := path + suffix
		if _, statErr := os.Stat(src); statErr != nil {
			continue
		}
		if err := copyFile(src, dstPath+suffix); err != nil {
			cleanup()
			return "", nil, err
		}
	}
	return dstPath, cleanup, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func readHermesDB(path string) ([]Event, error) {
	db, cleanup, err := openReadOnlyDB(path)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	defer db.Close()
	rows, err := db.Query(`
		SELECT id, model, billing_provider, started_at, message_count,
		       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		       reasoning_tokens, estimated_cost_usd, actual_cost_usd
		FROM sessions
		WHERE model IS NOT NULL AND TRIM(model) != ''
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		var id, model, provider sql.NullString
		var started any
		var messageCount, input, output, cacheRead, cacheWrite, reasoning sql.NullInt64
		var estimated, actual sql.NullFloat64
		if err := rows.Scan(&id, &model, &provider, &started, &messageCount, &input, &output, &cacheRead, &cacheWrite, &reasoning, &estimated, &actual); err != nil {
			continue
		}
		cost := estimated.Float64
		if actual.Valid {
			cost = actual.Float64
		}
		ts := parseAnyTime(started)
		event, ok := eventFromUsage(path, "hermes", provider.String, model.String, id.String, ts, TokenUsage{
			Input:      nullInt(input),
			Output:     nullInt(output),
			CacheRead:  nullInt(cacheRead),
			CacheWrite: nullInt(cacheWrite),
			Reasoning:  nullInt(reasoning),
		}, cost)
		if ok {
			events = append(events, event)
		}
	}
	return events, rows.Err()
}

func readGooseDB(path string) ([]Event, error) {
	db, cleanup, err := openReadOnlyDB(path)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	defer db.Close()
	rows, err := db.Query(`
		SELECT id, model_config_json, provider_name, created_at,
		       total_tokens, input_tokens, output_tokens,
		       accumulated_total_tokens, accumulated_input_tokens, accumulated_output_tokens
		FROM sessions
		WHERE model_config_json IS NOT NULL AND TRIM(model_config_json) != ''
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		var id, modelConfig, provider, created sql.NullString
		var total, input, output, accTotal, accInput, accOutput sql.NullInt64
		if err := rows.Scan(&id, &modelConfig, &provider, &created, &total, &input, &output, &accTotal, &accInput, &accOutput); err != nil {
			continue
		}
		model := gooseModel(modelConfig.String)
		if model == "" {
			continue
		}
		i := chooseInt(accInput, input)
		o := chooseInt(accOutput, output)
		t := chooseInt(accTotal, total)
		reasoning := int64(0)
		if t > i+o {
			reasoning = t - i - o
		}
		event, ok := eventFromUsage(path, "goose", provider.String, model, id.String, parseAnyTime(created.String), TokenUsage{
			Input:     i,
			Output:    o,
			Reasoning: reasoning,
			Total:     t,
		}, 0)
		if ok {
			events = append(events, event)
		}
	}
	return events, rows.Err()
}

func readKiloDB(path string) ([]Event, error) {
	db, cleanup, err := openReadOnlyDB(path)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	defer db.Close()
	rows, err := db.Query(`SELECT id, session_id, data FROM message`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []Event
	for rows.Next() {
		var id, sessionID, data sql.NullString
		if err := rows.Scan(&id, &sessionID, &data); err != nil {
			continue
		}
		obj := object{}
		if err := json.Unmarshal([]byte(data.String), &obj); err != nil {
			continue
		}
		event, ok := parseKiloMessage(path, obj, id.String, sessionID.String)
		if ok {
			events = append(events, event)
		}
	}
	return events, rows.Err()
}

func parseKiloMessage(path string, obj object, rowID string, rowSessionID string) (Event, bool) {
	if role := getString(obj, "role"); role != "" && role != "assistant" {
		return Event{}, false
	}
	usage := firstObject(obj, []string{"tokens"}, []string{"usage"})
	if usage == nil {
		return Event{}, false
	}
	tokenUsage := usageFromObject(usage)
	ts := parseAnyTime(firstAny(obj, []string{"time", "created"}, []string{"timestamp"}, []string{"createdAt"}))
	model := firstString(obj, []string{"modelID"}, []string{"model"})
	provider := firstString(obj, []string{"providerID"}, []string{"provider"})
	sessionID := firstString(obj, []string{"sessionID"}, []string{"sessionId"})
	if sessionID == "" {
		sessionID = rowSessionID
	}
	if sessionID == "" {
		sessionID = rowID
	}
	event, ok := eventFromUsage(path, "kilo", provider, model, sessionID, ts, tokenUsage, firstFloat(obj, []string{"cost"}, []string{"costUSD"}))
	return event, ok
}

func gooseModel(raw string) string {
	var obj object
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return ""
	}
	return firstString(obj, []string{"model_name"}, []string{"model"}, []string{"modelName"})
}

func nullInt(value sql.NullInt64) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}

func chooseInt(preferred sql.NullInt64, fallback sql.NullInt64) int64 {
	if preferred.Valid && preferred.Int64 > 0 {
		return preferred.Int64
	}
	return nullInt(fallback)
}

func hermesDBPaths(home string) []string {
	var roots []string
	if dirs := envDirs("HERMES_HOME"); len(dirs) > 0 {
		roots = dirs
	} else {
		roots = existingDirs(filepath.Join(home, ".hermes"))
	}
	var paths []string
	for _, root := range roots {
		paths = append(paths, filepath.Join(root, "state.db"))
	}
	return existingFiles(paths...)
}

func gooseDBPaths(home string) []string {
	if roots := splitPathList(strings.TrimSpace(os.Getenv("GOOSE_PATH_ROOT"))); len(roots) > 0 {
		var paths []string
		for _, root := range roots {
			paths = append(paths, filepath.Join(root, "data", "sessions", "sessions.db"))
		}
		return existingFiles(paths...)
	}
	return existingFiles(
		filepath.Join(home, ".local", "share", "goose", "sessions", "sessions.db"),
		filepath.Join(home, "Library", "Application Support", "goose", "sessions", "sessions.db"),
		filepath.Join(home, ".local", "share", "Block", "goose", "sessions", "sessions.db"),
	)
}

func kiloDBPaths(home string) []string {
	roots := envOrDefaultDirs("KILO_DATA_DIR", filepath.Join(home, ".local", "share", "kilo"))
	var paths []string
	for _, root := range roots {
		paths = append(paths, filepath.Join(root, "kilo.db"))
	}
	return existingFiles(paths...)
}

func existingFiles(paths ...string) []string {
	var out []string
	seen := map[string]bool{}
	for _, path := range paths {
		if path == "" || seen[path] {
			continue
		}
		info, err := os.Stat(path)
		if err == nil && !info.IsDir() {
			out = append(out, path)
			seen[path] = true
		}
	}
	return out
}
