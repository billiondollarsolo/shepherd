package session

import (
	"github.com/billiondollarsolo/flock/agentd/internal/runtimeprocess"
)

func defaultShell(spec Spec) string {
	return runtimeprocess.DefaultShell(spec.Identity)
}

// augmentedPath returns the daemon's $PATH with the shared agent-install bin dirs
// (agentpath.BinDirs — same source of truth as metrics.resolveAgent) appended, so
// npm / version-manager-installed agents (claude/codex/gemini/opencode) launch even
// under a minimal systemd/nohup $PATH.
//
// Recomputed on EVERY spawn — deliberately NOT cached. An agent can be installed
// AFTER the daemon starts (e.g. a userland `npm i -g` into ~/.local/bin); BinDirs
// only includes dirs that exist at call time, so a once-cached PATH would omit
// that dir forever and the daemon would keep failing to launch the agent even
// though detection (which rescans every 30s) shows it as present. The ~20
// stat/glob syscalls per spawn are negligible — spawns are user-initiated + rare.
func augmentedPath(home string) string {
	return runtimeprocess.AugmentedPath(home)
}

// resolveExecutable maps a bare command name (argv[0]) to an absolute path,
// searching the SAME augmented bin dirs as the spawn PATH (agentpath.BinDirs —
// the source of truth shared with metrics.resolveAgent detection). This is
// REQUIRED because exec.Command/LookPath resolves a bare name against the daemon's
// OWN $PATH and ignores cmd.Env, so an agent in ~/.local/bin (etc.) installed
// after / outside the daemon's minimal $PATH would otherwise fail with "not
// found". A name that already contains a separator, or is on the daemon's own
// PATH, is used as-is. Returns the input unchanged when nothing resolves, so the
// caller still surfaces a clean exec error.
func resolveExecutable(name, home string) string {
	return runtimeprocess.ResolveExecutable(name, home)
}

func homeForSpec(spec Spec) string {
	return runtimeprocess.Home(spec.Identity)
}

// agentEnvironment builds the child environment while forcing identity fields
// after all caller additions. Control credentials are always removed.
func agentEnvironment(spec Spec) []string {
	return runtimeprocess.Environment(spec.Identity, spec.Env)
}
