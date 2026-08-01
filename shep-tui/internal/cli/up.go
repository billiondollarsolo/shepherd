package cli

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend/local"
	"github.com/billiondollarsolo/shep-tui/internal/config"
)

const agentdLogPath = "/tmp/shep-tui-agentd.log"

// up ensures a local flock-agentd is dialable (start one if needed).
func up() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	active := cfg.Active()
	if active.Mode == config.ModeFleet {
		return fmt.Errorf("up is for local agentd only (profile %q is fleet)", cfg.DefaultProfile)
	}

	sock := active.ResolvedSocket()
	nodeID, secret, err := active.ResolvedAgentdControl()
	if err != nil {
		return fmt.Errorf("agentd control identity: %w", err)
	}

	if ver, err := tryHello(sock, nodeID, secret); err == nil {
		fmt.Printf("already running (daemon %s)\n", ver)
		fmt.Printf("  socket: %s\n", sock)
		return nil
	} else if err != nil {
		// Socket is up but auth/protocol failed — don't spawn a second agentd.
		if _, stErr := os.Stat(sock); stErr == nil && isHelloAuthOrProto(err) {
			fmt.Fprintf(os.Stderr, "agentd socket exists but hello failed: %v\n", err)
			fmt.Fprintf(os.Stderr, "  socket: %s\n", sock)
			if secret == "" {
				fmt.Fprintln(os.Stderr, "  hint:   set FLOCK_AGENTD_NODE_ID and FLOCK_AGENTD_SECRET_FILE to match the running daemon")
			} else {
				fmt.Fprintln(os.Stderr, "  hint:   secret may not match the running daemon; check agentd config")
			}
			return fmt.Errorf("local agentd not usable (hello failed)")
		}
	}

	bin, err := findAgentdBinary()
	if err != nil {
		printUpInstructions(sock, err)
		return fmt.Errorf("local agentd not running and could not start automatically")
	}

	// No daemon is running, so this process owns the new one — which means it also
	// owns its credential. Mint one and persist it 0600 rather than starting an
	// unauthenticated daemon: every later shep-tui run (and any other local
	// client) then adopts it from the file, with nothing for the user to carry.
	if secret == "" {
		credFile := config.DefaultAgentdCredentialFile()
		secret, err = newAgentdCredential()
		if err != nil {
			return fmt.Errorf("generate agentd credential: %w", err)
		}
		if err := config.WriteAgentdCredential(credFile, secret); err != nil {
			return fmt.Errorf("persist agentd credential: %w", err)
		}
		fmt.Printf("  credential: %s (generated, 0600)\n", credFile)
	}

	fmt.Printf("starting %s serve …\n", bin)
	if err := startAgentd(bin, sock, nodeID, secret); err != nil {
		printUpInstructions(sock, err)
		return fmt.Errorf("failed to start agentd: %w", err)
	}

	// Wait for socket + hello.
	deadline := time.Now().Add(8 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		ver, err := tryHello(sock, nodeID, secret)
		if err == nil {
			fmt.Printf("agentd ready (daemon %s)\n", ver)
			fmt.Printf("  socket: %s\n", sock)
			fmt.Printf("  log:    %s\n", agentdLogPath)
			return nil
		}
		lastErr = err
		time.Sleep(150 * time.Millisecond)
	}

	printUpInstructions(sock, lastErr)
	return fmt.Errorf("agentd started but hello failed: %v (see %s)", lastErr, agentdLogPath)
}

func tryHello(sock, nodeID, secret string) (daemonVersion string, err error) {
	client, err := local.Dial(sock, nodeID, secret)
	if err != nil {
		return "", err
	}
	ver := client.DaemonVersion()
	_ = client.Close()
	return ver, nil
}

func isHelloAuthOrProto(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "unauthorized") ||
		strings.Contains(s, "hello failed") ||
		strings.Contains(s, "protocol")
}

func findAgentdBinary() (string, error) {
	if p, err := exec.LookPath("flock-agentd"); err == nil {
		return p, nil
	}

	arch := runtime.GOARCH
	names := []string{
		"flock-agentd",
		"flock-agentd-linux-" + arch,
		"flock-agentd-linux-amd64",
		"flock-agentd-linux-arm64",
	}

	var bases []string
	bases = append(bases,
		filepath.Join("..", "flock", "agentd", "dist"),
		filepath.Join("flock", "agentd", "dist"),
	)
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		bases = append(bases,
			filepath.Join(exeDir, "..", "..", "flock", "agentd", "dist"),
			filepath.Join(exeDir, "..", "flock", "agentd", "dist"),
			filepath.Join(exeDir, "dist"),
		)
	}
	if wd, err := os.Getwd(); err == nil {
		bases = append(bases, filepath.Join(wd, "..", "flock", "agentd", "dist"))
	}

	candidates := []string{"/tmp/flock-agentd"}
	for _, base := range bases {
		for _, name := range names {
			candidates = append(candidates, filepath.Join(base, name))
		}
	}

	for _, c := range candidates {
		st, err := os.Stat(c)
		if err != nil || st.IsDir() {
			continue
		}
		// Prefer something executable by us.
		if st.Mode()&0o111 != 0 {
			if abs, err := filepath.Abs(c); err == nil {
				return abs, nil
			}
			return c, nil
		}
	}
	return "", fmt.Errorf("flock-agentd not in PATH, ../flock/agentd/dist/, or /tmp/flock-agentd")
}

func startAgentd(bin, sock, nodeID, secret string) error {
	logf, err := os.OpenFile(agentdLogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open log %s: %w", agentdLogPath, err)
	}

	cmd := exec.Command(bin, "serve", "--allow-insecure-same-user")
	cmd.Stdout = logf
	cmd.Stderr = logf
	// Detach from our process group so agentd survives shep-tui exit.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	env := os.Environ()
	if sock != "" {
		env = putEnv(env, "FLOCK_AGENTD_SOCKET", sock)
	}
	if secret != "" {
		env = putEnv(env, "FLOCK_AGENTD_SECRET", secret)
	}
	env = putEnv(env, "FLOCK_AGENTD_NODE_ID", nodeID)
	cmd.Env = env

	if err := cmd.Start(); err != nil {
		_ = logf.Close()
		return err
	}
	// Reap in background so we don't leave a zombie; agentd is long-lived.
	go func() {
		_ = cmd.Wait()
		_ = logf.Close()
	}()
	return nil
}

func putEnv(env []string, key, val string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	found := false
	for _, e := range env {
		if len(e) >= len(prefix) && e[:len(prefix)] == prefix {
			out = append(out, prefix+val)
			found = true
			continue
		}
		out = append(out, e)
	}
	if !found {
		out = append(out, prefix+val)
	}
	return out
}

func printUpInstructions(sock string, cause error) {
	fmt.Fprintln(os.Stderr, "could not ensure local agentd is running")
	if cause != nil {
		fmt.Fprintf(os.Stderr, "  last error: %v\n", cause)
	}
	fmt.Fprintf(os.Stderr, "  expected socket: %s\n", sock)
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Start agentd manually, then re-run: shep-tui up")
	fmt.Fprintln(os.Stderr, "  flock-agentd serve")
	fmt.Fprintln(os.Stderr, "  # from Flock monorepo (dev):")
	fmt.Fprintln(os.Stderr, "  #   make run-dev   # or agentd serve via your usual workflow")
	fmt.Fprintln(os.Stderr, "  #   ../flock/agentd/dist/flock-agentd-linux-amd64 serve")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Optional env:")
	fmt.Fprintln(os.Stderr, "  FLOCK_AGENTD_SOCKET   unix path (default: XDG runtime)")
	fmt.Fprintln(os.Stderr, "  FLOCK_AGENTD_SECRET   shared secret if agentd requires it")
	fmt.Fprintln(os.Stderr, "  FLOCK_AGENTD_NODE_ID  stable daemon identity (default: development-local)")
	fmt.Fprintln(os.Stderr, "  FLOCK_AGENTD_SECRET_FILE  protected credential file for prepared nodes")
	fmt.Fprintf(os.Stderr, "Auto-start log (if we launched agentd): %s\n", agentdLogPath)
	fmt.Fprintln(os.Stderr, "Then: shep-tui doctor")
}

// newAgentdCredential mints a 256-bit control credential (agentd requires >= 32
// characters).
func newAgentdCredential() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
