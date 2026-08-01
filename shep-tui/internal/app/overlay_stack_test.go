package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func overlayModel(t *testing.T) Model {
	t.Helper()
	caps := testLocalCaps()
	caps.Cost = true
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       caps,
		Sessions: []domain.Session{
			{ID: "alpha", Name: "Alpha", Status: domain.StatusAwaitingInput},
			{ID: "beta", Name: "Beta", Status: domain.StatusIdle},
		},
	})
	m.width, m.height = 120, 40
	return m
}

func keyMsg(s string) tea.KeyMsg {
	switch s {
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "tab":
		return tea.KeyMsg{Type: tea.KeyTab}
	case "ctrl+k":
		return tea.KeyMsg{Type: tea.KeyCtrlK}
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	case "ctrl+j":
		return tea.KeyMsg{Type: tea.KeyCtrlJ}
	case "ctrl+r":
		return tea.KeyMsg{Type: tea.KeyCtrlR}
	case "ctrl+w":
		return tea.KeyMsg{Type: tea.KeyCtrlW}
	case "ctrl+b":
		return tea.KeyMsg{Type: tea.KeyCtrlB}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

func press(m Model, keys ...string) Model {
	for _, k := range keys {
		next, _ := m.Update(keyMsg(k))
		m = next.(Model)
	}
	return m
}

func TestHelpIsAStageAndSwallowsKeys(t *testing.T) {
	m := overlayModel(t)
	m.nPanes = 2
	m.panes[0].SessionID = "alpha"
	m.panes[1].SessionID = "beta"

	m = press(m, "?")
	if m.stage != StageHelp {
		t.Fatalf("stage after ? = %s want help", m.stage)
	}
	if !strings.Contains(m.View(), "detach") {
		t.Fatal("help overlay not rendered")
	}

	// Keys that would silently reconfigure the paddock behind the overlay.
	m = press(m, "ctrl+k", "tab", "z")
	if m.stage != StageHelp {
		t.Fatalf("stage after keys under help = %s want help", m.stage)
	}
	if m.focus != 0 {
		t.Fatalf("tab leaked through help: focus = %d", m.focus)
	}

	m = press(m, "esc")
	if m.stage != StageTable {
		t.Fatalf("esc did not close help: stage = %s", m.stage)
	}
}

func TestHelpClosesOnQAndQuestion(t *testing.T) {
	for _, k := range []string{"q", "?"} {
		m := press(overlayModel(t), "?")
		if m.stage != StageHelp {
			t.Fatalf("%q: help not open", k)
		}
		m = press(m, k)
		if m.stage != StageTable {
			t.Fatalf("%q did not close help: stage = %s", k, m.stage)
		}
		if m.quitting {
			t.Fatalf("%q quit instead of closing help", k)
		}
	}
}

func TestOverlayReturnsToTheStageItWasOpenedOver(t *testing.T) {
	m := overlayModel(t)
	m = press(m, "z")
	if m.stage != StageZen {
		t.Fatalf("z did not enter zen: %s", m.stage)
	}

	nm, _ := m.openPanel("git", []string{"a"})
	m = nm.(Model)
	m = press(m, "?")
	m = press(m, "esc")
	if m.stage != StagePanel {
		t.Fatalf("esc from help = %s want panel", m.stage)
	}
	m = press(m, "esc")
	if m.stage != StageZen {
		t.Fatalf("esc from panel = %s want zen", m.stage)
	}
}

func TestPaletteSelectionReturnsToUnderlyingSurface(t *testing.T) {
	m := overlayModel(t)
	nm, _ := m.openPanel("git", []string{"a"})
	m = nm.(Model)
	m = press(m, "ctrl+k")
	if m.stage != StagePalette {
		t.Fatalf("ctrl+k in panel = %s want palette", m.stage)
	}
	for i, it := range m.paletteItems {
		if it.ID == "action:theme" {
			m.paletteCursor = i
		}
	}
	m = press(m, "enter")
	if m.stage != StagePanel {
		t.Fatalf("after palette command stage = %s want panel", m.stage)
	}
}

// Re-opening the surface you are already on may not stack a duplicate frame:
// popStage would restore the identical stage, and the first esc would look dead.
func TestPanelFromPanelDoesNotStackADuplicate(t *testing.T) {
	m := overlayModel(t)
	nm, _ := m.openPanel("git", []string{"a"})
	m = nm.(Model)
	depth := len(m.stageStack)

	m = press(m, "ctrl+k")
	for i, it := range m.paletteItems {
		if it.ID == "action:cost" {
			m.paletteCursor = i
		}
	}
	m = press(m, "enter")
	if m.stage != StagePanel || m.panelKind != "cost" {
		t.Fatalf("stage = %s kind = %q, want the cost panel", m.stage, m.panelKind)
	}
	if len(m.stageStack) != depth {
		t.Fatalf("stack = %v, want the same depth as before (%d)", m.stageStack, depth)
	}

	m = press(m, "esc")
	if m.stage != StageTable {
		t.Fatalf("one esc must close the panel: stage = %s stack = %v", m.stage, m.stageStack)
	}
}

// Zen goes through the stage stack like every other surface: assigning m.stage
// strands the frame of whatever it was raised over.
func TestZenDoesNotStrandTheStageStack(t *testing.T) {
	m := overlayModel(t)
	nm, _ := m.openSettings()
	m = nm.(Model)

	m = press(m, "ctrl+k")
	for i, it := range m.paletteItems {
		if it.ID == "action:zen" {
			m.paletteCursor = i
		}
	}
	m = press(m, "enter")
	if m.stage != StageZen {
		t.Fatalf("stage = %s, want zen", m.stage)
	}

	m = press(m, "esc")
	if m.stage != StageSettings {
		t.Fatalf("esc from zen = %s, want the surface it was raised over", m.stage)
	}
	m = press(m, "esc")
	if m.stage != StageTable || len(m.stageStack) != 0 {
		t.Fatalf("after the full unwind: stage = %s stack = %v", m.stage, m.stageStack)
	}
}

// The palette is an overlay like any other: its help advertises the global
// chords, and ctrl+r is what the reconnect banner tells the user to press.
func TestGlobalChordsSurviveThePalette(t *testing.T) {
	m := errModel(t)
	m.be = &failingBackend{}
	nm, _ := m.openPalette()
	m = nm.(Model)
	m.paletteQuery = "git"
	m.rebuildPaletteItems()

	next, cmd := m.Update(keyMsg("ctrl+r"))
	m = next.(Model)
	if !m.reconnecting || cmd == nil {
		t.Fatalf("ctrl+r must reconnect from the palette: reconnecting = %v cmd = %v", m.reconnecting, cmd != nil)
	}
	if m.paletteQuery != "git" {
		t.Fatalf("a consumed chord leaked into the filter: %q", m.paletteQuery)
	}

	nm, _ = errModel(t).openPalette()
	m = nm.(Model)
	m = press(m, "ctrl+j")
	if !m.shellOpen {
		t.Fatal("ctrl+j must toggle the shell drawer from the palette — its help says so")
	}

	nm, _ = errModel(t).openPalette()
	m = nm.(Model)
	m.paletteQuery = "git"
	m.rebuildPaletteItems()
	depth := len(m.stageStack)
	m = press(m, "ctrl+k")
	if m.stage != StagePalette || len(m.stageStack) != depth || m.paletteQuery != "git" {
		t.Fatalf("the palette key over an open palette must be a no-op: stage = %s stack = %v query = %q",
			m.stage, m.stageStack, m.paletteQuery)
	}
}

func TestGlobalKeysReachSettingsAndPanel(t *testing.T) {
	nm, _ := overlayModel(t).openSettings()
	m := nm.(Model)
	m = press(m, "?")
	if m.stage != StageHelp {
		t.Fatalf("? from settings = %s", m.stage)
	}

	nm, _ = overlayModel(t).openPanel("git", []string{"a"})
	m = nm.(Model)
	m = press(m, "ctrl+k")
	if m.stage != StagePalette {
		t.Fatalf("ctrl+k from panel = %s", m.stage)
	}
}

func TestQuitFromEverySurfaceClosesStreams(t *testing.T) {
	cases := []struct {
		name  string
		open  func(Model) Model
		quit  string
		final StageMode
	}{
		{"table", func(m Model) Model { return m }, "q", StageTable},
		{"settings", func(m Model) Model { nm, _ := m.openSettings(); return nm.(Model) }, "q", StageSettings},
		{"panel", func(m Model) Model { nm, _ := m.openPanel("git", []string{"a"}); return nm.(Model) }, "q", StagePanel},
		{"help", func(m Model) Model { nm, _ := m.openHelp(); return nm.(Model) }, "ctrl+c", StageHelp},
		{"palette", func(m Model) Model { nm, _ := m.openPalette(); return nm.(Model) }, "ctrl+c", StagePalette},
		{"respond", func(m Model) Model { nm, _ := m.openRespond(); return nm.(Model) }, "ctrl+c", StageRespond},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := overlayModel(t)
			cs := &countingStream{}
			m.nPanes = 1
			m.panes[0].SessionID = "alpha"
			m.panes[0].Stream = cs
			m.focusSessionID = "alpha"

			m = tc.open(m)
			if m.stage != tc.final {
				t.Fatalf("open %s: stage = %s", tc.name, m.stage)
			}
			m = press(m, tc.quit)
			if !m.quitting {
				t.Fatalf("%s: %q did not quit", tc.name, tc.quit)
			}
			if cs.Closes() == 0 {
				t.Fatalf("%s: quit leaked the pane PTY", tc.name)
			}
		})
	}
}
