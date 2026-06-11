package session

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

// ForegroundComm returns the basename of the process group currently in the
// FOREGROUND of this session's PTY — e.g. "htop" while htop runs, or the shell's
// own name ("bash") when you're sitting at the prompt. "" when unknown (no pty /
// exited / transient race).
//
// Mechanism (Linux): the terminal's foreground process-group id via TIOCGPGRP on
// the PTY master, then /proc/<pgid>/comm. This is exactly what the kernel uses to
// route keystrokes, so it precisely tracks "what's on screen". The daemon runs ON
// the node, so /proc is the node's own — correct for local AND remote/ssh nodes.
func (s *Session) ForegroundComm() string {
	// Do the ioctl while STILL holding the lock: the fd is only valid until the PTY
	// is closed/swapped (dev restart), so reading ptmx.Fd() after unlocking risks
	// a use-after-close (querying a stale/reused fd). The /proc read below is safe
	// to do unlocked — pgid is just an int snapshot.
	s.mu.Lock()
	if s.ptmx == nil || s.exited {
		s.mu.Unlock()
		return ""
	}
	pgid, err := unix.IoctlGetInt(int(s.ptmx.Fd()), unix.TIOCGPGRP)
	s.mu.Unlock()
	if err != nil || pgid <= 0 {
		return ""
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pgid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// foregroundShells are foreground commands that mean "just at the prompt" (no
// interesting process running). Reported as the foreground but the UI treats them
// as no-foreground (shows the normal status instead). Login shells arrive with a
// leading '-' which is stripped before lookup.
var foregroundShells = map[string]bool{
	"bash": true, "zsh": true, "sh": true, "fish": true,
	"dash": true, "ksh": true, "tcsh": true, "csh": true, "ash": true,
}

// isForegroundShell reports whether a foreground comm is just a shell prompt.
func isForegroundShell(comm string) bool {
	return foregroundShells[strings.TrimPrefix(comm, "-")]
}
