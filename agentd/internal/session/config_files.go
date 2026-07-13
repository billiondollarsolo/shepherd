package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/billiondollarsolo/flock/agentd/internal/identity"
)

func seedHookConfig(spec Spec) error {
	if len(spec.ConfigFiles) == 0 {
		return nil
	}
	home := homeForSpec(spec)
	if home == "" {
		return fmt.Errorf("runtime home is unavailable")
	}
	target := filepath.Join(home, spec.ConfigBaseSubdir)
	if err := os.MkdirAll(target, 0o700); err != nil {
		return err
	}
	return writeConfigFiles(target, spec.ConfigFiles)
}

// writeConfigFiles writes Shepherd's hook files into targetDir, replacing the
// __FLOCK_CONFIG_DIR__ placeholder with targetDir and DEEP-MERGING into any
// existing JSON (so the user's own settings/hooks are preserved, and re-running is
// idempotent).
func writeConfigFiles(targetDir string, files map[string]string) error {
	for rel, content := range files {
		full := filepath.Join(targetDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			return err
		}
		body := []byte(strings.ReplaceAll(content, "__FLOCK_CONFIG_DIR__", targetDir))
		mode := os.FileMode(0o644)
		if strings.HasSuffix(rel, ".sh") {
			mode = 0o755 // the hook forwarder must be executable
		}
		// Merge into an existing JSON (e.g. the user's own settings.json) rather than
		// clobbering their model/statusline/custom hooks.
		if strings.HasSuffix(rel, ".json") {
			if existing, rerr := os.ReadFile(full); rerr == nil {
				if merged, ok := mergeHookSettings(existing, body); ok {
					body = merged
				}
			}
		}
		if err := os.WriteFile(full, body, mode); err != nil {
			return err
		}
	}
	return nil
}

// mergeHookSettings deep-merges Shepherd's settings JSON into the user's existing
// settings JSON: every top-level key from Shepherd wins EXCEPT `hooks`, where each
// event's hook array is APPENDED to the user's (so the user's own hooks survive
// alongside Shepherd's). Returns (merged, true) on success, (_, false) if either
// side isn't a JSON object (caller then keeps Shepherd's content as-is).
func mergeHookSettings(existing, flock []byte) ([]byte, bool) {
	var user, add map[string]any
	if json.Unmarshal(existing, &user) != nil || json.Unmarshal(flock, &add) != nil {
		return nil, false
	}
	for k, v := range add {
		if k == "hooks" {
			user[k] = mergeHooksMap(user["hooks"], v)
			continue
		}
		user[k] = v
	}
	out, err := json.MarshalIndent(user, "", "  ")
	if err != nil {
		return nil, false
	}
	return out, true
}

// mergeHooksMap appends Shepherd's per-event hook arrays to the user's existing ones.
func mergeHooksMap(userHooks, flockHooks any) any {
	fm, ok := flockHooks.(map[string]any)
	if !ok {
		return flockHooks
	}
	um, ok := userHooks.(map[string]any)
	if !ok {
		um = map[string]any{}
	}
	for event, fEntries := range fm {
		fArr, _ := fEntries.([]any)
		existing, _ := um[event].([]any)
		// Append only entries not already present. The same native config is
		// re-seeded on every session open, so a plain append would accumulate
		// duplicate Shepherd hooks on disk (→ the agent fires the forwarder N times =
		// N duplicate hook events). Idempotent merge keeps the user's own hooks AND
		// avoids dup-stacking ours.
		for _, fe := range fArr {
			if !containsJSONEqual(existing, fe) {
				existing = append(existing, fe)
			}
		}
		um[event] = existing
	}
	return um
}

// containsJSONEqual reports whether arr already holds an element JSON-equal to v
// (makes hook merging idempotent across re-seeds).
func containsJSONEqual(arr []any, v any) bool {
	vb, err := json.Marshal(v)
	if err != nil {
		return false
	}
	for _, e := range arr {
		if eb, err := json.Marshal(e); err == nil && bytes.Equal(eb, vb) {
			return true
		}
	}
	return false
}

func ensureConfigOwnership(spec Spec) {
	if spec.Identity == nil {
		return
	}
	if len(spec.ConfigFiles) == 0 {
		return
	}
	target := filepath.Join(spec.Identity.Home, spec.ConfigBaseSubdir)
	if spec.ConfigBaseSubdir != "" {
		_ = chownTree(target, spec.Identity)
		return
	}
	for rel := range spec.ConfigFiles {
		_ = chownTree(filepath.Join(target, rel), spec.Identity)
	}
}

func chownTree(root string, runtime *identity.Runtime) error {
	if runtime == nil || root == "" {
		return nil
	}
	return filepath.WalkDir(root, func(path string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(path, int(runtime.UID), int(runtime.GID))
	})
}
