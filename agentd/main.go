// Command flock-agentd is the per-node Shepherd daemon: it owns PTY sessions (the
// raw-PTY replacement for tmux), persists them across orchestrator reconnects,
// and speaks the framed protocol over a unix socket (local) or a loopback TCP
// port reached via an SSH direct-tcpip channel (remote). See
// docs/flock-agentd-design.md.
package main

import (
	_ "embed"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/identity"
	"github.com/billiondollarsolo/flock/agentd/internal/layout"
	"github.com/billiondollarsolo/flock/agentd/internal/metrics"
	"github.com/billiondollarsolo/flock/agentd/internal/sandbox"
	"github.com/billiondollarsolo/flock/agentd/internal/server"
	"github.com/billiondollarsolo/flock/agentd/internal/session"
)

// T14 — single source of truth for the version. The VERSION file is read by the
// agentd Makefile (to stamp release builds via -ldflags) AND embedded here so a
// plain `go run` / unstamped build reports the same value. `Version` stays empty
// so `-X main.Version=…` can override it at link time (an init expression would
// be clobbered by package init and break -X); resolveVersion() falls back to the
// embedded file when it wasn't stamped.
//
//go:embed VERSION
var embeddedVersion string

// Version is set at build time via -ldflags "-X main.Version=…" (see Makefile).
var Version = ""

func resolveVersion() string {
	if Version != "" {
		return Version
	}
	return strings.TrimSpace(embeddedVersion)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: flock-agentd <serve|version>")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version":
		fmt.Println(resolveVersion())
	case "serve":
		serve(os.Args[2:])
	case "sandbox-exec":
		sandboxExec(os.Args[2:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}

// sandboxExec is the re-exec helper that enforces the autonomous-mode FS sandbox
// (T17). Usage: flock-agentd sandbox-exec --allow DIR [--allow DIR]... -- CMD ARGS
// It Landlock-restricts THIS process so it (and the agent it execs) may only
// write beneath the --allow dirs, then execs the agent (Landlock persists across
// execve). Run as a short-lived child so the daemon itself is never restricted.
func sandboxExec(args []string) {
	var allow []string
	i := 0
	for ; i < len(args); i++ {
		if args[i] == "--allow" && i+1 < len(args) {
			allow = append(allow, args[i+1])
			i++
			continue
		}
		if args[i] == "--" {
			i++
			break
		}
		fmt.Fprintf(os.Stderr, "[flock-agentd] sandbox-exec: unexpected arg %q\n", args[i])
		os.Exit(2)
	}
	cmd := args[i:]
	if len(cmd) == 0 {
		fmt.Fprintln(os.Stderr, "[flock-agentd] sandbox-exec: no command after --")
		os.Exit(2)
	}
	if err := sandbox.RestrictWrites(allow); err != nil {
		// Fail CLOSED: if we were asked to sandbox but couldn't, do NOT run the
		// (dangerous, autonomous) agent unconfined.
		fmt.Fprintf(os.Stderr, "[flock-agentd] sandbox-exec: landlock failed: %v\n", err)
		os.Exit(1)
	}
	bin, err := exec.LookPath(cmd[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "[flock-agentd] sandbox-exec: %v\n", err)
		os.Exit(127)
	}
	if err := syscall.Exec(bin, cmd, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "[flock-agentd] sandbox-exec: exec %s: %v\n", bin, err)
		os.Exit(126)
	}
}

func serve(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	socket := fs.String("socket", defaultSocket(), "unix socket path (local node)")
	addr := fs.String("addr", "", "loopback TCP addr for SSH direct-tcpip, e.g. 127.0.0.1:48222")
	secret := fs.String("secret", os.Getenv("FLOCK_AGENTD_SECRET"), "shared secret (optional)")
	secretFile := fs.String("secret-file", os.Getenv("FLOCK_AGENTD_SECRET_FILE"), "protected shared-secret file")
	nodeID := fs.String("node-id", os.Getenv("FLOCK_AGENTD_NODE_ID"), "stable identity for this daemon")
	stateDir := fs.String("state-dir", defaultStateDir(), "dir for persisted layouts")
	runtimeUser := fs.String("runtime-user", "", "fixed non-root user for every agent process")
	allowInsecureSameUser := fs.Bool(
		"allow-insecure-same-user",
		false,
		"DEVELOPMENT ONLY: run agents as the daemon user",
	)
	controlGroup := fs.String("control-group", "", "group permitted to open the unix control socket")
	_ = fs.Parse(args)

	var runtimeIdentity *identity.Runtime
	if *runtimeUser != "" {
		var resolveErr error
		runtimeIdentity, resolveErr = identity.Resolve(*runtimeUser)
		if resolveErr != nil {
			fatal("resolve runtime identity", resolveErr)
		}
		if validateErr := runtimeIdentity.ValidateControlIdentity(); validateErr != nil {
			fatal("validate control identity", validateErr)
		}
	} else if !*allowInsecureSameUser {
		fatal("missing runtime identity", fmt.Errorf(
			"--runtime-user is required; same-UID agent execution is unsupported (development may opt in with --allow-insecure-same-user)"))
	} else {
		fmt.Fprintln(os.Stderr, "[flock-agentd] SECURITY WARNING: insecure same-user development mode enabled")
	}

	resolvedSecret := *secret
	if *secretFile != "" {
		var readErr error
		resolvedSecret, readErr = readCredentialFile(*secretFile, runtimeIdentity != nil)
		if readErr != nil {
			fatal("read control credential", readErr)
		}
	}
	if runtimeIdentity != nil && *secretFile == "" {
		fatal("missing control credential", fmt.Errorf("--secret-file is required in secure mode"))
	}
	if runtimeIdentity != nil && resolvedSecret == "" {
		fatal("missing control credential", fmt.Errorf("--secret-file is required in secure mode"))
	}
	if strings.TrimSpace(*nodeID) == "" {
		if runtimeIdentity != nil {
			fatal("missing node identity", fmt.Errorf("--node-id is required in secure mode"))
		}
		*nodeID = "development-local"
	}

	// A loopback TCP listener (remote nodes, reached via SSH direct-tcpip) is the
	// surface another LOCAL user/process on the node could reach. Refuse to open
	// it without a shared secret. Unix permissions remain a first boundary, but
	// every transport still performs the same mutual-MAC handshake; only explicit
	// insecure same-user development mode may use an empty credential.
	if *addr != "" && resolvedSecret == "" {
		fatal("refusing TCP listener", fmt.Errorf(
			"a --secret (or FLOCK_AGENTD_SECRET) is required when --addr is set; refusing to expose an unauthenticated control port"))
	}
	if *addr != "" {
		host, _, splitErr := net.SplitHostPort(*addr)
		ip := net.ParseIP(host)
		if splitErr != nil || ip == nil || !ip.IsLoopback() {
			fatal("refusing TCP listener", fmt.Errorf("--addr must use a literal loopback IP"))
		}
	}

	if runtimeIdentity != nil {
		metrics.SetAgentHome(runtimeIdentity.Home)
	}
	metrics.Start() // begin the background CPU sampler (host metrics for nodeInfo)
	// A fresh daemon owns no sessions yet, so any leftover scoped-config temp dirs
	// are orphans from a prior crashed/killed run — sweep them so /tmp doesn't grow
	// unbounded across restarts.
	sweepStaleConfigDirs()
	mgr := session.NewManager()
	layouts, err := layout.Open(filepath.Join(*stateDir, "layouts"))
	if err != nil {
		fatal("open layout store", err)
	}
	srv := server.New(mgr, resolveVersion(), *nodeID, resolvedSecret, *secretFile, layouts, runtimeIdentity)

	var lns []net.Listener

	// Unix socket (local node path).
	if *socket != "" {
		var controlGID *uint32
		if runtimeIdentity != nil {
			gid, groupErr := identity.ResolveGroupID(*controlGroup)
			if groupErr != nil {
				fatal("resolve control group", groupErr)
			}
			controlGID = &gid
		}
		_ = os.Remove(*socket)
		if err := os.MkdirAll(filepath.Dir(*socket), 0o700); err != nil {
			fatal("mkdir socket dir", err)
		}
		ln, err := net.Listen("unix", *socket)
		if err != nil {
			fatal("listen unix", err)
		}
		if controlGID != nil {
			// os.Chown takes int even though Linux gid_t is unsigned. Refuse a
			// value that the current architecture cannot represent instead of
			// wrapping a valid group id into a negative integer on 32-bit hosts.
			if uint64(*controlGID) > uint64(^uint(0)>>1) {
				fatal("chown unix socket", fmt.Errorf("control group id %d exceeds platform int range", *controlGID))
			}
			if err := os.Chown(*socket, 0, int(*controlGID)); err != nil {
				fatal("chown unix socket", err)
			}
			if err := os.Chmod(*socket, 0o660); err != nil {
				fatal("chmod unix socket", err)
			}
		} else {
			_ = os.Chmod(*socket, 0o600)
		}
		lns = append(lns, ln)
		fmt.Fprintf(os.Stderr, "[flock-agentd] listening on unix %s\n", *socket)
	}

	// Loopback TCP (reached over SSH direct-tcpip from the orchestrator).
	if *addr != "" {
		ln, err := net.Listen("tcp", *addr)
		if err != nil {
			fatal("listen tcp", err)
		}
		lns = append(lns, ln)
		fmt.Fprintf(os.Stderr, "[flock-agentd] listening on tcp %s\n", ln.Addr())
	}

	if len(lns) == 0 {
		fatal("no listeners", fmt.Errorf("set --socket and/or --addr"))
	}

	for _, ln := range lns {
		go func(l net.Listener) { _ = srv.Serve(l) }(ln)
	}

	// Graceful shutdown: kill all PTYs on SIGINT/SIGTERM.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	fmt.Fprintln(os.Stderr, "[flock-agentd] shutting down")
	for _, ln := range lns {
		_ = ln.Close()
	}
	// Graceful: SIGTERM agents + wait briefly so they can flush, then force-kill.
	mgr.Shutdown(5 * time.Second)
	if *socket != "" {
		_ = os.Remove(*socket)
	}
}

func readCredentialFile(path string, secure bool) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("credential path is not a regular file")
	}
	if info.Mode().Perm()&0o007 != 0 {
		return "", fmt.Errorf("credential file must not be accessible by other users")
	}
	if secure {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || stat.Uid != 0 {
			return "", fmt.Errorf("credential file must be owned by root")
		}
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(body))
	if len(value) < 32 {
		return "", fmt.Errorf("credential must contain at least 32 characters")
	}
	return value, nil
}

// sweepStaleConfigDirs removes orphaned per-session scoped-config dirs left in
// TempDir by a prior crashed/SIGKILLed daemon (finalize() removes them on a clean
// session end, but not if the daemon dies first).
func sweepStaleConfigDirs() {
	matches, _ := filepath.Glob(filepath.Join(os.TempDir(), "flock-session-config-*"))
	for _, d := range matches {
		_ = os.RemoveAll(d)
	}
}

func defaultStateDir() string {
	if dir := os.Getenv("XDG_STATE_HOME"); dir != "" {
		return filepath.Join(dir, "flock-agentd")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "state", "flock-agentd")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("flock-agentd-state-%d", os.Getuid()))
}

func defaultSocket() string {
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		return filepath.Join(dir, "flock-agentd.sock")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("flock-agentd-%d.sock", os.Getuid()))
}

func fatal(what string, err error) {
	fmt.Fprintf(os.Stderr, "[flock-agentd] fatal: %s: %v\n", what, err)
	os.Exit(1)
}
