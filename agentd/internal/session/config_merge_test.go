package session

import (
	"encoding/json"
	"testing"
)

// mergeHookSettings is re-seeded on EVERY session open, so it must be idempotent:
// merging the same Shepherd hooks twice must not stack duplicates, while preserving
// the user's own hooks + other settings.
func TestMergeHookSettingsIdempotent(t *testing.T) {
	user := []byte(`{
		"model": "sonnet",
		"hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "user-hook" } ] } ] }
	}`)
	flock := []byte(`{
		"hooks": {
			"Stop": [ { "hooks": [ { "type": "command", "command": "flock" } ] } ],
			"PreToolUse": [ { "hooks": [ { "type": "command", "command": "flock" } ] } ]
		}
	}`)

	once, ok := mergeHookSettings(user, flock)
	if !ok {
		t.Fatal("first merge failed")
	}
	twice, ok := mergeHookSettings(once, flock)
	if !ok {
		t.Fatal("second merge failed")
	}

	var got map[string]any
	if err := json.Unmarshal(twice, &got); err != nil {
		t.Fatalf("result not JSON: %v", err)
	}

	// Other settings preserved.
	if got["model"] != "sonnet" {
		t.Fatalf("model not preserved: %v", got["model"])
	}

	hooks, _ := got["hooks"].(map[string]any)
	stop, _ := hooks["Stop"].([]any)
	pre, _ := hooks["PreToolUse"].([]any)
	// Stop = the user's entry + ONE flock entry (not two after a re-merge).
	if len(stop) != 2 {
		t.Fatalf("Stop should have user + 1 flock entry (idempotent), got %d: %s", len(stop), twice)
	}
	if len(pre) != 1 {
		t.Fatalf("PreToolUse should have 1 flock entry (idempotent), got %d: %s", len(pre), twice)
	}
}
