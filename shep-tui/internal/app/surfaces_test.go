package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	"github.com/billiondollarsolo/shep-tui/internal/ui/compare"
	"github.com/billiondollarsolo/shep-tui/internal/ui/cost"
	"github.com/billiondollarsolo/shep-tui/internal/ui/handoff"
	"github.com/billiondollarsolo/shep-tui/internal/ui/palette"
	uitable "github.com/billiondollarsolo/shep-tui/internal/ui/table"
	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

// Structural presence: Phase 1–4 surfaces reachable via shipped packages + app stages.
func TestSurfacePresence_Phase1to4(t *testing.T) {
	for _, s := range domain.StatusValues {
		if s.Label() == "" {
			t.Fatalf("empty label for %s", s)
		}
	}
	if domain.StatusRunning.Label() != "Working" {
		t.Fatal(domain.StatusRunning.Label())
	}
	if domain.StatusAwaitingInput.Label() != "Needs you" {
		t.Fatal(domain.StatusAwaitingInput.Label())
	}

	tb := uitable.Build([]domain.Session{
		{ID: "a", Name: "a", Status: domain.StatusAwaitingInput, NodeID: "n", ProjectID: "p"},
		{ID: "b", Name: "b", Status: domain.StatusIdle, NodeID: "n", ProjectID: "p"},
	})
	if tb.Len() != 2 {
		t.Fatal("table empty")
	}
	sorted := []domain.Session{
		{ID: "b", Status: domain.StatusIdle},
		{ID: "a", Status: domain.StatusAwaitingInput},
	}
	domain.SortSessionsByAttention(sorted)
	if sorted[0].ID != "a" {
		t.Fatalf("attention sort first=%s", sorted[0].ID)
	}

	var pal palette.Palette
	pal.SetItems([]palette.Command{{ID: "m", Title: "Attention (Needs you)"}})
	pal.Filter("att")
	if len(pal.Filtered) == 0 {
		t.Fatal("palette filter empty")
	}

	// The session's state is drawn on the session, in the table: affirmative
	// status in one column, its telemetry in the columns beside it.
	row := uitable.Build([]domain.Session{{
		ID: "id", Name: "one", Status: domain.StatusRunning,
		Telemetry: domain.Telemetry{Model: "m", Tool: "t", ContextTokens: 42, ContextLimit: 100, Tokens: 12000},
	}}).Rows()[0]
	if row.Status.Label() != "Working" {
		t.Fatalf("table row missing Working: %+v", row)
	}
	if row.Model != "m" || row.Ctx != "42%" || row.Tokens != "12k" {
		t.Fatalf("table telemetry = %+v", row)
	}

	boot := handoff.BuildBootstrap("claude", "summary", []string{"last"}, 100)
	if !strings.Contains(boot, "claude") {
		t.Fatalf("handoff: %q", boot)
	}

	var ct cost.Table
	c := 0.18
	ct.FromSessions([]domain.Session{{ID: "x", Telemetry: domain.Telemetry{Tokens: 10, CostUSD: &c}}})
	if ct.Total() <= 0 {
		t.Fatal("cost total")
	}
	board := compare.Board{ShowCost: true}
	board.Add(compare.Run{SessionID: "1", Status: domain.StatusDone, CostUSD: 0.1})
	if len(board.Lines()) == 0 {
		t.Fatal("compare lines")
	}

	km := keybinds.Default()
	seq := km.Sequence(keybinds.ActionDetachChord)
	if len(seq) < 2 {
		t.Fatalf("detach chord missing: %v", seq)
	}
	if seq[0] != "ctrl+g" || seq[1] != "g" {
		t.Fatalf("detach chord = %v", seq)
	}

	_ = theme.DefaultDark()
	_ = theme.DefaultLight()
	if theme.Named("light").Surface0 == theme.DefaultDark().Surface0 {
		// light and dark should differ
		t.Fatal("light theme same as dark surface0")
	}

	costVal := 0.05
	model := newModel(Options{
		Sessions: []domain.Session{
			{ID: "s1", Name: "one", Status: domain.StatusAwaitingInput, Telemetry: domain.Telemetry{CostUSD: &costVal, Tokens: 100, Model: "m"}},
			{ID: "s2", Name: "two", Status: domain.StatusIdle},
		},
		Caps: backend.Caps{Mode: "local", Launch: true, Git: true, Cost: true},
	})
	model.width = 120
	model.height = 40
	model.nPanes = 2
	model.panes[0].SessionID = "s1"
	model.panes[0].Status = domain.StatusAwaitingInput
	model.panes[0].Stream = &countingStream{}
	model.focusSessionID = "s1"

	nm, _ := model.openPalette()
	model = nm.(Model)
	if model.stage != StagePalette {
		t.Fatalf("stage=%v", model.stage)
	}

	for _, kind := range []string{"git", "chat", "files", "cost", "compare", "audit", "handoff"} {
		var cmd tea.Cmd
		switch kind {
		// git, files and audit shell out / hit the disk / hit the network: they
		// load in a command and arrive as a panelLoadedMsg.
		case "git":
			nm, cmd = model.openPanelAsync(kind, gitPanelLoader(model.panelCwd()))
		case "files":
			nm, cmd = model.openPanelAsync(kind, filesPanelLoader(model.panelCwd()))
		case "audit":
			nm, cmd = model.openPanelAsync(kind, auditPanelLoader(model.be))
		case "chat":
			nm, _ = model.openPanel(kind, model.buildChatPanelLines())
		case "cost":
			nm, _ = model.openPanel(kind, model.buildCostPanelLines())
		case "compare":
			nm, _ = model.openPanel(kind, model.buildComparePanelLines())
		case "handoff":
			nm, _ = model.openPanel(kind, model.buildHandoffPanelLines())
		}
		model = nm.(Model)
		if cmd != nil {
			model, _ = pump(t, model, cmd)
		}
		if model.stage != StagePanel || model.panelKind != kind {
			t.Fatalf("panel %s: stage=%v kind=%q", kind, model.stage, model.panelKind)
		}
		if len(model.panel.Lines()) == 0 {
			t.Fatalf("panel %s: empty lines", kind)
		}
		if model.View() == "" {
			t.Fatalf("panel %s: empty view", kind)
		}
	}

	nm, _ = model.openRespond()
	model = nm.(Model)
	if model.stage != StageRespond {
		t.Fatalf("respond stage=%v", model.stage)
	}
}

func TestOpenPaletteAndSelectSettingsAction(t *testing.T) {
	m := newModel(Options{
		Sessions: []domain.Session{{ID: "s1", Name: "one", Status: domain.StatusIdle}},
	})
	m.width, m.height = 100, 30
	nm, _ := m.openPalette()
	m = nm.(Model)
	m.rebuildPaletteItems()
	found := -1
	for i, it := range m.paletteItems {
		if it.ID == "action:settings" {
			found = i
			break
		}
	}
	if found < 0 {
		t.Fatal("settings action missing from palette")
	}
	m.paletteCursor = found
	nm, _ = m.runPaletteSelection()
	m = nm.(Model)
	if m.stage != StageSettings {
		t.Fatalf("after select settings stage=%v", m.stage)
	}
}
