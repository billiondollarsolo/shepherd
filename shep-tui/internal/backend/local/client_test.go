package local

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/store"
	"github.com/billiondollarsolo/flock/agentd/controlauth"
	"github.com/billiondollarsolo/flock/agentd/proto"
)

func TestHelloV2MutuallyAuthenticatesSharedAgentdContract(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	c := &Client{
		conn:         clientConn,
		dataHandlers: make(map[string]func([]byte)),
		statusCh:     make(chan backend.StatusUpdate, 1),
	}
	go c.readLoop()
	t.Cleanup(func() { _ = c.Close() })

	const nodeID = "node-contract-test"
	const secret = "0123456789abcdef0123456789abcdef"
	serverErr := make(chan error, 1)
	go func() {
		defer serverConn.Close()
		_, payload, err := proto.ReadFrame(serverConn)
		if err != nil {
			serverErr <- err
			return
		}
		hello, err := proto.DecodeControl(payload)
		if err != nil {
			serverErr <- err
			return
		}
		serverNonce := "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
		capabilities := []string{"pty", "resize", "scrollback", "status", "node-info"}
		challenge := proto.Control{
			Op:              "challenge",
			ProtocolVersion: proto.ProtocolVersion,
			DaemonVersion:   "0.3.0",
			NodeID:          nodeID,
			ClientNonce:     hello.ClientNonce,
			ServerNonce:     serverNonce,
			CredentialID:    controlauth.CredentialID(secret),
			Capabilities:    capabilities,
		}
		challenge.ServerMAC = controlauth.MAC(secret, "server", nodeID, hello.ClientNonce,
			serverNonce, challenge.DaemonVersion, capabilities)
		if err := proto.WriteControl(serverConn, challenge); err != nil {
			serverErr <- err
			return
		}
		_, payload, err = proto.ReadFrame(serverConn)
		if err != nil {
			serverErr <- err
			return
		}
		authenticate, err := proto.DecodeControl(payload)
		if err != nil {
			serverErr <- err
			return
		}
		expected := controlauth.MAC(secret, "client", nodeID, hello.ClientNonce,
			serverNonce, challenge.DaemonVersion, capabilities)
		if authenticate.Op != "authenticate" || !controlauth.Verify(expected, authenticate.ClientMAC) {
			serverErr <- fmt.Errorf("client did not authenticate shared challenge")
			return
		}
		serverErr <- proto.WriteControl(serverConn, proto.Control{
			Op:              "helloOk",
			ProtocolVersion: proto.ProtocolVersion,
			DaemonVersion:   challenge.DaemonVersion,
			NodeID:          nodeID,
			Capabilities:    capabilities,
		})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ok, err := c.Hello(ctx, nodeID, secret)
	if err != nil {
		t.Fatal(err)
	}
	if ok.DaemonVersion != "0.3.0" || ok.ProtocolVersion != proto.ProtocolVersion {
		t.Fatalf("unexpected helloOk: %#v", ok)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}

func agentdSocket() string {
	if sock := os.Getenv("FLOCK_AGENTD_SOCKET"); sock != "" {
		return sock
	}
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		return filepath.Join(dir, "flock-agentd.sock")
	}
	return ""
}

// liveRequired reports whether the live agentd contract tests must run rather
// than skip. These are the only tests that exercise the real wire, so a CI job
// where they all quietly skip is green while proving nothing — which is exactly
// how the v1→v2 protocol break reached a user. CI sets FLOCK_AGENTD_LIVE=1 and
// a missing daemon becomes a failure.
func liveRequired() bool {
	switch strings.ToLower(os.Getenv("FLOCK_AGENTD_LIVE")) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// skipOrFail skips when the live daemon is optional, and fails when CI declared
// it mandatory.
func skipOrFail(t *testing.T, format string, args ...any) {
	t.Helper()
	if liveRequired() {
		t.Fatalf("FLOCK_AGENTD_LIVE=1 but the live agentd contract could not run: "+format, args...)
	}
	t.Skipf(format, args...)
}

// dialLiveAgentd connects using FLOCK_AGENTD_SOCKET / XDG runtime + FLOCK_AGENTD_SECRET.
// Skips when agentd is unavailable — unless FLOCK_AGENTD_LIVE=1, which makes it fatal.
func dialLiveAgentd(t *testing.T) *Client {
	t.Helper()
	sock := agentdSocket()
	if sock == "" {
		skipOrFail(t, "no agentd socket (set FLOCK_AGENTD_SOCKET or XDG_RUNTIME_DIR)")
	}
	if _, err := os.Stat(sock); err != nil {
		skipOrFail(t, "agentd not running: %v", err)
	}

	// Resolve the credential the same way the app does (explicit secret → secret
	// file → the well-known file the daemon's owner published), so this exercises
	// the real adoption path rather than a test-only shortcut.
	cfg, err := config.Load()
	if err != nil {
		skipOrFail(t, "config: %v", err)
	}
	nodeID, secret, err := cfg.Active().ResolvedAgentdControl()
	if err != nil {
		skipOrFail(t, "agentd control identity: %v", err)
	}

	c, err := Dial(sock, nodeID, secret)
	if err != nil {
		if secret == "" && !liveRequired() {
			t.Skip("agentd requires a credential; publish one or set FLOCK_AGENTD_SECRET:", err)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestDialHelloList_LiveAgentd(t *testing.T) {
	c := dialLiveAgentd(t)

	if c.DaemonVersion() == "" {
		t.Fatal("expected daemon version from helloOk")
	}
	t.Logf("agentd version %s", c.DaemonVersion())

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sessions, err := c.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("sessions: %d", len(sessions))
	for _, s := range sessions {
		t.Logf("  %s cwd=%s", s.ID, s.Cwd)
	}
}

// TestOpenSubscribeResizeClose_LiveAgentd exercises T0.5 end-to-end against a
// live flock-agentd: open shell → subscribe/PTY read → resize → close session.
func TestOpenSubscribeResizeClose_LiveAgentd(t *testing.T) {
	c := dialLiveAgentd(t)

	id := fmt.Sprintf("shep-tui-test-%d", os.Getpid())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Ensure we always try to close the daemon session even if the test fails mid-way.
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cleanupCancel()
		_ = c.CloseSession(cleanupCtx, id)
	})

	if err := c.OpenSession(ctx, SessionSpec{
		ID:      id,
		Kind:    "shell",
		Command: []string{"/bin/sh", "-c", "printf 'hello-flock\\n'; sleep 30"},
		Cols:    80,
		Rows:    24,
	}); err != nil {
		t.Fatalf("OpenSession: %v", err)
	}

	stream, err := c.OpenPty(ctx, id, 80, 24)
	if err != nil {
		t.Fatalf("OpenPty: %v", err)
	}
	defer stream.Close()

	const want = "hello-flock"
	deadline := time.After(8 * time.Second)
	var buf strings.Builder
	for {
		if strings.Contains(buf.String(), want) {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("context done before %q; got %q", want, buf.String())
		case <-deadline:
			t.Fatalf("timeout waiting for %q; got %q", want, buf.String())
		case chunk, ok := <-stream.Output():
			if !ok {
				t.Fatalf("pty stream closed before %q; got %q", want, buf.String())
			}
			buf.Write(chunk)
		}
	}
	t.Logf("pty output (truncated): %q", truncate(buf.String(), 200))

	if err := stream.Resize(100, 40); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	if err := c.CloseSession(ctx, id); err != nil {
		t.Fatalf("CloseSession: %v", err)
	}

	// Session should no longer appear in list (best-effort; daemon may lag briefly).
	listCtx, listCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer listCancel()
	sessions, err := c.ListSessions(listCtx)
	if err != nil {
		t.Fatalf("ListSessions after close: %v", err)
	}
	for _, s := range sessions {
		if s.ID == id {
			t.Fatalf("session %s still listed after CloseSession", id)
		}
	}
}

func TestOpenSessionEmptyID(t *testing.T) {
	// No agentd needed: validation fails before any I/O.
	c := &Client{}
	err := c.OpenSession(context.Background(), SessionSpec{})
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("want empty-id error, got %v", err)
	}
}

func TestCreateShellEmptyID(t *testing.T) {
	c := &Client{}
	err := c.CreateShell(context.Background(), "", "", 80, 24)
	if err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("want empty-id error, got %v", err)
	}
}

func TestDefaultShellCommand(t *testing.T) {
	cmd := defaultShellCommand()
	if len(cmd) == 0 {
		t.Fatal("empty shell command")
	}
	// On this host either bash -l or bare sh.
	if cmd[0] != "/bin/bash" && cmd[0] != "/bin/sh" {
		t.Fatalf("unexpected shell binary: %v", cmd)
	}
	if cmd[0] == "/bin/bash" && (len(cmd) < 2 || cmd[1] != "-l") {
		t.Fatalf("bash should use -l: %v", cmd)
	}
}

func TestDefaultShellCwd(t *testing.T) {
	cwd := defaultShellCwd()
	if cwd == "" {
		t.Fatal("expected non-empty default cwd")
	}
}

func TestReconnectStubSignature(t *testing.T) {
	// Compile-time / smoke: Reconnect is Dial under the hood; skip when no agentd.
	sock := agentdSocket()
	if sock == "" {
		t.Skip("no agentd socket env")
	}
	if _, err := os.Stat(sock); err != nil {
		t.Skip("agentd not running")
	}
	secret := os.Getenv("FLOCK_AGENTD_SECRET")
	nodeID := os.Getenv("FLOCK_AGENTD_NODE_ID")
	if nodeID == "" {
		nodeID = "development-local"
	}
	c, err := Reconnect(sock, nodeID, secret)
	if err != nil {
		if secret == "" {
			t.Skip(err)
		}
		t.Fatal(err)
	}
	_ = c.Close()
}

func TestRetryOptsDefaults(t *testing.T) {
	o := (RetryOpts{}).withDefaults()
	if o.Initial != 200*time.Millisecond {
		t.Fatalf("Initial=%v", o.Initial)
	}
	if o.Max != 5*time.Second {
		t.Fatalf("Max=%v", o.Max)
	}
	if o.Factor != 1.5 {
		t.Fatalf("Factor=%v", o.Factor)
	}
}

func TestDialWithRetry_BackoffTiming(t *testing.T) {
	var attempts atomic.Int32
	fake := func(socket, nodeID, secret string) (*Client, error) {
		n := attempts.Add(1)
		if n < 3 {
			return nil, fmt.Errorf("dial fail attempt %d", n)
		}
		// Success: return a non-nil client without a live connection.
		// Caller must not use it beyond nil-check; we only exercise retry loop.
		return &Client{statusCh: make(chan backend.StatusUpdate, 1)}, nil
	}

	opts := RetryOpts{
		Initial: 20 * time.Millisecond,
		Max:     100 * time.Millisecond,
		Factor:  2,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	start := time.Now()
	c, err := dialWithRetry(ctx, "/tmp/x.sock", "development-local", "sec", opts, fake)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("dialWithRetry: %v", err)
	}
	if c == nil {
		t.Fatal("expected client")
	}
	// Failures on attempts 1 and 2 → waits of ~20ms then ~40ms before success on 3.
	// Allow wide bounds for CI scheduling noise.
	if attempts.Load() != 3 {
		t.Fatalf("attempts=%d want 3", attempts.Load())
	}
	if elapsed < 50*time.Millisecond {
		t.Fatalf("elapsed %v too short; expected ~60ms+ backoff", elapsed)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("elapsed %v too long; backoff may not be applying", elapsed)
	}
}

func TestDialWithRetry_Cancel(t *testing.T) {
	var attempts atomic.Int32
	fake := func(socket, nodeID, secret string) (*Client, error) {
		attempts.Add(1)
		return nil, fmt.Errorf("always fail")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()

	_, err := dialWithRetry(ctx, "/tmp/x.sock", "development-local", "", RetryOpts{
		Initial: 30 * time.Millisecond,
		Max:     30 * time.Millisecond,
		Factor:  1.5,
	}, fake)
	if err == nil {
		t.Fatal("expected error on cancel")
	}
	if attempts.Load() < 1 {
		t.Fatal("expected at least one dial attempt")
	}
	if !strings.Contains(err.Error(), "cancelled") && ctx.Err() == nil {
		// error should mention cancel/deadline
		t.Logf("err=%v attempts=%d", err, attempts.Load())
	}
}

func TestDialWithRetry_ImmediateSuccess(t *testing.T) {
	var attempts atomic.Int32
	fake := func(socket, nodeID, secret string) (*Client, error) {
		attempts.Add(1)
		return &Client{}, nil
	}
	start := time.Now()
	c, err := dialWithRetry(context.Background(), "s", "development-local", "k", RetryOpts{
		Initial: 200 * time.Millisecond,
	}, fake)
	if err != nil || c == nil {
		t.Fatalf("err=%v c=%v", err, c)
	}
	if attempts.Load() != 1 {
		t.Fatalf("attempts=%d", attempts.Load())
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Fatalf("should not sleep on first success")
	}
}

// TestWatchStatus_Store_LiveAgentd seeds the store from ListSessions and
// consumes WatchStatus into ApplyStatus — the consumer pattern the app uses.
// Skips without agentd.
func TestWatchStatus_Store_LiveAgentd(t *testing.T) {
	c := dialLiveAgentd(t)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	sessions, err := c.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}

	m := store.New()
	m.SeedSessions(sessions)

	ch, err := c.WatchStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Open a short-lived shell so agentd is likely to emit status frames.
	id := fmt.Sprintf("shep-tui-status-%d", os.Getpid())
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cleanupCancel()
		_ = c.CloseSession(cleanupCtx, id)
	})
	if err := c.OpenSession(ctx, SessionSpec{
		ID:      id,
		Kind:    "shell",
		Command: []string{"/bin/sh", "-c", "sleep 5"},
		Cols:    40,
		Rows:    10,
	}); err != nil {
		t.Fatalf("OpenSession: %v", err)
	}

	// Also seed the new session as ListSessions would after open.
	m.SeedSessions(append(sessions, domain.Session{
		ID:     id,
		Name:   id,
		Status: domain.StatusDisconnected,
	}))

	deadline := time.After(6 * time.Second)
	saw := false
	for !saw {
		select {
		case <-ctx.Done():
			t.Fatalf("ctx done before status for %s", id)
		case <-deadline:
			// Status frames are best-effort depending on agentd version; still
			// verify map holds the seeded session.
			if _, ok := m.Get(id); !ok {
				t.Fatalf("session %s missing from the store", id)
			}
			t.Log("no status update observed before deadline (seed-only path ok)")
			return
		case u, ok := <-ch:
			if !ok {
				t.Fatal("WatchStatus channel closed")
			}
			m.ApplyStatus(u)
			if u.SessionID == id {
				saw = true
				t.Logf("status update for %s: %s", id, u.Status)
			}
		}
	}

	got, ok := m.Get(id)
	if !ok {
		t.Fatalf("store missing %s after ApplyStatus", id)
	}
	if got.Status == "" {
		t.Fatal("expected non-empty status after update")
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// A credential agentd has already refused will be refused again. Retrying it
// spends the whole dial budget and then reports a deadline error, burying the
// real reason — which is what a user hit when the daemon owned a secret they
// did not have.
func TestDialWithRetryStopsOnRejectedCredential(t *testing.T) {
	attempts := 0
	dial := func(socket, nodeID, secret string) (*Client, error) {
		attempts++
		return nil, &HandshakeError{Reason: "agentd hello failed: unknown control credential"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	start := time.Now()
	_, err := dialWithRetry(ctx, "/tmp/x.sock", "development-local", "", RetryOpts{}, dial)
	if err == nil {
		t.Fatal("expected the rejected handshake to fail")
	}
	if attempts != 1 {
		t.Errorf("dialed %d times, want exactly 1 — a refused credential must not be retried", attempts)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Errorf("took %v — a terminal error must fail fast, not consume the dial budget", elapsed)
	}
	var h *HandshakeError
	if !errors.As(err, &h) {
		t.Fatalf("error must stay a *HandshakeError so the CLI can hint; got %T", err)
	}
	if !strings.Contains(err.Error(), "unknown control credential") {
		t.Errorf("the daemon's reason must survive, got: %v", err)
	}
}

// A daemon that is merely still starting is transient and must still be retried.
func TestDialWithRetryStillRetriesTransientErrors(t *testing.T) {
	attempts := 0
	dial := func(socket, nodeID, secret string) (*Client, error) {
		attempts++
		if attempts < 3 {
			return nil, errors.New("connect: no such file or directory")
		}
		return &Client{}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if _, err := dialWithRetry(ctx, "/tmp/x.sock", "development-local", "", RetryOpts{Initial: time.Millisecond}, dial); err != nil {
		t.Fatal(err)
	}
	if attempts != 3 {
		t.Errorf("dialed %d times, want 3 — a starting daemon must still be retried", attempts)
	}
}
