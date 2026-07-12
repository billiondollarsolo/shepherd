package session

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/billiondollarsolo/flock/agentd/internal/identity"
)

// Per-path locks + atomic writes for the agent config files we mutate. Several
// sessions can launch concurrently in the same cwd (or touch the same shared
// config like ~/.claude.json), so an unsynchronized read-modify-write +
// non-atomic os.WriteFile can interleave and CORRUPT the user's real config.
// We serialize per absolute path and write via temp-file+rename (atomic on the
// same fs), mirroring the layout store. Per-process is sufficient: one daemon
// owns each node.
var (
	fileLocksMu sync.Mutex
	fileLocks   = map[string]*sync.Mutex{}
)

func lockForPath(path string) *sync.Mutex {
	fileLocksMu.Lock()
	defer fileLocksMu.Unlock()
	l := fileLocks[path]
	if l == nil {
		l = &sync.Mutex{}
		fileLocks[path] = l
	}
	return l
}

// writeFileAtomic writes data to path via a temp file in the same directory then
// renames it into place, so a reader (or a crash) never sees a partial file.
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".flock-cfg-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// The flock orchestration MCP server, embedded so the daemon SHIPS it (no separate
// deploy) and writes it to ~/.flock/flock-mcp.mjs, versioned with the binary.
//
//go:embed flock-mcp.mjs
var flockMcpScript string

// trust.go — pre-accept each agent's "do you trust the files in this folder?" gate
// for the session's working dir, so a Flock-launched agent starts READY instead of
// blocked on an onboarding/trust prompt (which also swallows the first input). This
// is the bypass for the trust prompts: we write the SAME "trusted" marker the agent
// would write after you click "yes", before launch.
//
// Best-effort + NON-DESTRUCTIVE: read-modify-write only the trust key, preserving
// everything else; if the file exists but isn't parseable, we leave it untouched
// rather than risk clobbering the user's config. Unknown agents → no-op.

// detectSetupAgent maps a launch command to an agent name for per-session SETUP
// (trust + MCP) — broader than status.DetectAgent (which only knows the two
// transcript agents). Matches the binary base, so gemini/grok/opencode are covered.
func detectSetupAgent(command []string) string {
	if len(command) == 0 {
		return ""
	}
	base := filepath.Base(command[0])
	// Auth-bootstrap wrapper: `sh -c '<probe> || <bootstrap>; exec <agent> …'`
	// (grok). Unwrap to the real binary after the last `exec `.
	if base == "sh" || base == "bash" {
		joined := strings.Join(command, " ")
		if i := strings.LastIndex(joined, "exec "); i >= 0 {
			if rest := strings.Fields(joined[i+len("exec "):]); len(rest) > 0 {
				base = filepath.Base(rest[0])
			}
		}
	}
	switch base {
	case "claude":
		return "claude"
	case "codex":
		return "codex"
	case "gemini":
		return "gemini"
	case "grok":
		return "grok"
	case "opencode":
		return "opencode"
	default:
		return ""
	}
}

// ensureFolderTrust marks cwd trusted for the given agent + registers the flock MCP
// server in its config. `agent` comes from detectSetupAgent.
func ensureFolderTrust(agent, cwd string, runtime *identity.Runtime) {
	home := ""
	if runtime != nil {
		home = runtime.Home
	} else {
		home, _ = os.UserHomeDir()
	}
	if home == "" || cwd == "" {
		return
	}
	defer ensureTrustOwnership(home, agent, runtime)
	mcp := flockMcpServer(home) // nil unless ~/.flock/flock-mcp.mjs is present
	switch agent {
	case "claude":
		// ~/.claude.json → trust this cwd + register the flock MCP server (so the
		// agent auto-discovers the orchestration tools).
		mergeJSONFile(filepath.Join(home, ".claude.json"), func(m map[string]any) {
			projects, ok := m["projects"].(map[string]any)
			if !ok || projects == nil {
				projects = map[string]any{}
				m["projects"] = projects
			}
			p, ok := projects[cwd].(map[string]any)
			if !ok || p == nil {
				p = map[string]any{}
				projects[cwd] = p
			}
			p["hasTrustDialogAccepted"] = true
			addMcpServer(m, mcp)
		})
	case "gemini":
		// ~/.gemini/trustedFolders.json → trust; settings.json → MCP server.
		mergeJSONFile(filepath.Join(home, ".gemini", "trustedFolders.json"), func(m map[string]any) {
			m[cwd] = "TRUST_FOLDER"
		})
		if mcp != nil {
			mergeJSONFile(filepath.Join(home, ".gemini", "settings.json"), func(m map[string]any) {
				addMcpServer(m, mcp)
			})
		}
	case "codex":
		// codex config is TOML — append an [mcp_servers.flock] block if absent.
		if mcp != nil {
			appendTomlMcpServer(filepath.Join(home, ".codex", "config.toml"), filepath.Join(home, ".flock", "flock-mcp.mjs"), false)
		}
	case "grok":
		// grok stores MCP in ~/.grok/config.toml [mcp_servers.X] (+ enabled=true).
		if mcp != nil {
			appendTomlMcpServer(filepath.Join(home, ".grok", "config.toml"), filepath.Join(home, ".flock", "flock-mcp.mjs"), true)
		}
	case "opencode":
		// opencode config (opencode.jsonc — plain JSON) → mcp.flock (local stdio).
		if mcp != nil {
			mergeJSONFile(filepath.Join(home, ".config", "opencode", "opencode.jsonc"), func(m map[string]any) {
				addOpencodeMcp(m, filepath.Join(home, ".flock", "flock-mcp.mjs"))
			})
		}
	}
}

// addOpencodeMcp registers the flock server under opencode's `mcp` config key.
func addOpencodeMcp(m map[string]any, scriptPath string) {
	mcp, ok := m["mcp"].(map[string]any)
	if !ok || mcp == nil {
		mcp = map[string]any{}
		m["mcp"] = mcp
	}
	mcp["flock"] = map[string]any{"type": "local", "command": []any{"node", scriptPath}, "enabled": true}
}

// appendTomlMcpServer adds an [mcp_servers.flock] block to codex's config.toml
// (only if absent — idempotent, and it never rewrites the user's existing TOML).
func appendTomlMcpServer(configPath, scriptPath string, enabled bool) {
	l := lockForPath(configPath)
	l.Lock()
	defer l.Unlock()
	existing, _ := os.ReadFile(configPath)
	if strings.Contains(string(existing), "[mcp_servers.flock]") {
		return
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(configPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	block := fmt.Sprintf("\n[mcp_servers.flock]\ncommand = \"node\"\nargs = [%q]\n", scriptPath)
	if enabled {
		block += "enabled = true\n"
	}
	_, _ = f.WriteString(block)
}

// flockMcpServer returns the MCP-config entry for the flock orchestration server,
// or nil if the script isn't shipped on this node (so we never write a broken
// MCP entry). The server inherits the agent's env (FLOCK_HOOK_URL/TOKEN) at launch.
func flockMcpServer(home string) map[string]any {
	dir := filepath.Join(home, ".flock")
	p := filepath.Join(dir, "flock-mcp.mjs")
	// Ship the embedded server (idempotent; keeps it fresh on daemon upgrade).
	// Atomic + locked so concurrent session launches never read a partial script.
	l := lockForPath(p)
	l.Lock()
	_ = writeFileAtomic(p, []byte(flockMcpScript), 0o644)
	l.Unlock()
	if _, err := os.Stat(p); err != nil {
		return nil // couldn't ship it → don't register a broken MCP entry
	}
	return map[string]any{"command": "node", "args": []any{p}}
}

// acpFlockMcpServers builds the ACP `session/new` mcpServers list for the flock
// server (ships the script + passes its separate capability as explicit env so it
// authenticates even if the agent doesn't forward its own env). Empty if unavailable.
func acpFlockMcpServers(hookURL, orchestrationToken, home string, runtime *identity.Runtime) []any {
	if hookURL == "" || orchestrationToken == "" {
		return nil
	}
	if home == "" {
		return nil
	}
	entry := flockMcpServer(home) // ships the script; {command, args} or nil
	_ = chownTree(filepath.Join(home, ".flock"), runtime)
	if entry == nil {
		return nil
	}
	return []any{map[string]any{
		"name":    "flock",
		"command": entry["command"],
		"args":    entry["args"],
		"env": []any{
			map[string]any{"name": "FLOCK_HOOK_URL", "value": hookURL},
			map[string]any{"name": "FLOCK_ORCHESTRATE_TOKEN", "value": orchestrationToken},
		},
	}}
}

func ensureTrustOwnership(home, agent string, runtime *identity.Runtime) {
	if runtime == nil {
		return
	}
	_ = chownTree(filepath.Join(home, ".flock"), runtime)
	switch agent {
	case "claude":
		_ = os.Lchown(filepath.Join(home, ".claude.json"), int(runtime.UID), int(runtime.GID))
	case "gemini":
		_ = chownTree(filepath.Join(home, ".gemini"), runtime)
	case "codex":
		_ = chownTree(filepath.Join(home, ".codex"), runtime)
	case "grok":
		_ = chownTree(filepath.Join(home, ".grok"), runtime)
	case "opencode":
		_ = chownTree(filepath.Join(home, ".config", "opencode"), runtime)
	}
}

// addMcpServer merges the flock entry into a config's top-level `mcpServers`.
func addMcpServer(m map[string]any, entry map[string]any) {
	if entry == nil {
		return
	}
	servers, ok := m["mcpServers"].(map[string]any)
	if !ok || servers == nil {
		servers = map[string]any{}
		m["mcpServers"] = servers
	}
	servers["flock"] = entry
}

// mergeJSONFile read-modify-writes a JSON object file, applying mutate. Creates it
// (and its parent dir) when missing. If the file exists but does NOT parse as a JSON
// object, it is left untouched (never clobber a config we don't understand).
func mergeJSONFile(path string, mutate func(map[string]any)) {
	l := lockForPath(path)
	l.Lock()
	defer l.Unlock()
	m := map[string]any{}
	if b, err := os.ReadFile(path); err == nil {
		if json.Unmarshal(b, &m) != nil {
			return // existing file isn't JSON we understand → don't risk clobbering it
		}
		if m == nil {
			m = map[string]any{}
		}
	}
	mutate(m)
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	_ = writeFileAtomic(path, b, 0o644)
}
