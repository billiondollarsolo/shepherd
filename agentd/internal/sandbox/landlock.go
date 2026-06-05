// Package sandbox provides Linux Landlock-based filesystem confinement for
// agent sessions (T17). It is used to enforce the autonomy that the
// `autonomous` permission mode implies: a `--dangerously-skip-permissions`
// agent should not also have unrestricted write access to the whole node.
//
// The model: RestrictWrites() confines the CALLING process (and everything it
// later execs — Landlock rights are preserved across execve) so it may only
// WRITE beneath an allow-list of directories. READ and EXECUTE are left
// unrestricted, so the agent can still read system files, libraries, and its own
// config, and run interpreters/tools — it just cannot write outside its
// workspace (+ /tmp, /dev, and its own state dirs).
//
// This is applied from a short-lived re-exec helper (`flock-agentd sandbox-exec`)
// rather than the daemon itself: Landlock restrictions are irreversible and
// inherited, so the daemon must NOT restrict itself (that would confine every
// session + its own operation). The helper restricts only its own process tree
// and then execs the agent.
//
// Landlock is a no-op-friendly LSM: absent/old kernels report ABI 0 and we skip
// confinement (the caller logs an "unsandboxed" warning). FS-only (ABI 1+) is
// sufficient for the write-confinement guarantee.
package sandbox

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/unix"
)

// landlockRulesetAttrSize is the size the kernel expects for create_ruleset's
// attr argument (it validates the struct size for forward/backward compat).
var landlockRulesetAttrSize = unsafe.Sizeof(unix.LandlockRulesetAttr{})

// All FS access rights present in Landlock ABI 1 (the baseline every
// landlock-capable kernel supports). We deliberately handle ONLY the write-class
// rights below; read/exec are excluded so they stay unrestricted.
const (
	accessWriteFileV1 = unix.LANDLOCK_ACCESS_FS_WRITE_FILE |
		unix.LANDLOCK_ACCESS_FS_REMOVE_DIR |
		unix.LANDLOCK_ACCESS_FS_REMOVE_FILE |
		unix.LANDLOCK_ACCESS_FS_MAKE_CHAR |
		unix.LANDLOCK_ACCESS_FS_MAKE_DIR |
		unix.LANDLOCK_ACCESS_FS_MAKE_REG |
		unix.LANDLOCK_ACCESS_FS_MAKE_SOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_FIFO |
		unix.LANDLOCK_ACCESS_FS_MAKE_BLOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_SYM
)

// ABIVersion returns the kernel's Landlock ABI version (>=1 when available, 0
// when Landlock is not supported/enabled). Used to decide whether a node can
// enforce the autonomous-mode sandbox.
func ABIVersion() int {
	// create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) returns the ABI.
	r, _, errno := unix.Syscall(unix.SYS_LANDLOCK_CREATE_RULESET, 0, 0, uintptr(unix.LANDLOCK_CREATE_RULESET_VERSION))
	if errno != 0 {
		return 0
	}
	return int(r)
}

// Available reports whether this kernel can enforce the FS sandbox.
func Available() bool { return ABIVersion() >= 1 }

// handledWriteAccess returns the set of write-class FS rights to confine, masked
// to what the running ABI understands (handing a newer right to an older kernel
// fails the whole ruleset with EINVAL).
func handledWriteAccess(abi int) uint64 {
	access := uint64(accessWriteFileV1)
	if abi >= 2 { // REFER (file re-parenting), kernel 5.19
		access |= unix.LANDLOCK_ACCESS_FS_REFER
	}
	if abi >= 3 { // TRUNCATE, kernel 6.2
		access |= unix.LANDLOCK_ACCESS_FS_TRUNCATE
	}
	// NB: LANDLOCK_ACCESS_FS_IOCTL_DEV (ABI 5, kernel 6.10) is intentionally NOT
	// handled — it governs ioctls on device files, not filesystem writes, and
	// confining it risks breaking the agent's terminal/device ioctls. Our
	// guarantee is "no file writes outside the workspace", which the rights above
	// fully cover.
	return access
}

// RestrictWrites confines the current process so it may only write beneath the
// given directories (existing dirs only — missing ones are skipped). After this
// returns nil, neither this process nor anything it execs can create/modify/
// delete files outside `allowWrite`. A no-op (nil) when Landlock is unavailable
// so callers degrade to "unsandboxed" rather than failing to launch.
func RestrictWrites(allowWrite []string) error {
	abi := ABIVersion()
	if abi < 1 {
		return nil // unsupported kernel — caller warns; do not block the launch
	}
	access := handledWriteAccess(abi)

	// Required so an unprivileged process may restrict itself (man landlock).
	if err := unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("prctl(NO_NEW_PRIVS): %w", err)
	}

	attr := unix.LandlockRulesetAttr{Access_fs: access}
	rulesetFd, _, errno := unix.Syscall(
		unix.SYS_LANDLOCK_CREATE_RULESET,
		uintptr(unsafe.Pointer(&attr)),
		landlockRulesetAttrSize,
		0,
	)
	if errno != 0 {
		return fmt.Errorf("landlock_create_ruleset: %w", errno)
	}
	defer unix.Close(int(rulesetFd))

	for _, dir := range allowWrite {
		if dir == "" {
			continue
		}
		fd, err := unix.Open(dir, unix.O_PATH|unix.O_CLOEXEC|unix.O_DIRECTORY, 0)
		if err != nil {
			continue // a non-existent allow path is fine — just nothing to grant
		}
		pa := unix.LandlockPathBeneathAttr{Allowed_access: access, Parent_fd: int32(fd)}
		_, _, errno := unix.Syscall6(
			unix.SYS_LANDLOCK_ADD_RULE,
			rulesetFd,
			uintptr(unix.LANDLOCK_RULE_PATH_BENEATH),
			uintptr(unsafe.Pointer(&pa)),
			0, 0, 0,
		)
		unix.Close(fd)
		if errno != 0 {
			return fmt.Errorf("landlock_add_rule(%s): %w", dir, errno)
		}
	}

	if _, _, errno := unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, rulesetFd, 0, 0); errno != 0 {
		return fmt.Errorf("landlock_restrict_self: %w", errno)
	}
	return nil
}
