package session

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"flock-agentd/internal/agentpath"
)

func defaultShell(spec Spec) string {
	if spec.Identity != nil && spec.Identity.Shell != "" {
		return spec.Identity.Shell
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/sh"
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
	path := os.Getenv("PATH")
	for _, d := range agentpath.BinDirs(home) {
		if !pathContains(path, d) {
			path = path + string(os.PathListSeparator) + d
		}
	}
	return path
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
	if name == "" || strings.ContainsRune(name, os.PathSeparator) {
		return name
	}
	// Prefer the agent bin dirs in BinDirs order (USER-LOCAL first: ~/.local/bin
	// before /usr/bin) — the same order as the spawn PATH — so a user-owned install
	// (e.g. claude via the official installer in ~/.local/bin) wins over a root-owned
	// /usr/bin copy that the agent user can't self-update. Fall back to the daemon's
	// own PATH (LookPath) for anything outside these dirs.
	for _, dir := range agentpath.BinDirs(home) {
		cand := filepath.Join(dir, name)
		if fi, err := os.Stat(cand); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return cand
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p // outside the known bin dirs but on the daemon's $PATH
	}
	return name
}

func homeForSpec(spec Spec) string {
	if spec.Identity != nil && spec.Identity.Home != "" {
		return spec.Identity.Home
	}
	home, _ := os.UserHomeDir()
	return home
}

// agentEnvironment builds the child environment while forcing identity fields
// after all caller additions. Control credentials are always removed.
func agentEnvironment(spec Spec) []string {
	keep := func(entry string) bool { return !reservedAgentEnvKey(envKey(entry)) }
	out := make([]string, 0, len(os.Environ())+len(spec.Env)+8)
	for _, entry := range os.Environ() {
		if keep(entry) && (spec.Identity == nil || inheritedAgentEnvKey(envKey(entry))) {
			out = append(out, entry)
		}
	}
	for _, entry := range spec.Env {
		if keep(entry) {
			out = append(out, entry)
		}
	}
	home := homeForSpec(spec)
	out = append(out, "PATH="+augmentedPath(home))
	if spec.Identity != nil {
		out = append(out,
			"HOME="+spec.Identity.Home,
			"USER="+spec.Identity.Username,
			"LOGNAME="+spec.Identity.Username,
			"SHELL="+spec.Identity.Shell,
		)
	} else if home != "" {
		out = append(out, "HOME="+home)
	}
	return out
}

func envKey(entry string) string {
	if i := strings.IndexByte(entry, '='); i >= 0 {
		return entry[:i]
	}
	return entry
}

// Secure sessions inherit only inert locale/display settings from the daemon.
// Application configuration must be supplied explicitly by the orchestrator;
// database URLs, cloud credentials, sockets, and master keys never hitchhike
// from the service manager.
func inheritedAgentEnvKey(key string) bool {
	switch key {
	case "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "COLORTERM", "NO_COLOR":
		return true
	default:
		return strings.HasPrefix(key, "LC_")
	}
}

func reservedAgentEnvKey(key string) bool {
	switch key {
	case "FLOCK_AGENTD_SECRET", "FLOCK_AGENTD_CREDENTIAL", "FLOCK_AGENTD_CREDENTIAL_FILE",
		"FLOCK_AGENTD_SECRET_FILE", "FLOCK_AGENTD_NODE_ID", "FLOCK_AGENTD_NODE_ID_FILE",
		"FLOCK_MASTER_KEY", "FLOCK_MASTER_KEY_FILE", "DATABASE_URL", "DOCKER_HOST", "SSH_AUTH_SOCK",
		"HOME", "USER", "LOGNAME", "SHELL", "PATH",
		"LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
		"PROMPT_COMMAND", "NODE_OPTIONS":
		return true
	default:
		return strings.HasPrefix(key, "DYLD_")
	}
}

func pathContains(path, dir string) bool {
	for _, p := range strings.Split(path, string(os.PathListSeparator)) {
		if p == dir {
			return true
		}
	}
	return false
}
