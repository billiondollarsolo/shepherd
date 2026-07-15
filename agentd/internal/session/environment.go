package session

import (
	"github.com/billiondollarsolo/flock/agentd/internal/runtimeprocess"
)

func defaultShell(spec Spec) string {
	return runtimeprocess.DefaultShell(spec.Identity)
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
