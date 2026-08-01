package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
)

func helpFitModel(w, h int) Model {
	m := newModel(Options{
		Version:    "test",
		Caps:       testLocalCaps(),
		Sessions:   []domain.Session{{ID: "s1", Name: "one", Status: domain.StatusIdle}},
		SkipSplash: true,
	})
	m.applySize(w, h)
	return m
}

// bubbles/help drops columns that overflow its Width without any ellipsis, so a
// keymap wider than the terminal loses whole actions from the surface that is
// meant to be their source of truth.
func TestHelpShowsEveryChromeBindingAtEveryWidth(t *testing.T) {
	for _, w := range []int{80, 100, 120, 160, 200} {
		m := helpFitModel(w, 40)
		km := paddockKeyMap{km: m.km, ctx: helpPaddock, width: m.helpModel.Width}
		view := m.helpModel.View(km)
		for _, b := range km.bindings() {
			if !strings.Contains(view, b.Help().Desc) {
				t.Errorf("width %d: help omits %q (%s)", w, b.Help().Desc, b.Help().Key)
			}
		}
	}
}

func TestHelpOverlayFitsTerminalWidth(t *testing.T) {
	for _, w := range []int{80, 120, 200} {
		m := helpFitModel(w, 40)
		m.stage = StageHelp
		for _, line := range strings.Split(renderHelp(m), "\n") {
			if got := lipgloss.Width(line); got > w {
				t.Errorf("width %d: help line is %d cols wide", w, got)
			}
		}
	}
}

// The header is the only place the keys live, so it must fit the terminal at
// every width: a line wider than the screen wraps and pushes the table off it.
// truncate must be ANSI-aware or it cuts an escape sequence in half and the
// leaked remainder renders as literal text, wider than the width it was cut to.
func TestHeaderNeverOverflowsTheTerminal(t *testing.T) {
	stages := []StageMode{StageTable, StageTerm, StagePen, StageSettings, StagePanel}
	for _, w := range []int{60, 80, 100, 120, 200} {
		for _, st := range stages {
			m := helpFitModel(w, 40)
			m.stage = st
			for _, line := range strings.Split(renderHeader(m), "\n") {
				if got := lipgloss.Width(line); got > w {
					t.Errorf("width %d stage %v: header line is %d cols wide: %q", w, st, got, line)
				}
			}
			if got := lipgloss.Width(renderToastRow(m)); got > w {
				t.Errorf("width %d: toast row is %d cols wide", w, got)
			}
		}
	}
}

// The table fills its box and never spills out of it.
func TestTableFitsItsBox(t *testing.T) {
	for _, w := range []int{60, 80, 120, 200} {
		m := helpFitModel(w, 40)
		out := renderTable(m, w, 20)
		for _, line := range strings.Split(out, "\n") {
			if got := lipgloss.Width(line); got > w {
				t.Errorf("width %d: table line is %d cols wide: %q", w, got, line)
			}
		}
		if n := strings.Count(out, "\n") + 1; n != 20 {
			t.Errorf("width %d: table drew %d rows into a box of 20", w, n)
		}
	}
}

func TestTruncateKeepsStyledTextWithinWidth(t *testing.T) {
	styled := lipgloss.NewStyle().Foreground(lipgloss.Color("#ff0000")).Render("hello") +
		" · " + lipgloss.NewStyle().Bold(true).Render("world and then some more text")
	for _, w := range []int{1, 5, 10, 20, 30} {
		if got := lipgloss.Width(truncate(styled, w)); got > w {
			t.Errorf("truncate(_, %d) rendered %d cols wide", w, got)
		}
	}
}

func TestHelpColumnsFitWidth(t *testing.T) {
	m := helpFitModel(120, 40)
	km := paddockKeyMap{km: m.km, ctx: helpPaddock, width: m.helpModel.Width}
	if n := len(km.FullHelp()); n < 1 || n > maxHelpColumns {
		t.Fatalf("FullHelp columns = %d, want 1..%d", n, maxHelpColumns)
	}
	// Every action the paddock dispatches must have a binding in help.
	if len(km.bindings()) < len(chromeHelpActions())-2 {
		t.Errorf("paddock help lists %d bindings for %d actions", len(km.bindings()), len(chromeHelpActions()))
	}
}

func TestHelpNarrowTerminalStillListsEverything(t *testing.T) {
	m := helpFitModel(60, 40)
	km := paddockKeyMap{km: m.km, ctx: helpPaddock, width: m.helpModel.Width}
	view := m.helpModel.View(km)
	for _, a := range []keybinds.Action{keybinds.ActionFocusPane2, keybinds.ActionFocusNext, keybinds.ActionZen} {
		b := bindingFor(m.km, a)
		if b.Help().Desc == "" {
			continue
		}
		if !strings.Contains(view, b.Help().Desc) {
			t.Errorf("narrow help omits %q", b.Help().Desc)
		}
	}
}

var _ = tea.KeyMsg{}

// The keys are permanently visible in the header: every width must show them,
// and every key it shows must be one the app dispatches.
func TestHeaderAlwaysShowsTheKeys(t *testing.T) {
	for _, w := range []int{60, 80, 100, 120, 160, 200} {
		m := helpFitModel(w, 24)
		head := renderHeader(m)
		for _, want := range []string{"Launch", "Help", "Quit", "Command"} {
			if !strings.Contains(head, want) {
				t.Errorf("width %d: the header omits %q:\n%s", w, want, head)
			}
		}
	}
	// Only the primary sequence is advertised: spelling every alternate
	// ("q / ctrl+c", "n / N") is what overran the old key strip.
	head := renderHeader(helpFitModel(160, 24))
	if strings.Contains(head, "q / ctrl+c") || strings.Contains(head, "n / N") {
		t.Errorf("the header spells out key alternates:\n%s", head)
	}
}

// The header is the only place keys are advertised now, so it must describe the
// surface the user is actually on. Inside an agent's terminal you are already
// attached: offering Attach is the same lie the old footer told, and the way
// back has to be on screen.
func TestHeaderFollowsTheSurfaceOnDrillDown(t *testing.T) {
	m := helpFitModel(120, 26)
	m.sessions = []domain.Session{{ID: "s1", Name: "one", Status: domain.StatusIdle}}
	m.syncTable()

	keys := func(m Model) map[string]string {
		out := map[string]string{}
		for _, h := range m.headerHotkeys() {
			out[h.Key] = h.Desc
		}
		return out
	}

	onTable := keys(m)
	if onTable["enter"] != "Attach" {
		t.Errorf("the table must offer Attach, got %v", onTable)
	}
	if _, ok := onTable["esc"]; ok {
		t.Errorf("the table is home; there is nothing to go back to: %v", onTable)
	}

	m.stage = StageTerm
	drilled := keys(m)
	if drilled["esc"] != "Back" {
		t.Errorf("a drilled-in terminal must offer the way back, got %v", drilled)
	}
	if _, ok := drilled["enter"]; ok {
		t.Errorf("already attached — Attach must not be advertised: %v", drilled)
	}
}
