// Package agentpath centralizes where coding-agent CLIs (claude/codex/gemini/
// opencode) install on a node, so agent DETECTION (metrics.resolveAgent) and the
// spawn PATH augmentation (session) share ONE source of truth instead of two
// hand-synced dir lists (which previously drifted: "detected but won't launch").
package agentpath

import (
	"os"
	"path/filepath"
)

// agents whose per-agent install dirs (~/.<agent>/bin, /opt/<agent>/bin) are also
// searched, beyond the generic npm / version-manager locations below.
var agents = []string{"opencode", "claude", "codex", "gemini", "grok", "aider", "cursor-agent", "amp"}

// BinDirs returns the EXISTING bin directories where agent CLIs commonly install
// under home: npm-global, Node version managers (nvm/fnm/n), volta/bun/deno/asdf/
// yarn, system dirs, Homebrew, and per-agent dirs. Only directories that exist
// are returned. Pure (uncached) so detection re-scans pick up late installs and
// tests can vary $HOME — callers that want caching (the spawn PATH) cache the
// derived result themselves.
func BinDirs(home string) []string {
	fixed := []string{
		filepath.Join(home, ".local/bin"),
		filepath.Join(home, ".local/share/npm/bin"),
		filepath.Join(home, ".npm-global/bin"),
		filepath.Join(home, ".volta/bin"),
		filepath.Join(home, ".bun/bin"),
		filepath.Join(home, ".deno/bin"),
		filepath.Join(home, ".asdf/shims"),
		filepath.Join(home, ".yarn/bin"),
		filepath.Join(home, ".config/yarn/global/node_modules/.bin"),
		filepath.Join(home, ".n/bin"),
		"/usr/local/bin", "/usr/bin", "/bin", "/snap/bin", "/opt/homebrew/bin",
	}
	globs := []string{
		filepath.Join(home, ".nvm/versions/node/*/bin"),
		filepath.Join(home, ".local/share/fnm/node-versions/*/installation/bin"),
		filepath.Join(home, ".fnm/node-versions/*/installation/bin"),
		"/usr/local/n/versions/node/*/bin",
	}
	var out []string
	add := func(d string) {
		if isDir(d) {
			out = append(out, d)
		}
	}
	for _, d := range fixed {
		add(d)
	}
	for _, g := range globs {
		if m, _ := filepath.Glob(g); len(m) > 0 {
			for _, d := range m {
				add(d)
			}
		}
	}
	for _, a := range agents {
		add(filepath.Join(home, "."+a, "bin"))
		add(filepath.Join("/opt", a, "bin"))
	}
	return out
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}
