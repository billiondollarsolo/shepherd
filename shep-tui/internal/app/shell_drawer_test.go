package app

import (
	"context"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// drawerBackend records CreateShell / OpenPty for the shell drawer path.
type drawerBackend struct {
	createIDs []string
	openIDs   []string
	stream    *countingStream
	caps      backend.Caps
}

func (d *drawerBackend) Close() error { return nil }
func (d *drawerBackend) ListSessions(ctx context.Context) ([]domain.Session, error) {
	return nil, nil
}
func (d *drawerBackend) WatchStatus(ctx context.Context) (<-chan backend.StatusUpdate, error) {
	return nil, nil
}
func (d *drawerBackend) OpenPty(ctx context.Context, sessionID string, cols, rows uint16) (backend.PtyStream, error) {
	d.openIDs = append(d.openIDs, sessionID)
	if d.stream == nil {
		d.stream = &countingStream{}
	}
	return d.stream, nil
}
func (d *drawerBackend) CreateShell(ctx context.Context, id, cwd string, cols, rows uint16) error {
	d.createIDs = append(d.createIDs, id)
	return nil
}
func (d *drawerBackend) LaunchAgent(ctx context.Context, id, kind, cwd string, command []string, cols, rows uint16) error {
	return d.CreateShell(ctx, id, cwd, cols, rows)
}
func (d *drawerBackend) CloseSession(ctx context.Context, id string) error { return nil }
func (d *drawerBackend) ListAudit(ctx context.Context) ([]backend.AuditEntry, error) {
	return nil, backend.ErrNotSupported
}
func (d *drawerBackend) Capabilities() backend.Caps {
	if d.caps.Mode == "" {
		return backend.Caps{Mode: "local", ShellDrawer: true}
	}
	return d.caps
}

func TestShellDrawerToggleCreatesSecondaryPtyNotPen(t *testing.T) {
	be := &drawerBackend{caps: backend.Caps{Mode: "local", ShellDrawer: true}}
	m := newModel(Options{
		Backend:    be,
		Version:    "test",
		Sessions:   []domain.Session{{ID: "pen-agent", Name: "agent", Status: domain.StatusIdle}},
		Caps:       backend.Caps{Mode: "local", ShellDrawer: true},
		SkipSplash: true,
	})
	m.width, m.height = 100, 30
	// Pen has one session; drawer must not add to nPanes.
	if m.nPanes != 1 {
		t.Fatalf("nPanes=%d", m.nPanes)
	}

	// Open drawer via shipped key path.
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m = next.(Model)
	if !m.shellOpen {
		t.Fatal("shellOpen=false after ctrl+j")
	}
	if m.nPanes != 1 {
		t.Fatalf("drawer must not change pen count: nPanes=%d", m.nPanes)
	}
	// Run CreateShell+OpenPty command.
	if cmd == nil {
		t.Fatal("expected cmd to open shell drawer PTY")
	}
	sd := msgOf[shellDrawerMsg](t, cmd)
	if sd.err != nil {
		t.Fatal(sd.err)
	}
	if sd.id != shellDrawerID {
		t.Fatalf("id=%q want %q", sd.id, shellDrawerID)
	}
	next, _ = m.Update(sd)
	m = next.(Model)
	if m.shellStream == nil {
		t.Fatal("shellStream nil after attach")
	}
	if len(be.createIDs) == 0 || be.createIDs[0] != shellDrawerID {
		t.Fatalf("CreateShell ids=%v", be.createIDs)
	}
	if len(be.openIDs) == 0 || be.openIDs[0] != shellDrawerID {
		t.Fatalf("OpenPty ids=%v", be.openIDs)
	}
	// Not a pen session slot.
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == shellDrawerID {
			t.Fatal("shell drawer id must not occupy a pen pane")
		}
	}

	// Opening the drawer focuses it, so i hands it the keyboard.
	if m.region != RegionShell {
		t.Fatalf("region = %s want shell", m.region)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'i'}})
	m = next.(Model)
	if m.mode != ModeInput || m.inputTarget != targetShell {
		t.Fatalf("mode=%s inputTarget=%d", m.mode, m.inputTarget)
	}
	cs := be.stream
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	m = next.(Model)
	waitFor(t, "shell stream write", func() bool { return strings.Contains(cs.Written(), "x") })

	// Hide from input mode: ctrl+j is the agent's, so the chord is the way out.
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlG})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = next.(Model)
	if m.shellOpen {
		t.Fatal("expected closed after ctrl+g j")
	}
	if m.mode != ModeChrome {
		t.Fatalf("hiding the drawer that held the keyboard left mode = %s", m.mode)
	}
	if m.shellStream == nil {
		t.Fatal("stream should survive hide")
	}

	// View when open includes drawer title.
	m.shellOpen = true
	v := m.View()
	if !strings.Contains(v, "shell drawer") {
		t.Fatalf("view missing shell drawer: %q", v[:min(200, len(v))])
	}
}

// An open drawer must not own the keyboard: it used to be impossible to type to
// an agent again without closing it.
func TestOpenDrawerDoesNotStealPaneInput(t *testing.T) {
	be := &drawerBackend{caps: backend.Caps{Mode: "local", ShellDrawer: true}}
	m := newModel(Options{
		Backend:    be,
		Version:    "test",
		Sessions:   []domain.Session{{ID: "pen-agent", Name: "agent"}},
		Caps:       backend.Caps{Mode: "local", ShellDrawer: true},
		SkipSplash: true,
	})
	m.width, m.height = 100, 30
	pane := &countingStream{}
	m.panes[0].Stream = pane

	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m = next.(Model)
	next, _ = m.Update(msgOf[shellDrawerMsg](t, cmd))
	m = next.(Model)

	// Focus the stage, then type: the keys belong to the pane, not the drawer.
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'i'}})
	m = next.(Model)
	if m.mode != ModeInput || m.inputTarget != targetPane {
		t.Fatalf("i with the drawer open: mode=%s target=%d", m.mode, m.inputTarget)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	m = next.(Model)
	if pane.Written() != "x" {
		t.Fatalf("pane written = %q want x", pane.Written())
	}
	if be.stream != nil && be.stream.Written() != "" {
		t.Fatalf("drawer received the agent's keys: %q", be.stream.Written())
	}
}

// ctrl+j is LF: agents bind it (newline, readline), so input mode must forward it.
func TestCtrlJReachesAgentInInputMode(t *testing.T) {
	be := &drawerBackend{caps: backend.Caps{Mode: "local", ShellDrawer: true}}
	m := newModel(Options{
		Backend:    be,
		Version:    "test",
		Sessions:   []domain.Session{{ID: "s1"}},
		Caps:       backend.Caps{Mode: "local", ShellDrawer: true},
		SkipSplash: true,
	})
	m.width, m.height = 100, 30
	pane := &countingStream{}
	m.panes[0].Stream = pane
	m.mode = ModeInput

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m = next.(Model)
	if m.shellOpen {
		t.Fatal("ctrl+j opened the drawer from input mode instead of reaching the agent")
	}
	if pane.Written() != "\n" {
		t.Fatalf("pane written = %q want LF", pane.Written())
	}
}

// ctrl+g j is the input-mode drawer key, and it must not move the keyboard.
func TestDrawerChordFromInputModeKeepsAgentKeyboard(t *testing.T) {
	be := &drawerBackend{caps: backend.Caps{Mode: "local", ShellDrawer: true}}
	m := newModel(Options{
		Backend:    be,
		Version:    "test",
		Sessions:   []domain.Session{{ID: "s1"}},
		Caps:       backend.Caps{Mode: "local", ShellDrawer: true},
		SkipSplash: true,
	})
	m.width, m.height = 100, 30
	pane := &countingStream{}
	m.panes[0].Stream = pane
	m.mode = ModeInput

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlG})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = next.(Model)
	if !m.shellOpen {
		t.Fatal("ctrl+g j did not show the drawer")
	}
	if m.mode != ModeInput || m.inputTarget != targetPane {
		t.Fatalf("drawer chord moved the keyboard: mode=%s target=%d", m.mode, m.inputTarget)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	m = next.(Model)
	if pane.Written() != "x" {
		t.Fatalf("pane written = %q want x", pane.Written())
	}
}

// Typing at a drawer whose attach is still in flight must not fall through to
// the pane the user is not looking at.
func TestShellAttachRaceDropsKeysInsteadOfHittingThePane(t *testing.T) {
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1"}}, SkipSplash: true})
	m.width, m.height = 100, 30
	pane := &countingStream{}
	m.panes[0].Stream = pane
	m.shellOpen = true
	m.region = RegionShell
	m.mode = ModeInput
	m.inputTarget = targetShell

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	m = next.(Model)
	if pane.Written() != "" {
		t.Fatalf("key leaked to the pane PTY: %q", pane.Written())
	}
	if !strings.Contains(m.toast.text, "attaching") {
		t.Fatalf("statusMsg = %q", m.toast.text)
	}
}

// A backend without CreateShell has no shell drawer, so the drawer key opens
// nothing: the old behaviour drew the chrome and then apologised with a toast.
func TestShellDrawerAbsentWithoutCapability(t *testing.T) {
	m := newModel(Options{
		Backend:    &noShellBackend{},
		Version:    "test",
		Caps:       backend.Caps{Mode: "fleet", ShellDrawer: false},
		SkipSplash: true,
	})
	m.width, m.height = 80, 24
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m = next.(Model)
	if m.shellOpen {
		t.Fatal("the drawer opened on a backend that cannot create a shell")
	}
	if cmd != nil {
		t.Fatal("no CreateShell should be attempted")
	}
	if strings.Contains(m.toast.text, "shell drawer") {
		t.Fatalf("a hidden affordance does not need an apology: %q", m.toast.text)
	}
	// Nor is it advertised anywhere the user could find it.
	for _, hk := range m.headerHotkeys() {
		if strings.Contains(hk.Desc, "Shell") {
			t.Fatalf("the header offers the drawer on a backend without it: %v", hk)
		}
	}
	for _, c := range m.buildPaletteCatalog() {
		if c.ID == "action:shell" || c.ID == "action:focusshell" {
			t.Fatalf("the palette offers the drawer on a backend without it: %s", c.ID)
		}
	}
}

type noShellBackend struct{}

func (n *noShellBackend) Close() error { return nil }
func (n *noShellBackend) ListSessions(ctx context.Context) ([]domain.Session, error) {
	return nil, nil
}
func (n *noShellBackend) WatchStatus(ctx context.Context) (<-chan backend.StatusUpdate, error) {
	return nil, nil
}
func (n *noShellBackend) OpenPty(ctx context.Context, sessionID string, cols, rows uint16) (backend.PtyStream, error) {
	return nil, backend.ErrNotSupported
}
func (n *noShellBackend) CreateShell(ctx context.Context, id, cwd string, cols, rows uint16) error {
	return backend.ErrNotSupported
}
func (n *noShellBackend) LaunchAgent(ctx context.Context, id, kind, cwd string, command []string, cols, rows uint16) error {
	return backend.ErrNotSupported
}
func (n *noShellBackend) CloseSession(ctx context.Context, id string) error {
	return backend.ErrNotSupported
}
func (n *noShellBackend) ListAudit(ctx context.Context) ([]backend.AuditEntry, error) {
	return nil, backend.ErrNotSupported
}
func (n *noShellBackend) Capabilities() backend.Caps {
	return backend.Caps{Mode: "fleet", ShellDrawer: false}
}

func (d *drawerBackend) ListNodes(ctx context.Context) ([]domain.Node, error) {
	return nil, backend.ErrNotSupported
}
func (d *drawerBackend) CreateNode(ctx context.Context, spec backend.NodeSpec) (domain.Node, error) {
	return domain.Node{}, backend.ErrNotSupported
}

func (n *noShellBackend) ListNodes(ctx context.Context) ([]domain.Node, error) {
	return nil, backend.ErrNotSupported
}
func (n *noShellBackend) CreateNode(ctx context.Context, spec backend.NodeSpec) (domain.Node, error) {
	return domain.Node{}, backend.ErrNotSupported
}
