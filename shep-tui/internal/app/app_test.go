package app

import (
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/vt"
)

func TestKeyToBytesBasics(t *testing.T) {
	cases := []struct {
		msg  tea.KeyMsg
		want string
	}{
		{tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}}, "a"},
		{tea.KeyMsg{Type: tea.KeySpace}, " "},
		{tea.KeyMsg{Type: tea.KeyEnter}, "\r"},
		{tea.KeyMsg{Type: tea.KeyTab}, "\t"},
		{tea.KeyMsg{Type: tea.KeyCtrlC}, "\x03"},
		{tea.KeyMsg{Type: tea.KeyUp}, "\x1b[A"},
		{tea.KeyMsg{Type: tea.KeyBackspace}, "\x7f"},
		{tea.KeyMsg{Type: tea.KeyEscape}, "\x1b"},
		{tea.KeyMsg{Type: tea.KeyCtrlJ}, "\n"},
		{tea.KeyMsg{Type: tea.KeyCtrlG}, "\a"},
		// Keys that used to vanish: Delete did nothing inside vim, shift+tab did
		// nothing inside Claude Code, and alt+b wrote a bare b.
		{tea.KeyMsg{Type: tea.KeyDelete}, "\x1b[3~"},
		{tea.KeyMsg{Type: tea.KeyInsert}, "\x1b[2~"},
		{tea.KeyMsg{Type: tea.KeyShiftTab}, "\x1b[Z"},
		{tea.KeyMsg{Type: tea.KeyCtrlAt}, "\x00"},
		{tea.KeyMsg{Type: tea.KeyCtrlBackslash}, "\x1c"},
		{tea.KeyMsg{Type: tea.KeyCtrlUnderscore}, "\x1f"},
		{tea.KeyMsg{Type: tea.KeyF1}, "\x1bOP"},
		{tea.KeyMsg{Type: tea.KeyF5}, "\x1b[15~"},
		{tea.KeyMsg{Type: tea.KeyF12}, "\x1b[24~"},
		{tea.KeyMsg{Type: tea.KeyCtrlRight}, "\x1b[1;5C"},
		{tea.KeyMsg{Type: tea.KeyShiftHome}, "\x1b[1;2H"},
		{tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'b'}, Alt: true}, "\x1bb"},
		{tea.KeyMsg{Type: tea.KeyEnter, Alt: true}, "\x1b\r"},
	}
	for _, tc := range cases {
		got := string(keyToBytes(tc.msg))
		if got != tc.want {
			t.Fatalf("key %v: got %q want %q", tc.msg, got, tc.want)
		}
	}
}

// A key with no byte form must be reported, not silently swallowed.
func TestUnmappedKeyIsReported(t *testing.T) {
	cs := &countingStream{}
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1"}}})
	m.panes[0].Stream = cs
	m.mode = ModeInput

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyF20})
	m = next.(Model)
	if !strings.Contains(m.toast.text, "unmapped key") {
		t.Fatalf("statusMsg = %q", m.toast.text)
	}
	if cs.Written() != "" {
		t.Fatalf("unmapped key wrote %q", cs.Written())
	}
}

func TestChromeTabAndQuit(t *testing.T) {
	m := newModel(Options{
		Version: "test",
		Sessions: []domain.Session{
			{ID: "s1", Name: "one"},
			{ID: "s2", Name: "two"},
		},
	})
	nm, _ := m.setPaneCount(2)
	m = nm.(Model)
	if m.focus != 0 {
		t.Fatalf("focus = %d", m.focus)
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = next.(Model)
	if m.focus != 1 {
		t.Fatalf("after tab focus = %d want 1", m.focus)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = next.(Model)
	if m.focus != 0 {
		t.Fatalf("after second tab focus = %d want 0", m.focus)
	}
}

func TestTabCyclesPanesWhenNPanes(t *testing.T) {
	m := newModel(Options{
		Version: "test",
		Sessions: []domain.Session{
			{ID: "s1", Name: "one"},
			{ID: "s2", Name: "two"},
			{ID: "s3", Name: "three"},
			{ID: "s4", Name: "four"},
		},
	})
	if m.nPanes != 1 {
		t.Fatalf("nPanes = %d, want the stage to open on one agent", m.nPanes)
	}
	// The grid is opt-in: the layout the user picks is what unfolds the pen.
	nm, _ := m.setPenLayout(domain.PenLayoutGrid2x2)
	m = nm.(Model)
	if m.nPanes != 4 {
		t.Fatalf("nPanes = %d want 4 after choosing the 2×2 grid", m.nPanes)
	}
	// Tab through all 4.
	for want := 1; want < 4; want++ {
		next, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
		m = next.(Model)
		if m.focus != want {
			t.Fatalf("after tab focus = %d want %d", m.focus, want)
		}
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = next.(Model)
	if m.focus != 0 {
		t.Fatalf("wrap focus = %d want 0", m.focus)
	}
	// Digit focus
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'3'}})
	m = next.(Model)
	if m.focus != 2 {
		t.Fatalf("key 3 focus = %d want 2", m.focus)
	}
}

func TestDetachChord(t *testing.T) {
	// Use a stub stream so input mode is allowed.
	m := newModel(Options{
		Version:  "test",
		Sessions: []domain.Session{{ID: "s1"}},
	})
	m.panes[0].Stream = stubStream{}
	m.mode = ModeInput

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlG})
	m = next.(Model)
	if len(m.pending) != 1 || m.mode != ModeInput {
		t.Fatalf("after ctrl+g: pending=%v mode=%s", m.pending, m.mode)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'g'}})
	m = next.(Model)
	if m.mode != ModeChrome || len(m.pending) != 0 {
		t.Fatalf("after g: mode=%s pending=%v", m.mode, m.pending)
	}
}

// A cancelled detach chord must give the prefix back to the agent: ctrl+g is
// BEL, and there is no other way to type it into a nested program.
func TestCancelledDetachChordFlushesPrefixToPty(t *testing.T) {
	cs := &countingStream{}
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1"}}})
	m.panes[0].Stream = cs
	m.mode = ModeInput

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlG})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	m = next.(Model)
	if m.mode != ModeInput {
		t.Fatalf("cancelled chord left input mode: %s", m.mode)
	}
	if cs.Written() != "\x07x" {
		t.Fatalf("written = %q want BEL + x", cs.Written())
	}
}

// A stray chord prefix must not arm forever and eat the next unrelated key.
func TestChordTimesOut(t *testing.T) {
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1"}}})
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'g'}})
	m = next.(Model)
	if len(m.pending) != 1 || cmd == nil {
		t.Fatalf("g should arm a chord with a timeout: pending=%v cmd=%v", m.pending, cmd != nil)
	}
	next, _ = m.Update(chordTimeoutMsg{seq: m.pendingSeq})
	m = next.(Model)
	if len(m.pending) != 0 {
		t.Fatalf("chord did not expire: %v", m.pending)
	}
	// The next key is a plain key again, not a chord continuation.
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'z'}})
	m = next.(Model)
	if m.stage != StageZen {
		t.Fatalf("z after an expired g dispatched as %s, not as a plain key", m.stage)
	}
}

func TestShiftTabCyclesPanesBackwards(t *testing.T) {
	m := newModel(Options{Version: "test", Sessions: []domain.Session{
		{ID: "s1"}, {ID: "s2"}, {ID: "s3"},
	}})
	nm, _ := m.setPaneCount(3)
	m = nm.(Model)
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyShiftTab})
	m = next.(Model)
	if m.focus != 2 {
		t.Fatalf("shift+tab focus = %d want 2 (wrap to last pane)", m.focus)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyShiftTab})
	m = next.(Model)
	if m.focus != 1 {
		t.Fatalf("shift+tab focus = %d want 1", m.focus)
	}
}

func TestPaletteOpenFilterSelect(t *testing.T) {
	m := newModel(Options{
		Version: "test",
		Sessions: []domain.Session{
			{ID: "alpha", Name: "Alpha", Status: domain.StatusIdle},
			{ID: "beta", Name: "Beta", Status: domain.StatusRunning},
		},
	})
	// Open palette via ctrl+k
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	m = next.(Model)
	if m.stage != StagePalette {
		t.Fatalf("stage = %s want palette", m.stage)
	}
	if len(m.paletteItems) < 3 {
		t.Fatalf("palette items = %d, want actions + sessions", len(m.paletteItems))
	}

	// Filter to beta
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'b'}})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}})
	m = next.(Model)
	if m.paletteQuery != "be" {
		t.Fatalf("query = %q", m.paletteQuery)
	}
	// Should match Beta session (and maybe nothing else action-wise)
	foundBeta := false
	for _, it := range m.paletteItems {
		if it.ID == "session:beta" {
			foundBeta = true
		}
		if it.ID == "session:alpha" {
			t.Fatalf("alpha should be filtered out, items=%v", m.paletteItems)
		}
	}
	if !foundBeta {
		t.Fatalf("beta not in filtered items: %+v", m.paletteItems)
	}

	// Select beta
	for i, it := range m.paletteItems {
		if it.ID == "session:beta" {
			m.paletteCursor = i
			break
		}
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.stage != StageTerm {
		t.Fatalf("selecting an agent must drill into it: stage = %s", m.stage)
	}
	if m.focusSessionID != "beta" {
		t.Fatalf("focusSessionID = %q want beta", m.focusSessionID)
	}
}

func TestStatusLabelsAffirmativeOnly(t *testing.T) {
	// Wire "running" must display as "Working", never "running"/"busy".
	m := newModel(Options{
		Version: "test",
		Sessions: []domain.Session{
			{ID: "s1", Name: "Agent", Status: domain.StatusRunning, Telemetry: domain.Telemetry{Model: "opus"}},
		},
	})
	m.applySize(120, 30)
	// The status is drawn on the agent, in the table's own column.
	list := renderTable(m, 120, 20)
	if strings.Contains(strings.ToLower(list), "running") {
		t.Fatalf("table contains forbidden 'running': %q", list)
	}
	if !strings.Contains(list, "Working") {
		t.Fatalf("table missing affirmative Working: %q", list)
	}
	// Session status labels
	for _, s := range m.sessions {
		lab := s.Status.Label()
		if lab == "running" || lab == "busy" || lab == "Waiting" {
			t.Fatalf("non-affirmative label %q for %s", lab, s.Status)
		}
	}
	// Full view should not show raw wire word for running
	v := m.View()
	// Strip is hard with ANSI; check Label path used in pane titles via StatusLabel
	// which uses domain.Status.Label()
	if strings.Contains(v, "busy") {
		t.Fatalf("view contains busy: %q", v)
	}
	// domain.StatusRunning.Label is Working
	if domain.StatusRunning.Label() != "Working" {
		t.Fatalf("Label = %q", domain.StatusRunning.Label())
	}
	if domain.StatusAwaitingInput.Label() != "Needs you" {
		t.Fatalf("awaiting label = %q", domain.StatusAwaitingInput.Label())
	}
}

func TestTableSelectionChangesFocusSessionID(t *testing.T) {
	m := newModel(Options{
		Version: "test",
		Sessions: []domain.Session{
			{ID: "s1", Name: "one", Status: domain.StatusIdle},
			{ID: "s2", Name: "two", Status: domain.StatusIdle},
			{ID: "s3", Name: "three", Status: domain.StatusIdle},
		},
	})
	m.applySize(120, 30)

	// The table is flat: every j lands on an agent, in name order.
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = next.(Model)
	if m.focusSessionID != "s3" {
		t.Fatalf("j selected %q want s3 (three)", m.focusSessionID)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = next.(Model)
	if m.focusSessionID != "s2" {
		t.Fatalf("j selected %q want s2 (two)", m.focusSessionID)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	m = next.(Model)
	if m.focusSessionID != "s3" {
		t.Fatalf("k selected %q want s3", m.focusSessionID)
	}
}

func TestPaneFeedRendersThroughVTScreen(t *testing.T) {
	p := Pane{screen: vt.New(40, 4, 100)}
	p.feed([]byte("hello\x1b[31mred\x1b[0m\r\nworld\r\n"))
	out := renderVT(p.screen, 40, 4, 0)
	if !strings.Contains(out, "hellored") {
		t.Fatalf("row0 missing: %q", out)
	}
	if !strings.Contains(out, "world") {
		t.Fatalf("row1 missing: %q", out)
	}
	// The ANSI colour bytes are interpreted, not printed.
	if strings.Contains(out, "[31m") {
		t.Fatalf("raw escape leaked into the render: %q", out)
	}
}

func TestFatalView(t *testing.T) {
	m := Model{fatal: true, err: errString("agentd missing"), width: 80, height: 24}
	v := m.View()
	if !strings.Contains(v, "agentd missing") {
		t.Fatalf("view missing error: %q", v)
	}
}

func TestCloseStreams(t *testing.T) {
	s0 := &countingStream{}
	s1 := &countingStream{}
	m := newModel(Options{
		Version: "test",
		Sessions: []domain.Session{
			{ID: "s1"},
			{ID: "s2"},
		},
	})
	m.panes[0].Stream = s0
	m.panes[1].Stream = s1
	m.closeStreams()
	if s0.Closes() != 1 || s1.Closes() != 1 {
		t.Fatalf("closes = %d, %d", s0.Closes(), s1.Closes())
	}
	if m.panes[0].Stream != nil || m.panes[1].Stream != nil {
		t.Fatal("streams should be nil after closeStreams")
	}
	// Idempotent.
	m.closeStreams()
	if s0.Closes() != 1 || s1.Closes() != 1 {
		t.Fatalf("double closeStreams should not re-close: %d, %d", s0.Closes(), s1.Closes())
	}
}

func TestQuitClosesStreams(t *testing.T) {
	s0 := &countingStream{}
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1"}}})
	m.panes[0].Stream = s0
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	m = next.(Model)
	if !m.quitting {
		t.Fatal("expected quitting")
	}
	if s0.Closes() != 1 {
		t.Fatalf("quit should close streams: closes=%d", s0.Closes())
	}
	if cmd == nil {
		t.Fatal("expected Quit cmd")
	}
}

func TestRespondSendsViaStream(t *testing.T) {
	cs := &countingStream{}
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1", Name: "one"}}})
	m.panes[0].Stream = cs
	// Open respond
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'R'}})
	m = next.(Model)
	if m.stage != StageRespond {
		t.Fatalf("stage = %s", m.stage)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.stage != StageTable {
		t.Fatalf("after send stage = %s", m.stage)
	}
	if !strings.Contains(cs.Written(), "y") {
		t.Fatalf("written = %q", cs.Written())
	}
}

func TestRespondTargetsSelectedSessionNotFocusedPane(t *testing.T) {
	a, b := &countingStream{}, &countingStream{}
	m := newModel(Options{Version: "test", Sessions: []domain.Session{
		{ID: "sess-A", Name: "a"},
		{ID: "sess-B", Name: "b"},
	}})
	m.nPanes = 2
	m.panes[0].SessionID, m.panes[0].Stream = "sess-A", a
	m.panes[1].SessionID, m.panes[1].Stream = "sess-B", b
	m.focus = 0
	m.focusSessionID = "sess-B"

	next, _ := m.openRespond()
	m = next.(Model)
	if m.respondTarget != "sess-B" {
		t.Fatalf("respondTarget = %q want sess-B", m.respondTarget)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)

	if !strings.Contains(b.Written(), "y") {
		t.Fatalf("B written = %q", b.Written())
	}
	if a.Written() != "" {
		t.Fatalf("A should not receive anything, got %q", a.Written())
	}
	if m.respondTarget != "" {
		t.Fatalf("respondTarget not cleared: %q", m.respondTarget)
	}
}

func TestRespondRefusesDetachedTarget(t *testing.T) {
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1", Name: "one"}}})
	m.focusSessionID = "s1"
	next, _ := m.openRespond()
	m = next.(Model)
	if m.stage == StageRespond {
		t.Fatal("respond opened with no attached stream")
	}
	if !strings.Contains(m.toast.text, "not attached") {
		t.Fatalf("statusMsg = %q", m.toast.text)
	}
}

// A selection that is not in the pen has no target: answering it by writing to
// whatever agent happens to be focused is worse than not answering it.
func TestRespondRefusesSelectionNotInAnyPane(t *testing.T) {
	a := &countingStream{}
	m := newModel(Options{Version: "test", Sessions: []domain.Session{
		{ID: "sess-A", Name: "a"},
		{ID: "sess-B", Name: "b"},
	}})
	m.nPanes = 1
	m.panes[0].SessionID, m.panes[0].Stream = "sess-A", a
	m.focus = 0
	m.focusSessionID = "sess-B"

	next, _ := m.openRespond()
	m = next.(Model)
	if m.stage == StageRespond {
		t.Fatalf("respond opened aimed at %q, which is not the selected session", m.respondTarget)
	}
	if a.Written() != "" {
		t.Fatalf("sess-A received %q", a.Written())
	}
	if !strings.Contains(m.toast.text, "not attached") {
		t.Fatalf("toast = %q, want the refusal", m.toast.text)
	}
}

func TestPaletteFilterAcceptsJAndK(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	m.width, m.height = 100, 30
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	m = next.(Model)
	for _, r := range []rune{'j', 'k'} {
		next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = next.(Model)
	}
	if m.paletteQuery != "jk" || m.palInput.Value() != "jk" {
		t.Fatalf("query=%q input=%q", m.paletteQuery, m.palInput.Value())
	}
}

func TestPaletteArrowsMoveCursor(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	m.width, m.height = 100, 30
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	m = next.(Model)
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyDown})
	m = next.(Model)
	if m.paletteCursor != 1 {
		t.Fatalf("paletteCursor = %d want 1", m.paletteCursor)
	}
}

// The shell drawer is the only region beside the surface: hiding it must take
// the chrome cursor back rather than leave it on a region nothing draws.
// testLocalCaps is what a local agentd reports: everything the standalone
// paddock can actually do. Cost stays false — agentd has no cost to report.
func testLocalCaps() backend.Caps {
	return backend.Caps{
		Mode:        "local",
		Launch:      true,
		Git:         true,
		Files:       true,
		Handoff:     true,
		ShellDrawer: true,
		Chat:        true,
	}
}

func TestClampRegionWhenDrawerHides(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Caps: testLocalCaps(), Sessions: []domain.Session{{ID: "s1"}}})
	m.applySize(120, 40)
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m = next.(Model)
	if m.region != RegionShell {
		t.Fatalf("region = %v want the drawer", m.region)
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m = next.(Model)
	if m.region != RegionMain {
		t.Fatalf("region = %v want RegionMain after the drawer closed", m.region)
	}
}

func TestAttachResizesStream(t *testing.T) {
	rs := &resizeStream{}
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1"}}})
	m.width, m.height = 120, 40
	next, _ := m.Update(attachDoneMsg{pane: 0, epoch: m.panes[0].Epoch, stream: rs})
	m = next.(Model)
	waitFor(t, "attach resize", func() bool {
		cols, _ := rs.Size()
		return cols != 0 && cols != 80
	})
	_ = m
}

// A resize drag is a WindowSizeMsg per frame; each one used to issue a control
// frame to every attached PTY. The screens follow immediately, the PTYs settle.
func TestResizeIsDebounced(t *testing.T) {
	rs := &resizeStream{}
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1"}}})
	m.panes[0].Stream = rs

	next, _ := m.Update(tea.WindowSizeMsg{Width: 120, Height: 40})
	m = next.(Model)
	if cols, _ := rs.Size(); cols != 0 {
		t.Fatalf("PTY resized mid-drag: cols=%d", cols)
	}
	if rows := m.panes[0].screen.Rows(); rows <= 1 {
		t.Fatalf("VT screen not resized: rows=%d", rows)
	}

	stale := m.resizeSeq
	next, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	next, _ = m.Update(resizeSettleMsg{seq: stale})
	m = next.(Model)
	if cols, _ := rs.Size(); cols != 0 {
		t.Fatalf("an abandoned size reached the PTY: cols=%d", cols)
	}

	next, _ = m.Update(resizeSettleMsg{seq: m.resizeSeq})
	m = next.(Model)
	if cols, _ := rs.Size(); cols == 0 {
		t.Fatal("settled resize never reached the PTY")
	}
}

func TestShellDrawerMessage(t *testing.T) {
	m := newModel(Options{Version: "test", Caps: backend.Caps{Mode: "local", ShellDrawer: true}, SkipSplash: true})
	m.width, m.height = 80, 24
	// Backend nil → no splash; set shell path via force open
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlJ})
	m = next.(Model)
	if !m.shellOpen {
		t.Fatal("shellOpen=false")
	}
	if !strings.Contains(m.toast.text, "shell drawer") {
		t.Fatalf("statusMsg = %q", m.toast.text)
	}
}

func TestConnectivityBannerWhenReconnecting(t *testing.T) {
	m := newModel(Options{Version: "test", Sessions: []domain.Session{{ID: "s1"}}})
	m.width = 80
	m.height = 24
	m.reconnecting = true
	v := m.View()
	if !strings.Contains(v, "reconnect") {
		t.Fatalf("view missing reconnect banner: %q", v)
	}
}

// countingStream records what was written and how often it was closed. A stream
// that entered the model is wrapped by backend.Async, so its writer is another
// goroutine: every field is behind the mutex and read through the accessors.
type countingStream struct {
	mu      sync.Mutex
	closes  int
	written []byte
}

func (c *countingStream) Output() <-chan []byte {
	ch := make(chan []byte)
	close(ch)
	return ch
}
func (c *countingStream) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.written = append(c.written, p...)
	return len(p), nil
}
func (c *countingStream) Resize(cols, rows uint16) error { return nil }
func (c *countingStream) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closes++
	return nil
}
func (c *countingStream) Written() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.written)
}
func (c *countingStream) Closes() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closes
}

// resizeStream records the last Resize it was asked for.
type resizeStream struct {
	mu         sync.Mutex
	cols, rows uint16
}

func (r *resizeStream) Output() <-chan []byte { ch := make(chan []byte); close(ch); return ch }
func (r *resizeStream) Write(p []byte) (int, error) {
	return len(p), nil
}
func (r *resizeStream) Resize(cols, rows uint16) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cols, r.rows = cols, rows
	return nil
}
func (r *resizeStream) Close() error { return nil }
func (r *resizeStream) Size() (uint16, uint16) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cols, r.rows
}

// waitFor polls cond until it holds: writes and resizes on a stream the model
// owns are handed to backend.Async's writer goroutine, not applied inline.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

type errString string

func (e errString) Error() string { return string(e) }

// stubStream is a no-op PtyStream for keybind unit tests.
type stubStream struct{}

func (stubStream) Output() <-chan []byte          { ch := make(chan []byte); close(ch); return ch }
func (stubStream) Write(p []byte) (int, error)    { return len(p), nil }
func (stubStream) Resize(cols, rows uint16) error { return nil }
func (stubStream) Close() error                   { return nil }
