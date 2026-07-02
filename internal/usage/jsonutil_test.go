package usage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadJSONLSkipsMalformedLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "events.jsonl")
	content := strings.Join([]string{
		`{"id":"1"}`,
		`not valid json`,
		`{"id":"2"}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	var ids []string
	err := readJSONL(path, func(_ int, obj object) error {
		ids = append(ids, getString(obj, "id"))
		return nil
	})
	if err == nil {
		t.Fatal("expected an aggregate warning error for the malformed line")
	}
	if !strings.Contains(err.Error(), "skipped 1 malformed line") {
		t.Fatalf("err = %v, want mention of skipped malformed line", err)
	}
	if len(ids) != 2 || ids[0] != "1" || ids[1] != "2" {
		t.Fatalf("ids = %v, want [1 2] (both valid lines parsed despite malformed line in between)", ids)
	}
}

func TestReadJSONLHandlesOverlongLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "events.jsonl")
	// A single line well past bufio.Scanner's old 32MB cap. It's valid JSON,
	// so it exercises that reading no longer aborts via bufio.Scanner's
	// ErrTooLong and later lines still get parsed either way.
	overlong := `{"id":"huge","junk":"` + strings.Repeat("x", 40*1024*1024) + `"}`
	content := strings.Join([]string{
		`{"id":"1"}`,
		overlong,
		`{"id":"2"}`,
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	var ids []string
	err := readJSONL(path, func(_ int, obj object) error {
		ids = append(ids, getString(obj, "id"))
		return nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ids) != 3 || ids[0] != "1" || ids[1] != "huge" || ids[2] != "2" {
		t.Fatalf("ids = %v, want [1 huge 2] (overlong-but-valid line parsed, later lines still parsed)", ids)
	}
}
