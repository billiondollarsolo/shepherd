package cli

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
)

func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	runErr := fn()
	_ = w.Close()
	os.Stdout = old
	var buf bytes.Buffer
	_, _ = io.Copy(&buf, r)
	_ = r.Close()
	return buf.String(), runErr
}

func TestRunVersion(t *testing.T) {
	out, err := captureStdout(t, func() error {
		return Run("1.2.3-test", []string{"version"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(out) != "1.2.3-test" {
		t.Fatalf("version out = %q", out)
	}
}

func TestRunVersionFlags(t *testing.T) {
	for _, flag := range []string{"--version", "-V"} {
		out, err := captureStdout(t, func() error {
			return Run("v", []string{flag})
		})
		if err != nil {
			t.Fatalf("%s: %v", flag, err)
		}
		if strings.TrimSpace(out) != "v" {
			t.Fatalf("%s out = %q", flag, out)
		}
	}
}

func TestRunHelp(t *testing.T) {
	out, err := captureStdout(t, func() error {
		return Run("dev", []string{"help"})
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"doctor", "up", "sessions list|spawn",
		"profiles list", "compare", "cost", "version",
		"standalone", "no SSH",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("help missing %q; got:\n%s", want, out)
		}
	}
}

func TestRunEmptyStartsTUIPath(t *testing.T) {
	// Empty args invoke the interactive TUI path. In non-TTY test harnesses
	// this fails fast without entering alt-screen.
	err := Run("dev", nil)
	if err == nil {
		t.Fatal("expected TUI path to fail in this environment")
	}
	msg := err.Error()
	if strings.Contains(msg, "unknown command") {
		t.Fatalf("empty args should start TUI, not route as unknown: %v", err)
	}
	// Prefer the explicit non-TTY guard when stdin/stdout are not terminals.
	if !strings.Contains(msg, "terminal") && !strings.Contains(msg, "tty") &&
		!strings.Contains(msg, "agentd") && !strings.Contains(msg, "config") {
		t.Fatalf("unexpected empty-args error: %v", err)
	}
}

func TestRunUnknown(t *testing.T) {
	err := Run("dev", []string{"not-a-command"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "unknown command") {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestRunSessionsRouting(t *testing.T) {
	err := Run("dev", []string{"sessions"})
	if err == nil {
		t.Fatal("expected usage error")
	}
	if !strings.Contains(err.Error(), "usage: shep-tui sessions") {
		t.Fatalf("unexpected: %v", err)
	}

	err = Run("dev", []string{"sessions", "nope"})
	if err == nil {
		t.Fatal("expected unknown subcommand")
	}
	if !strings.Contains(err.Error(), "unknown sessions subcommand") {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestRunSessionsHelp(t *testing.T) {
	out, err := captureStdout(t, func() error {
		return Run("dev", []string{"sessions", "help"})
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"sessions list", "spawn", "wait", "explain", "prompt", "send", "export"} {
		if !strings.Contains(out, want) {
			t.Fatalf("help missing %q; out = %q", want, out)
		}
	}
}

func TestRunSessionsWaitRouting(t *testing.T) {
	err := Run("dev", []string{"sessions", "wait"})
	if err == nil {
		t.Fatal("expected usage error")
	}
	if !strings.Contains(err.Error(), "usage: shep-tui sessions wait") {
		t.Fatalf("unexpected: %v", err)
	}

	err = Run("dev", []string{"sessions", "wait", "sid", "--for", "bogus"})
	if err == nil {
		t.Fatal("expected bad --for")
	}
	if !strings.Contains(err.Error(), "--for") {
		t.Fatalf("unexpected: %v", err)
	}

	// Bad timeout should fail before dial.
	err = Run("dev", []string{"sessions", "wait", "sid", "--for", "idle", "--timeout", "nope"})
	if err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("expected timeout parse error, got %v", err)
	}
}

func TestRunSessionsSendRouting(t *testing.T) {
	err := Run("dev", []string{"sessions", "send"})
	if err == nil {
		t.Fatal("expected usage")
	}
	if !strings.Contains(err.Error(), "usage: shep-tui sessions send") {
		t.Fatalf("unexpected: %v", err)
	}
	err = Run("dev", []string{"sessions", "send", "sid"})
	if err == nil || !strings.Contains(err.Error(), "usage:") {
		t.Fatalf("expected usage without --text: %v", err)
	}
}

func TestRunSessionsExportRouting(t *testing.T) {
	err := Run("dev", []string{"sessions", "export"})
	if err == nil {
		t.Fatal("expected usage")
	}
	if !strings.Contains(err.Error(), "export") {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestParseWaitArgs(t *testing.T) {
	id, want, timeout, err := parseWaitArgs([]string{"abc", "--for", "needs-you", "--timeout", "5s"})
	if err != nil {
		t.Fatal(err)
	}
	if id != "abc" || want != "needs-you" || timeout != 5*time.Second {
		t.Fatalf("got %q %q %v", id, want, timeout)
	}
}

func TestParseExplainArgs(t *testing.T) {
	id, err := parseExplainArgs([]string{"sess-1"})
	if err != nil || id != "sess-1" {
		t.Fatalf("got %q %v", id, err)
	}
	if _, err := parseExplainArgs(nil); err == nil {
		t.Fatal("expected usage without id")
	}
	if _, err := parseExplainArgs([]string{"--bogus"}); err == nil {
		t.Fatal("expected unknown flag")
	}
}

func TestParsePromptArgs(t *testing.T) {
	id, text, err := parsePromptArgs([]string{"s1", "--text", "hello world"})
	if err != nil || id != "s1" || text != "hello world" {
		t.Fatalf("got %q %q %v", id, text, err)
	}
	id, text, err = parsePromptArgs([]string{"--text=y", "s2"})
	if err != nil || id != "s2" || text != "y" {
		t.Fatalf("equals form: %q %q %v", id, text, err)
	}
	if _, _, err := parsePromptArgs([]string{"only-id"}); err == nil {
		t.Fatal("expected --text required")
	}
}

func TestWaitUntilWire(t *testing.T) {
	if got := waitUntilWire("needs-you"); len(got) != 1 || got[0] != "awaiting_input" {
		t.Fatalf("needs-you → %v", got)
	}
	if got := waitUntilWire("idle"); len(got) != 1 || got[0] != "idle" {
		t.Fatalf("idle → %v", got)
	}
}

func TestStatusMatches(t *testing.T) {
	if !statusMatches(domain.StatusAwaitingInput, "needs-you") {
		t.Fatal("needs-you")
	}
	if !statusMatches(domain.StatusIdle, "idle") {
		t.Fatal("idle")
	}
	if statusMatches(domain.StatusRunning, "done") {
		t.Fatal("running != done")
	}
}

func TestSessionsHelpDocumentsAgentControl(t *testing.T) {
	out, err := captureStdout(t, func() error {
		return sessions([]string{"help"})
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"explain", "prompt", "wait", "agent_control"} {
		if !strings.Contains(out, want) {
			t.Fatalf("sessions help missing %q; got:\n%s", want, out)
		}
	}
	// Help text function stays in sync with dispatch.
	h := sessionsHelpText()
	if !strings.Contains(h, "sessions explain") || !strings.Contains(h, "sessions prompt") {
		t.Fatalf("sessionsHelpText incomplete: %s", h)
	}
}

func TestSessionsExplainOnUsesAgentController(t *testing.T) {
	be := &controlStub{
		explain: map[string]any{"state": "awaiting_input", "matchedRule": "claude_permission"},
	}
	out, err := captureStdout(t, func() error {
		return sessionsExplainOn(be, "s-explain")
	})
	if err != nil {
		t.Fatal(err)
	}
	if be.explainID != "s-explain" {
		t.Fatalf("explain called with id %q", be.explainID)
	}
	if !strings.Contains(out, "awaiting_input") || !strings.Contains(out, "claude_permission") {
		t.Fatalf("explain JSON = %s", out)
	}
}

func TestSessionsExplainOnRequiresAgentController(t *testing.T) {
	err := sessionsExplainOn(&stubBackend{}, "x")
	if err == nil || !strings.Contains(err.Error(), "agent control") {
		t.Fatalf("expected agent control error, got %v", err)
	}
}

func TestSessionsPromptOnUsesAgentController(t *testing.T) {
	be := &controlStub{}
	out, err := captureStdout(t, func() error {
		return sessionsPromptOn(be, "s-prompt", "continue please")
	})
	if err != nil {
		t.Fatal(err)
	}
	if be.promptID != "s-prompt" || be.promptText != "continue please" {
		t.Fatalf("prompt args id=%q text=%q", be.promptID, be.promptText)
	}
	if !strings.Contains(out, "s-prompt") {
		t.Fatalf("prompt out = %q", out)
	}
}

func TestSessionsPromptOnRequiresAgentController(t *testing.T) {
	err := sessionsPromptOn(&stubBackend{}, "x", "hi")
	if err == nil || !strings.Contains(err.Error(), "agent control") {
		t.Fatalf("expected agent control error, got %v", err)
	}
}

func TestSessionsWaitOnPrefersServerWait(t *testing.T) {
	be := &controlStub{
		hasControl: true,
		waitState:  "idle",
	}
	out, err := captureStdout(t, func() error {
		return sessionsWaitOn(be, "s-wait", "idle", 2*time.Second)
	})
	if err != nil {
		t.Fatal(err)
	}
	if be.waitID != "s-wait" {
		t.Fatalf("wait id = %q", be.waitID)
	}
	if len(be.waitUntil) != 1 || be.waitUntil[0] != "idle" {
		t.Fatalf("wait until = %v", be.waitUntil)
	}
	if !strings.Contains(out, "s-wait") || !strings.Contains(out, "idle") {
		t.Fatalf("wait out = %q", out)
	}
	// Poll path must not have been used when server wait succeeds.
	if be.listCalls != 0 {
		t.Fatalf("expected no list poll when server wait works; listCalls=%d", be.listCalls)
	}
}

func TestSessionsWaitOnNeedsYouMapsToAwaitingInput(t *testing.T) {
	be := &controlStub{hasControl: true, waitState: "awaiting_input"}
	_, err := captureStdout(t, func() error {
		return sessionsWaitOn(be, "s1", "needs-you", time.Second)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(be.waitUntil) != 1 || be.waitUntil[0] != "awaiting_input" {
		t.Fatalf("until = %v", be.waitUntil)
	}
}

func TestSessionsWaitOnFallsBackToPollWithoutControl(t *testing.T) {
	be := &controlStub{
		hasControl: false,
		sessions: []domain.Session{
			{ID: "poll-me", Status: domain.StatusIdle},
		},
	}
	out, err := captureStdout(t, func() error {
		return sessionsWaitOn(be, "poll-me", "idle", time.Second)
	})
	if err != nil {
		t.Fatal(err)
	}
	if be.waitID != "" {
		t.Fatal("server wait should not run without HasAgentControl")
	}
	if be.listCalls == 0 {
		t.Fatal("expected list poll fallback")
	}
	if !strings.Contains(out, "poll-me") {
		t.Fatalf("out = %q", out)
	}
}

func TestSessionsWaitOnPropagatesServerError(t *testing.T) {
	be := &controlStub{
		hasControl: true,
		waitErr:    fmt.Errorf("session wait: timeout after 1s"),
	}
	err := sessionsWaitOn(be, "slow", "done", time.Second)
	if err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("expected timeout error, got %v", err)
	}
	if be.listCalls != 0 {
		t.Fatal("must not fall back to poll on real server error")
	}
}

func TestSessionsDispatchRoutesExplainPrompt(t *testing.T) {
	// Unknown sub still errors; known routes must not be "unknown".
	err := sessions([]string{"nope"})
	if err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("unknown: %v", err)
	}
	// Usage errors come from real parse path (no backend open yet).
	err = sessions([]string{"explain"})
	if err == nil || !strings.Contains(err.Error(), "explain") {
		t.Fatalf("explain usage: %v", err)
	}
	err = sessions([]string{"prompt", "id-only"})
	if err == nil || !strings.Contains(err.Error(), "prompt") {
		t.Fatalf("prompt usage: %v", err)
	}
}

// controlStub implements Backend + AgentController for H2.4 CLI dispatch tests.
type controlStub struct {
	stubBackend
	hasControl bool
	sessions   []domain.Session
	listCalls  int

	explain   map[string]any
	explainID string
	explainErr error

	promptID   string
	promptText string
	promptErr  error

	waitID    string
	waitUntil []string
	waitState string
	waitErr   error
}

func (c *controlStub) ListSessions(ctx context.Context) ([]domain.Session, error) {
	c.listCalls++
	return c.sessions, nil
}

func (c *controlStub) HasAgentControl() bool { return c.hasControl }

func (c *controlStub) SessionExplain(ctx context.Context, sessionID string) (map[string]any, error) {
	c.explainID = sessionID
	if c.explainErr != nil {
		return nil, c.explainErr
	}
	out := map[string]any{"sessionId": sessionID}
	for k, v := range c.explain {
		out[k] = v
	}
	return out, nil
}

func (c *controlStub) SessionPrompt(ctx context.Context, sessionID, text string) error {
	c.promptID = sessionID
	c.promptText = text
	return c.promptErr
}

func (c *controlStub) SessionWaitStatus(ctx context.Context, sessionID string, until []string, timeout time.Duration) (string, error) {
	c.waitID = sessionID
	c.waitUntil = append([]string(nil), until...)
	if c.waitErr != nil {
		return "", c.waitErr
	}
	return c.waitState, nil
}

// Ensure controlStub satisfies AgentController at compile time.
var _ backend.AgentController = (*controlStub)(nil)

func TestRunProfilesRouting(t *testing.T) {
	err := Run("dev", []string{"profiles"})
	if err == nil {
		t.Fatal("expected usage")
	}
	out, err := captureStdout(t, func() error {
		return Run("dev", []string{"profiles", "list"})
	})
	if err != nil {
		t.Fatal(err)
	}
	// Default config always has local.
	if !strings.Contains(out, "local") {
		t.Fatalf("profiles list = %q", out)
	}
}

func TestRunCompareRouting(t *testing.T) {
	// The board is the backend's sessions or nothing: there is no fixture to print.
	if err := Run("dev", []string{"compare", "demo"}); err == nil {
		t.Fatal("compare no longer prints invented rows")
	}
	out, err := captureStdout(t, func() error {
		return Run("dev", []string{"compare", "help"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "compare") {
		t.Fatalf("compare help = %q", out)
	}
}

func TestRunAuditRouting(t *testing.T) {
	err := Run("dev", []string{"audit"})
	if err == nil {
		t.Fatal("expected usage")
	}
	// No backend today has an audit log. `audit list` must say so and fail: a
	// script cannot tell an empty board from an unimplemented one.
	if err := Run("dev", []string{"audit", "list"}); err == nil {
		t.Fatal("audit list exited 0 on a backend with no audit log")
	}
}

func TestRunCostHelp(t *testing.T) {
	out, err := captureStdout(t, func() error {
		return Run("dev", []string{"cost", "help"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "shep-tui cost") {
		t.Fatalf("cost help = %q", out)
	}
}

func TestEnsureDemoShells(t *testing.T) {
	// Success path: both shells open.
	be := &stubBackend{}
	got := ensureDemoShells(context.Background(), be)
	if len(got) != 2 {
		t.Fatalf("want 2 sessions, got %d", len(got))
	}
	if got[0].ID != demoPaneID0 || got[1].ID != demoPaneID1 {
		t.Fatalf("ids = %q %q", got[0].ID, got[1].ID)
	}
	if len(be.created) != 2 {
		t.Fatalf("created = %#v", be.created)
	}

	// Second CreateShell fails → keep only the first pane.
	be2 := &stubBackend{failOn: map[string]bool{demoPaneID1: true}}
	got = ensureDemoShells(context.Background(), be2)
	if len(got) != 1 || got[0].ID != demoPaneID0 {
		t.Fatalf("partial open: got %#v", got)
	}

	// First fails → empty list (no panes).
	be3 := &stubBackend{failOn: map[string]bool{demoPaneID0: true}}
	got = ensureDemoShells(context.Background(), be3)
	if len(got) != 0 {
		t.Fatalf("first fail should yield empty, got %#v", got)
	}
}

// stubBackend is a minimal backend.Backend for ensureDemoShells unit tests.
type stubBackend struct {
	created []string
	failOn  map[string]bool
}

func (s *stubBackend) Close() error { return nil }
func (s *stubBackend) ListSessions(ctx context.Context) ([]domain.Session, error) {
	return nil, nil
}
func (s *stubBackend) WatchStatus(ctx context.Context) (<-chan backend.StatusUpdate, error) {
	return nil, backend.ErrNotSupported
}
func (s *stubBackend) OpenPty(ctx context.Context, sessionID string, cols, rows uint16) (backend.PtyStream, error) {
	return nil, backend.ErrNotSupported
}
func (s *stubBackend) CreateShell(ctx context.Context, id, cwd string, cols, rows uint16) error {
	if s.failOn[id] {
		return fmt.Errorf("simulated open fail for %s", id)
	}
	s.created = append(s.created, id)
	return nil
}
func (s *stubBackend) LaunchAgent(ctx context.Context, id, kind, cwd string, command []string, cols, rows uint16) error {
	return s.CreateShell(ctx, id, cwd, cols, rows)
}
func (s *stubBackend) CloseSession(ctx context.Context, id string) error { return nil }
func (s *stubBackend) ListAudit(ctx context.Context) ([]backend.AuditEntry, error) {
	return nil, backend.ErrNotSupported
}
func (s *stubBackend) Capabilities() backend.Caps {
	return backend.Caps{Mode: "test"}
}

func TestFindAgentdBinaryOrSkip(t *testing.T) {
	// Unit-level: function should either find a real binary or return a clear error.
	p, err := findAgentdBinary()
	if err != nil {
		if !strings.Contains(err.Error(), "flock-agentd") {
			t.Fatalf("error should mention flock-agentd: %v", err)
		}
		return
	}
	if p == "" {
		t.Fatal("empty path without error")
	}
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		t.Fatalf("found path not a file: %s (%v)", p, err)
	}
}

func TestPutEnv(t *testing.T) {
	env := []string{"PATH=/bin", "FLOCK_AGENTD_SECRET=old", "HOME=/tmp"}
	got := putEnv(env, "FLOCK_AGENTD_SECRET", "new")
	found := false
	for _, e := range got {
		if e == "FLOCK_AGENTD_SECRET=new" {
			found = true
		}
		if e == "FLOCK_AGENTD_SECRET=old" {
			t.Fatal("old secret still present")
		}
	}
	if !found {
		t.Fatalf("secret not set: %v", got)
	}
	got2 := putEnv([]string{"A=1"}, "B", "2")
	if len(got2) != 2 || got2[1] != "B=2" {
		t.Fatalf("append failed: %v", got2)
	}
}

// The agentd secret has ONE precedence chain (env over file), resolved by
// config.Load. The CLI and dial both read the profile it produced; neither may
// consult the env again.
func TestSecretResolvedOnceByConfigLoad(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)
	t.Setenv("FLOCK_AGENTD_SECRET", "from-env")

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Active().AgentdSecret; got != "from-env" {
		t.Fatalf("env secret: got %q", got)
	}

	t.Setenv("FLOCK_AGENTD_SECRET", "")
	raw := config.Default()
	secretFile := filepath.Join(dir, "agentd-secret")
	if err := config.WriteFileAtomic(secretFile, []byte("profile-secret-value-at-least-32-bytes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	raw.Profiles["local"] = config.Profile{Mode: config.ModeLocal, AgentdSecretFile: secretFile}
	if err := config.Save(raw); err != nil {
		t.Fatal(err)
	}
	cfg, err = config.Load()
	if err != nil {
		t.Fatal(err)
	}
	_, got, err := cfg.Active().ResolvedAgentdControl()
	if err != nil {
		t.Fatal(err)
	}
	if got != "profile-secret-value-at-least-32-bytes" {
		t.Fatalf("profile secret file: got %q", got)
	}
}

func TestLoadKeybindsPresetAndOverrides(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)

	cfg := config.Default()
	cfg.Keybinds.Preset = "vim"

	// No keybinds.toml is the common case: the preset must still load.
	km := loadKeybinds(cfg)
	if act, ok := km.Resolve([]string{"ctrl+w", "w"}); !ok || act != keybinds.ActionFocusNext {
		t.Fatalf("preset not applied: %q %v", act, ok)
	}

	if err := os.WriteFile(filepath.Join(dir, "keybinds.toml"),
		[]byte("[keybinds]\nZen = [\"v\"]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	km = loadKeybinds(cfg)
	if act, ok := km.Resolve([]string{"v"}); !ok || act != keybinds.ActionZen {
		t.Fatalf("override not applied: %q %v", act, ok)
	}

	// A broken file must warn, not keep the user out of the paddock.
	if err := os.WriteFile(filepath.Join(dir, "keybinds.toml"),
		[]byte("[keybinds]\nQiut = [\"x\"]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	km = loadKeybinds(cfg)
	if act, ok := km.Resolve([]string{"q"}); !ok || act != keybinds.ActionQuit {
		t.Fatalf("broken file should fall back to the preset: %q %v", act, ok)
	}
}

func (s *stubBackend) ListNodes(ctx context.Context) ([]domain.Node, error) {
	return nil, backend.ErrNotSupported
}
func (s *stubBackend) CreateNode(ctx context.Context, spec backend.NodeSpec) (domain.Node, error) {
	return domain.Node{}, backend.ErrNotSupported
}
