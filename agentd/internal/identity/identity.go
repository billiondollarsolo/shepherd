// Package identity resolves and applies the fixed unprivileged identity used by
// every agent session. The control client never supplies UID/GID values.
package identity

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
)

// Runtime is the immutable OS identity and home used by agent subprocesses.
type Runtime struct {
	Username string
	UID      uint32
	GID      uint32
	Groups   []uint32
	Home     string
	Shell    string
}

// Resolve looks up a non-root local account and its complete group set.
func Resolve(username string) (*Runtime, error) {
	if strings.TrimSpace(username) == "" {
		return nil, fmt.Errorf("runtime user is required")
	}
	u, err := user.Lookup(username)
	if err != nil {
		return nil, fmt.Errorf("lookup runtime user %q: %w", username, err)
	}
	uid64, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("parse uid for %q: %w", username, err)
	}
	gid64, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("parse gid for %q: %w", username, err)
	}
	if uid64 == 0 {
		return nil, fmt.Errorf("runtime user %q must not be root", username)
	}

	primary := uint32(gid64)

	shell := shellFromPasswd(username)
	if shell == "" {
		shell = "/bin/sh"
	}
	return &Runtime{
		Username: u.Username,
		UID:      uint32(uid64),
		GID:      primary,
		// Deliberately ignore the account's supplementary memberships. A reused or
		// misconfigured runtime account must not carry sudo, Docker, or control
		// groups into an agent process.
		Groups: []uint32{},
		Home:   u.HomeDir,
		Shell:  shell,
	}, nil
}

// ResolveGroupID resolves a local control group without accepting numeric input.
// Atoi rejects values outside the platform int range required by os.Chown.
func ResolveGroupID(name string) (int, error) {
	if strings.TrimSpace(name) == "" {
		return 0, fmt.Errorf("control group is required")
	}
	group, err := user.LookupGroup(name)
	if err != nil {
		return 0, fmt.Errorf("lookup control group %q: %w", name, err)
	}
	value, err := strconv.Atoi(group.Gid)
	if err != nil {
		return 0, fmt.Errorf("parse gid for control group %q: %w", name, err)
	}
	if value < 0 {
		return 0, fmt.Errorf("gid for control group %q must not be negative", name)
	}
	return value, nil
}

func shellFromPasswd(username string) string {
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), ":")
		if len(fields) >= 7 && fields[0] == username {
			return fields[6]
		}
	}
	return ""
}

// Apply configures a child command to drop all process credentials before exec.
func (r *Runtime) Apply(cmd *exec.Cmd) {
	if r == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	groups := append([]uint32(nil), r.Groups...)
	cmd.SysProcAttr.Credential = &syscall.Credential{
		Uid:    r.UID,
		Gid:    r.GID,
		Groups: groups,
	}
}

// ValidateControlIdentity proves the daemon can actually drop privileges.
func (r *Runtime) ValidateControlIdentity() error {
	if r == nil {
		return fmt.Errorf("runtime identity is required")
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("secure agentd must run as root to drop sessions to uid %d", r.UID)
	}
	return nil
}
