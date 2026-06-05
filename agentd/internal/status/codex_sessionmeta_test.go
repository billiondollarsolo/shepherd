package status

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestCodexFirstLineLargeSessionMeta guards the codex 0.137 regression: its
// session_meta line embeds `base_instructions` (tens of KB), so a fixed
// 8192-byte read truncated the JSON → Unmarshal failed → findCodexRollout
// skipped every rollout → codex emitted NO status or telemetry. codexFirstLine
// must read the full line regardless of size.
func TestCodexFirstLineLargeSessionMeta(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-test.jsonl")

	big := strings.Repeat("x", 40*1024) // 40 KB — well past the old 8 KB window
	meta, _ := json.Marshal(map[string]any{
		"cwd":               "/home/flock/test5",
		"base_instructions": big,
		"cli_version":       "0.137.0",
	})
	line, _ := json.Marshal(map[string]any{
		"timestamp": "2026-06-04T17:51:12.090Z",
		"type":      "session_meta",
		"payload":   json.RawMessage(meta),
	})
	if err := os.WriteFile(path, append(line, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}

	cwd, ts, ok := codexFirstLine(path)
	if !ok {
		t.Fatalf("codexFirstLine failed on a %d-byte session_meta line", len(line))
	}
	if cwd != "/home/flock/test5" {
		t.Fatalf("cwd = %q, want /home/flock/test5", cwd)
	}
	if want := time.Date(2026, 6, 4, 17, 51, 12, 90_000_000, time.UTC); !ts.Equal(want) {
		t.Fatalf("ts = %v, want %v", ts, want)
	}
}
