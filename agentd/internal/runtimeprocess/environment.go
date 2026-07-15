// Package runtimeprocess centralizes executable resolution and environment
// construction for every process launched as the unprivileged node runtime user.
package runtimeprocess

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/billiondollarsolo/flock/agentd/internal/agentpath"
	"github.com/billiondollarsolo/flock/agentd/internal/identity"
)

// DefaultShell returns the fixed runtime user's shell, or a safe development
// fallback when agentd is explicitly running without privilege separation.
func DefaultShell(runtime *identity.Runtime) string {
	if runtime != nil && runtime.Shell != "" {
		return runtime.Shell
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/sh"
}

// Home returns the fixed runtime home or the current user's home in explicit
// insecure development mode.
func Home(runtime *identity.Runtime) string {
	if runtime != nil && runtime.Home != "" {
		return runtime.Home
	}
	home, _ := os.UserHomeDir()
	return home
}

// ResolveExecutable searches the same augmented path that child processes
// receive. exec.Command otherwise resolves argv[0] against the daemon's PATH,
// ignoring the PATH later assigned to cmd.Env.
func ResolveExecutable(name, home string) string {
	if name == "" || strings.ContainsRune(name, os.PathSeparator) {
		return name
	}
	for _, dir := range agentpath.BinDirs(home) {
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	return name
}

// Environment builds a least-privilege child environment. Caller additions are
// applied before immutable identity fields, and control-plane credentials are
// always removed.
func Environment(runtime *identity.Runtime, additions []string) []string {
	keep := func(entry string) bool { return !reservedKey(envKey(entry)) }
	out := make([]string, 0, len(os.Environ())+len(additions)+8)
	for _, entry := range os.Environ() {
		if keep(entry) && (runtime == nil || inheritedKey(envKey(entry))) {
			out = append(out, entry)
		}
	}
	for _, entry := range additions {
		if keep(entry) {
			out = append(out, entry)
		}
	}
	home := Home(runtime)
	out = append(out, "PATH="+AugmentedPath(home))
	if runtime != nil {
		out = append(out,
			"HOME="+runtime.Home,
			"USER="+runtime.Username,
			"LOGNAME="+runtime.Username,
			"SHELL="+runtime.Shell,
		)
	} else if home != "" {
		out = append(out, "HOME="+home)
	}
	return out
}

// AugmentedPath returns the daemon PATH plus every detected user-local agent bin
// directory for home.
func AugmentedPath(home string) string {
	path := os.Getenv("PATH")
	for _, dir := range agentpath.BinDirs(home) {
		if !pathContains(path, dir) {
			path += string(os.PathListSeparator) + dir
		}
	}
	return path
}

func envKey(entry string) string {
	if index := strings.IndexByte(entry, '='); index >= 0 {
		return entry[:index]
	}
	return entry
}

func inheritedKey(key string) bool {
	switch key {
	case "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "COLORTERM", "NO_COLOR":
		return true
	default:
		return strings.HasPrefix(key, "LC_")
	}
}

func reservedKey(key string) bool {
	switch key {
	case "FLOCK_AGENTD_SECRET", "FLOCK_AGENTD_CREDENTIAL", "FLOCK_AGENTD_CREDENTIAL_FILE",
		"FLOCK_AGENTD_SECRET_FILE", "FLOCK_AGENTD_NODE_ID", "FLOCK_AGENTD_NODE_ID_FILE",
		"FLOCK_MASTER_KEY", "FLOCK_MASTER_KEY_FILE", "DATABASE_URL", "DOCKER_HOST", "SSH_AUTH_SOCK",
		"HOME", "USER", "LOGNAME", "SHELL", "PATH",
		"LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
		"PROMPT_COMMAND", "NODE_OPTIONS":
		return true
	default:
		return strings.HasPrefix(key, "DYLD_") || strings.HasPrefix(key, "FLOCK_AGENTD_")
	}
}

func pathContains(path, dir string) bool {
	for _, current := range strings.Split(path, string(os.PathListSeparator)) {
		if current == dir {
			return true
		}
	}
	return false
}
