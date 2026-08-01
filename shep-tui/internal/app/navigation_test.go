package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
)

// attachBackend records the size every OpenPty was asked for.
type attachBackend struct {
	backend.Backend
	cols, rows uint16
}

func (b *attachBackend) OpenPty(_ context.Context, _ string, cols, rows uint16) (backend.PtyStream, error) {
	b.cols, b.rows = cols, rows
	return &resizeStream{}, nil
}

func (b *attachBackend) WatchStatus(context.Context) (<-chan backend.StatusUpdate, error) {
	return make(chan backend.StatusUpdate), nil
}

func (b *attachBackend) Close() error { return nil }

func navModel(t *testing.T, sessions ...domain.Session) Model {
	t.Helper()
	m := newModel(Options{Version: "test", SkipSplash: true, Sessions: sessions})
	m.applySize(120, 40)
	return m
}

// The table is a flat list: j/k walk every agent, and enter drills into the one
// under the cursor — its terminal takes the whole window.
func TestTableNavigatesSessionsAndSurvivesView(t *testing.T) {
	m := navModel(t,
		domain.Session{ID: "s1", Name: "one", Cwd: "/work/a"},
		domain.Session{ID: "s2", Name: "two", Cwd: "/work/a"},
	)
	m.panes[0].Stream = stubStream{}

	if _, ok := m.table.Selected(); !ok {
		t.Fatal("the cursor should start on an agent")
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = next.(Model)
	if m.focusSessionID != "s2" {
		t.Fatalf("j selected %q want s2", m.focusSessionID)
	}
	rows := m.table.Len()
	_ = m.View()
	if got := m.table.Len(); got != rows {
		t.Fatalf("View() rebuilt the table: %d → %d rows", rows, got)
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.mode != ModeChrome {
		t.Fatal("enter on the table entered PTY input mode")
	}
	if m.stage != StageTerm || m.focusSessionID != "s2" {
		t.Fatalf("enter drilled into %q on stage %s", m.focusSessionID, m.stage)
	}
	if !strings.Contains(m.View(), "two(s2)") {
		t.Fatalf("the drilled-into agent is not named in its border:\n%s", m.View())
	}

	// esc comes back to the table.
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = next.(Model)
	if m.stage != StageTable {
		t.Fatalf("esc from the agent = %s, want the table", m.stage)
	}
}

// / filters the table live; esc clears it and leaves every agent listed again.
func TestFilterNarrowsTheTable(t *testing.T) {
	m := navModel(t,
		domain.Session{ID: "s1", Name: "one", Cwd: "/work/a"},
		domain.Session{ID: "s2", Name: "two", Cwd: "/work/a"},
	)
	m = press(m, "/")
	if m.stage != StageFilter {
		t.Fatalf("/ did not open the filter: %s", m.stage)
	}
	m = press(m, "t", "w")
	if m.table.Len() != 1 || m.table.SelectedSessionID() != "s2" {
		t.Fatalf("filter tw: %d rows, selection %q", m.table.Len(), m.table.SelectedSessionID())
	}
	if !strings.Contains(renderTable(m, 120, 20), "Agents(/tw)[1]") {
		t.Fatalf("the title must say the table is filtered:\n%s", renderTable(m, 120, 20))
	}
	m = press(m, "esc")
	if m.stage != StageTable || m.table.Len() != 2 {
		t.Fatalf("esc did not clear the filter: stage %s, %d rows", m.stage, m.table.Len())
	}
}

// p is the pens grid, and it is a surface of its own: the app does not open on
// it, and esc leaves it.
func TestPensIsASurfaceNotTheHome(t *testing.T) {
	m := navModel(t,
		domain.Session{ID: "s1", Name: "one"},
		domain.Session{ID: "s2", Name: "two"},
	)
	if m.stage != StageTable {
		t.Fatalf("the app opened on %s", m.stage)
	}
	m = press(m, "p")
	if m.stage != StagePen {
		t.Fatalf("p did not open the pens grid: %s", m.stage)
	}
	m = press(m, "esc")
	if m.stage != StageTable {
		t.Fatalf("esc from the pens grid = %s", m.stage)
	}
}

// Sessions arriving from the backend must not move the table cursor.
func TestTableSelectionSurvivesStatusUpdate(t *testing.T) {
	m := navModel(t, domain.Session{ID: "s1", Name: "one", Cwd: "/work/a"})
	if m.table.SelectedSessionID() != "s1" {
		t.Fatalf("cursor = %q want s1", m.table.SelectedSessionID())
	}
	next, _ := m.Update(statusUpdateMsg{StatusUpdate: backend.StatusUpdate{SessionID: "s2", Status: domain.StatusIdle}})
	m = next.(Model)
	if m.table.SelectedSessionID() != "s1" {
		t.Fatalf("status update moved the table cursor: %q", m.table.SelectedSessionID())
	}
	if m.table.Len() != 2 {
		t.Fatalf("new session missing from the table: %d rows", m.table.Len())
	}
}

// The agents that need you lead the table, so the cursor starts on one — and
// enter drills straight into it.
func TestTableAttentionLeadsAndActivates(t *testing.T) {
	m := navModel(t,
		domain.Session{ID: "a", Name: "Alpha", Status: domain.StatusIdle},
		domain.Session{ID: "b", Name: "Beta", Status: domain.StatusAwaitingInput},
	)
	m.panes[0].Stream = stubStream{}

	if got := m.table.SelectedSessionID(); got != "b" {
		t.Fatalf("cursor starts on %q, not the session that needs you", got)
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.mode != ModeChrome {
		t.Fatal("enter on the table entered PTY input mode")
	}
	if m.focusSessionID != "b" {
		t.Fatalf("enter focused %q want b", m.focusSessionID)
	}
	if m.stage != StageTerm {
		t.Fatalf("stage after enter = %s, want the agent's terminal", m.stage)
	}
}

// An empty table must not hijack the user into input mode.
func TestEmptyTableEnterIsNoop(t *testing.T) {
	m := navModel(t)
	m.panes[0].Stream = stubStream{}

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.mode != ModeChrome {
		t.Fatal("enter on an empty table entered input mode")
	}
}

// The table scrolls instead of truncating — the cursor row is always drawn.
func TestTableScrollsToKeepCursorVisible(t *testing.T) {
	var sessions []domain.Session
	for i := 0; i < 40; i++ {
		sessions = append(sessions, domain.Session{
			ID:     fmt.Sprintf("s%02d", i),
			Name:   fmt.Sprintf("agent-%02d", i),
			Status: domain.StatusIdle,
			Cwd:    "/work",
		})
	}
	m := navModel(t, sessions...)
	for i := 0; i < m.table.Len(); i++ {
		m.moveTableCursor(1)
	}
	out := renderTable(m, 120, 20)
	if !strings.Contains(out, "agent-39") {
		t.Fatalf("the table did not scroll to the last row:\n%s", out)
	}
	if !strings.Contains(out, "more") {
		t.Fatalf("the table hides rows without saying so:\n%s", out)
	}
}

// Panels scroll and the files panel actually browses.
func TestPanelScrollsAndFilesBrowse(t *testing.T) {
	m := navModel(t, domain.Session{ID: "s1", Name: "one"})
	lines := make([]string, 200)
	for i := range lines {
		lines[i] = fmt.Sprintf("line-%03d", i)
	}
	nm, _ := m.openPanel("git", lines)
	m = nm.(Model)
	if len(m.panel.Lines()) != 200 {
		t.Fatalf("panel clipped its content: %d lines", len(m.panel.Lines()))
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyPgDown})
	m = next.(Model)
	if m.panel.YOffset() == 0 {
		t.Fatal("pgdown did not scroll the panel")
	}
	if !strings.Contains(renderPanel(m, 60, 20), "line") {
		t.Fatal("panel body missing after scroll")
	}
	// A panel is not a dead end: the palette is still reachable from it.
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	if next.(Model).stage != StagePalette {
		t.Fatalf("ctrl+k in a panel = %s", next.(Model).stage)
	}

	// Files: the browser persists, so enter walks into a directory.
	dir := t.TempDir()
	m.sessions = []domain.Session{{ID: "s1", Name: "one", Cwd: dir}}
	m.focusSessionID = "s1"
	if err := writeTestTree(dir); err != nil {
		t.Fatal(err)
	}
	nm, cmd := m.openPanelAsync("files", filesPanelLoader(m.panelCwd()))
	m = nm.(Model)
	m, _ = pump(t, m, cmd)
	if m.filesBrowser == nil {
		t.Fatal("files panel has no browser")
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.filesBrowser.Path != dir+"/sub" {
		t.Fatalf("enter did not open the directory: %s", m.filesBrowser.Path)
	}
	if !strings.Contains(strings.Join(m.panel.Lines(), "\n"), "leaf.txt") {
		t.Fatalf("panel content did not follow the browser: %v", m.panel.Lines())
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'h'}})
	m = next.(Model)
	if m.filesBrowser.Path != dir {
		t.Fatalf("h did not go back up: %s", m.filesBrowser.Path)
	}
}

// Help must name every key handleFilesPanelKey dispatches: enter / l / h are the
// only way to browse, and a panel whose navigation appears in no help context
// reads as a static text dump.
func TestFilesPanelHelpNamesItsBrowseKeys(t *testing.T) {
	dir := t.TempDir()
	if err := writeTestTree(dir); err != nil {
		t.Fatal(err)
	}
	m := navModel(t, domain.Session{ID: "s1", Name: "one", Cwd: dir})
	m.focusSessionID = "s1"
	nm, cmd := m.openPanelAsync("files", filesPanelLoader(dir))
	m = nm.(Model)
	m, _ = pump(t, m, cmd)

	if got := helpContextFor(m); got != helpFilesPanel {
		t.Fatalf("help context in the files panel = %v", got)
	}
	bindings := paddockKeyMap{km: m.km, ctx: helpFilesPanel}.bindings()
	for _, action := range []keybinds.Action{
		keybinds.ActionTreeUp, keybinds.ActionTreeDown, keybinds.ActionActivate,
		keybinds.ActionRegionNext, keybinds.ActionRegionPrev,
	} {
		found := false
		for _, b := range bindings {
			for _, k := range b.Keys() {
				if got, ok := m.km.Resolve([]string{k}); ok && got == action {
					found = true
				}
			}
		}
		if !found {
			t.Fatalf("files panel help omits %s, which the panel dispatches", action)
		}
	}
	out := renderHelp(m)
	if !strings.Contains(out, "enter directory") || !strings.Contains(out, "up a directory") {
		t.Fatalf("files panel help does not describe browsing:\n%s", out)
	}
}

// PTY scrollback is reachable from the keyboard.
func TestPaneScrollbackIsReachable(t *testing.T) {
	m := navModel(t, domain.Session{ID: "s1", Name: "one"})
	m.panes[0].screen.Resize(20, 5)
	for i := 0; i < 40; i++ {
		m.panes[0].feed([]byte(fmt.Sprintf("row-%02d\r\n", i)))
	}
	live := renderVT(m.panes[0].screen, 20, 5, 0)
	if strings.Contains(live, "row-00") {
		t.Fatalf("row-00 should have scrolled out of the live rows:\n%s", live)
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	m = next.(Model)
	if m.panes[0].scrollOff == 0 {
		t.Fatal("pgup did not scroll the pane")
	}
	// Scroll all the way back: the first line the agent ever printed is there.
	for i := 0; i < 40; i++ {
		next, _ = m.Update(tea.KeyMsg{Type: tea.KeyPgUp})
		m = next.(Model)
	}
	body := renderVT(m.panes[0].screen, 20, 5, m.panes[0].scrollOff)
	if !strings.Contains(body, "row-00") {
		t.Fatalf("scrollback does not reach the oldest line:\n%s", body)
	}
	if !strings.Contains(renderPane(m, 0, paneFocusActive, 30, 12), "SCROLL") {
		t.Fatal("scrolled pane does not say so in its title")
	}
	// esc returns to live output.
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = next.(Model)
	if m.panes[0].scrollOff != 0 {
		t.Fatalf("esc did not return to live: off = %d", m.panes[0].scrollOff)
	}
}

// Alt-screen programs keep no history, so scrolling one must be a no-op.
func TestAltScreenPaneDoesNotScroll(t *testing.T) {
	m := navModel(t, domain.Session{ID: "s1", Name: "one"})
	m.panes[0].feed([]byte("\x1b[?1049h"))
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyPgUp})
	m = next.(Model)
	if m.panes[0].scrollOff != 0 {
		t.Fatalf("alt-screen pane scrolled: off = %d", m.panes[0].scrollOff)
	}
}

// Every attach goes through one command, sized for the pane it lands in.
func TestAttachUsesPaneSize(t *testing.T) {
	be := &attachBackend{}
	m := newModel(Options{Version: "test", SkipSplash: true, Backend: be,
		Sessions: []domain.Session{{ID: "s1", Name: "one"}}})
	m.applySize(120, 40)

	cmd := m.attachPaneCmd(0, m.panes[0].Epoch, "s1")
	if cmd == nil {
		t.Fatal("no attach cmd")
	}
	cmd()
	if be.cols == 80 && be.rows == 24 {
		t.Fatalf("attach still hardcodes 80x24: %dx%d", be.cols, be.rows)
	}
	cols, rows := m.paneSize(0)
	if be.cols != cols || be.rows != rows {
		t.Fatalf("attach size %dx%d != pane size %dx%d", be.cols, be.rows, cols, rows)
	}
}

// From the shell drawer, the pane the keys still act on wears a dim ring — it
// may not claim to have no focus at all.
func TestFocusRingIsTriState(t *testing.T) {
	m := navModel(t,
		domain.Session{ID: "s1", Name: "one"},
		domain.Session{ID: "s2", Name: "two"},
	)
	nm, _ := m.setPaneCount(2)
	m = nm.(Model)
	nm, _ = m.openPens()
	m = nm.(Model)
	if got := m.paneFocus(0); got != paneFocusActive {
		t.Fatalf("pen focus = %v want active", got)
	}
	m.region = RegionShell
	if got := m.paneFocus(0); got != paneFocusDim {
		t.Fatalf("focused pane from the drawer = %v want dim", got)
	}
	if got := m.paneFocus(1); got != paneUnfocused {
		t.Fatalf("unfocused pane = %v", got)
	}
	// Pane-acting keys take the region back.
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	if next.(Model).region != RegionMain {
		t.Fatalf("tab left the region on the drawer: %s", next.(Model).region)
	}
	m.region = RegionShell
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'z'}})
	if next.(Model).region != RegionMain {
		t.Fatalf("zen left the region on the drawer: %s", next.(Model).region)
	}
}

// writeTestTree lays out sub/leaf.txt so the files panel has somewhere to go.
func writeTestTree(dir string) error {
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "sub", "leaf.txt"), []byte("x"), 0o644)
}

// In a grid the arrows move between agents. They were bound to region cycling,
// which the table shell left with nothing to cycle — so in a pen they did
// nothing and the only way to change agent was tab or a digit.
func TestArrowsMovePaneFocusInAGrid(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions: []domain.Session{
			{ID: "s1", Name: "one"}, {ID: "s2", Name: "two"},
			{ID: "s3", Name: "three"}, {ID: "s4", Name: "four"},
		},
	})
	m.applySize(120, 40)
	nm, _ := m.setPenLayout(domain.PenLayoutGrid2x2)
	m = nm.(Model)
	m.applySize(120, 40)
	if m.nPanes != 4 {
		t.Fatalf("nPanes = %d, want a 2x2 grid", m.nPanes)
	}
	m.stage = StagePen
	m.focus = 0

	// The rects the layout drew are the adjacency: right of 0 is not 0, and it is
	// on the same row; down from 0 lands on the row below.
	rects := m.paneRects()
	right, _ := m.focusPaneDir(1, 0)
	r := right.(Model)
	if r.focus == 0 {
		t.Fatal("right did not move the focus")
	}
	if rects[r.focus].Y != rects[0].Y {
		t.Errorf("right jumped rows: focus %d", r.focus)
	}

	down, _ := m.focusPaneDir(0, 1)
	d := down.(Model)
	if d.focus == 0 {
		t.Fatal("down did not move the focus")
	}
	if rects[d.focus].Y <= rects[0].Y {
		t.Errorf("down did not move to the row below: focus %d", d.focus)
	}

	// Moving back returns to where it started.
	back, _ := r.focusPaneDir(-1, 0)
	if got := back.(Model).focus; got != 0 {
		t.Errorf("left from the right-hand pane = %d, want 0", got)
	}

	// The edges hold: nothing is left of pane 0.
	edge, _ := m.focusPaneDir(-1, 0)
	if got := edge.(Model).focus; got != 0 {
		t.Errorf("left at the edge moved to %d", got)
	}
}

// A single pane has nothing to move between; j/k must keep scrolling it.
func TestArrowsDoNotHijackScrollOutsideAGrid(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true,
		Sessions: []domain.Session{{ID: "s1", Name: "one"}}})
	m.applySize(100, 30)
	m.stage = StageTerm
	if m.inGrid() {
		t.Fatal("a single pane is not a grid")
	}
}
