package usage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCollectOpenCodeDedupesAcrossRoots(t *testing.T) {
	root1 := t.TempDir()
	root2 := t.TempDir()

	// Same message ID reachable from both configured roots (e.g. one is a
	// copy or alias of the other). Should be counted once.
	msg := `{"id":"msg_dup_1","sessionID":"s1","modelID":"gpt-5.5","providerID":"openai","time":{"created":1780000000000},"tokens":{"input":100,"output":20,"total":120}}`
	if err := os.WriteFile(filepath.Join(root1, "msg.json"), []byte(msg), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root2, "msg.json"), []byte(msg), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("OPENCODE_DATA_DIR", root1+","+root2)

	events, warnings, err := collectOpenCode(context.Background(), Options{HomeDir: t.TempDir(), MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1 (deduped): %#v", len(events), events)
	}
	if events[0].Usage.Burn() != 120 {
		t.Fatalf("burn = %d, want 120", events[0].Usage.Burn())
	}
}

func TestCollectOpenCodeDedupesFallsBackToPathWhenNoID(t *testing.T) {
	root1 := t.TempDir()
	root2 := t.TempDir()

	// No "id" field anywhere; the fallback key is the path relative to the
	// root, which is identical ("msg.json") across both roots, so this
	// should still dedup to a single event.
	msg := `{"sessionID":"s1","modelID":"gpt-5.5","providerID":"openai","time":{"created":1780000000000},"tokens":{"input":50,"output":10,"total":60}}`
	if err := os.WriteFile(filepath.Join(root1, "msg.json"), []byte(msg), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root2, "msg.json"), []byte(msg), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("OPENCODE_DATA_DIR", root1+","+root2)

	events, _, err := collectOpenCode(context.Background(), Options{HomeDir: t.TempDir(), MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1 (deduped by relative path): %#v", len(events), events)
	}
}

func TestCollectOpenCodeJSONLLinesWithoutIDsAreNotOverDeduped(t *testing.T) {
	root := t.TempDir()

	// Two distinct lines in the same file, neither with an "id" field.
	// The line-number component of the fallback key must keep them from
	// colliding with each other.
	content := `{"sessionID":"s1","modelID":"gpt-5.5","providerID":"openai","time":{"created":1780000000000},"tokens":{"input":10,"output":1,"total":11}}
{"sessionID":"s1","modelID":"gpt-5.5","providerID":"openai","time":{"created":1780000001000},"tokens":{"input":20,"output":2,"total":22}}
`
	if err := os.WriteFile(filepath.Join(root, "log.jsonl"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("OPENCODE_DATA_DIR", root)

	events, _, err := collectOpenCode(context.Background(), Options{HomeDir: t.TempDir(), MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2 (distinct lines, not deduped against each other): %#v", len(events), events)
	}
}

func TestCollectOpenCodeSkipsEventOnDecodeError(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "bad.json"), []byte("{not valid json"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("OPENCODE_DATA_DIR", root)

	events, warnings, err := collectOpenCode(context.Background(), Options{HomeDir: t.TempDir(), MaxErrors: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %d, want 0 for an undecodable file: %#v", len(events), events)
	}
	if len(warnings) != 1 {
		t.Fatalf("warnings = %d, want 1: %v", len(warnings), warnings)
	}
}

func TestOpencodeRootsCollapsesSymlinkedRoot(t *testing.T) {
	real := t.TempDir()
	parent := t.TempDir()
	link := filepath.Join(parent, "opencode-link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks not supported in this environment: %v", err)
	}

	roots := dedupeResolvedDirs([]string{real, link})
	if len(roots) != 1 {
		t.Fatalf("roots = %d, want 1 (real dir and its symlink should collapse): %#v", len(roots), roots)
	}
}
