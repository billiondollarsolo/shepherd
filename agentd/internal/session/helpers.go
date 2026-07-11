package session

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func orDefault(v, d uint16) uint16 {
	if v == 0 {
		return d
	}
	return v
}

func capDuration(v, max time.Duration) time.Duration {
	if v > max {
		return max
	}
	return v
}

// devRestartBanner is the dim line injected into the stream between dev restarts.
func devRestartBanner(code int, wait time.Duration) []byte {
	return []byte(fmt.Sprintf(
		"\r\n\x1b[2m↻ dev process exited (code %d) — restarting in %s…\x1b[0m\r\n",
		code, wait.Round(time.Millisecond),
	))
}

// hasEnvKey reports whether env contains a `key=…` entry.
func hasEnvKey(env []string, key string) bool {
	prefix := key + "="
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			return true
		}
	}
	return false
}

// seedSessionTemp creates one private temporary directory per session beneath
// the runtime home. It prevents tools from sharing a global /tmp namespace for
// ordinary temporary files and makes cleanup deterministic on session close.

func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return -1
}
