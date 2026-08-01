package app

import (
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	"github.com/billiondollarsolo/shep-tui/internal/launch"
	"github.com/billiondollarsolo/shep-tui/internal/store"
	uitable "github.com/billiondollarsolo/shep-tui/internal/ui/table"
)

// The app opens on the agents table — not on a grid of panes, and not on an
// attention list.
func TestDefaultStageIsTheTable(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	if m.stage != StageTable {
		t.Fatalf("stage=%s want the table", m.stage)
	}
	if m.stage.String() != "table" {
		t.Fatalf("string=%s", m.stage.String())
	}
}

func TestOpenLaunchWizard(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	next, _ := m.openLaunch()
	m = next.(Model)
	if m.stage != StageLaunch || m.launchForm == nil || m.launchVals == nil {
		t.Fatalf("stage=%s form=%v", m.stage, m.launchForm != nil)
	}
	// The form's values are what the launch command is built from.
	agent, err := launch.ParseAgent(m.launchVals.agent)
	if err != nil {
		t.Fatal(err)
	}
	res, err := launch.Build(launch.Spec{Agent: agent, Cwd: "/tmp"})
	if err != nil || len(res.Command) == 0 {
		t.Fatalf("%v %+v", err, res)
	}
}

func TestHelpOverlayListsDetach(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	m.width, m.height = 80, 24
	m.stage = StageHelp
	v := renderHelp(m)
	seq := keybinds.Default().Sequence(keybinds.ActionDetachChord)
	if len(seq) < 2 {
		t.Fatal("detach chord missing from registry")
	}
	if !strings.Contains(v, seq[0]) || !strings.Contains(v, "detach") {
		t.Fatalf("help missing detach: %s", v)
	}
	if !strings.Contains(v, "table") || !strings.Contains(v, "launch") {
		t.Fatalf("help incomplete: %s", v)
	}
}

func TestNamedMultiPenPersist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pens.json")
	st := store.New()
	if _, err := st.CreatePen("(default)", "main", "Main", domain.PenLayoutCols); err != nil {
		t.Fatal(err)
	}
	p2, err := st.CreatePen("(default)", "side", "Side", domain.PenLayoutGrid2x2)
	if err != nil {
		t.Fatal(err)
	}
	st.SetPen("(default)", domain.Pen{ID: "main", Name: "Main", Layout: domain.PenLayoutCols, SessionIDs: []string{"a"}})
	st.SetPen("(default)", domain.Pen{ID: "side", Name: "Side", Layout: domain.PenLayoutGrid2x2, SessionIDs: []string{"b"}})
	_ = st.SwitchActivePen("(default)", p2.ID)
	if err := st.SavePens(path); err != nil {
		t.Fatal(err)
	}
	st2 := store.New()
	if err := st2.LoadPens(path); err != nil {
		t.Fatal(err)
	}
	if len(st2.Pens()) != 2 {
		t.Fatal(st2.Pens())
	}
	if st2.ActivePen("(default)").ID != "side" {
		t.Fatal(st2.ActivePen("(default)"))
	}
}

func TestTablePenBadges(t *testing.T) {
	tb := uitable.Build([]domain.Session{
		{ID: "s1", Name: "one", Status: domain.StatusAwaitingInput, NodeID: "local", ProjectID: "/tmp"},
		{ID: "s2", Name: "two", Status: domain.StatusIdle, NodeID: "local", ProjectID: "/tmp"},
	})
	tb.SetPenBadges(map[string]string{"s1": "Main"})
	rows := tb.Rows()
	if rows[0].Status.Label() != "Needs you" {
		t.Fatalf("the row that needs you must say so: %+v", rows[0])
	}
	if rows[0].Badge != "Main" {
		t.Fatalf("missing pen badge: %+v", rows[0])
	}
}

// Chrome path: the table is one line per agent — attention first, aligned
// columns, the name never squeezed out (E3).
func TestRenderTableIsOneLinePerAgentAttentionFirst(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions: []domain.Session{
			{ID: "s1", Name: "alpha", Status: domain.StatusAwaitingInput, Cwd: "/work/a"},
			{ID: "s2", Name: "beta", Status: domain.StatusIdle, Cwd: "/work/a"},
		},
	})
	m.applySize(120, 40)
	m.st = store.New()
	p, err := m.st.CreatePen("(default)", "main", "Main", domain.PenLayoutCols)
	if err != nil {
		t.Fatal(err)
	}
	p.SessionIDs = []string{"s1"}
	m.st.SetPen("(default)", p)
	m.pen = p
	m.syncTable()

	out := renderTable(m, 120, 20)
	lines := strings.Split(out, "\n")
	// Title in the border, count and all.
	if !strings.Contains(lines[0], "Agents(local)[2]") {
		t.Fatalf("the count belongs in the top border:\n%s", out)
	}
	// Column headings, then one line per agent, the one that needs you first.
	if !strings.Contains(lines[1], "NAME") || !strings.Contains(lines[1], "STATUS") {
		t.Fatalf("expected aligned column headings:\n%s", out)
	}
	if !strings.Contains(lines[2], "alpha") || !strings.Contains(lines[2], "Needs you") {
		t.Fatalf("the agent that needs you must lead the table:\n%s", out)
	}
	if !strings.Contains(lines[3], "beta") {
		t.Fatalf("expected the rest of the roster under it:\n%s", out)
	}
	if strings.Count(out, "alpha") != 1 {
		t.Fatalf("an agent must be listed once:\n%s", out)
	}
	if m.table.Rows()[0].Badge != "Main" {
		t.Fatalf("expected the pen badge on the row: %+v", m.table.Rows()[0])
	}
}

func TestSwitchActivePenLoadsPanes(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions: []domain.Session{
			{ID: "a", Name: "A", Status: domain.StatusIdle},
			{ID: "b", Name: "B", Status: domain.StatusRunning},
			{ID: "extra", Name: "Extra", Status: domain.StatusIdle},
		},
	})
	m.st = store.New()
	p1, _ := m.st.CreatePen("(default)", "p1", "One", domain.PenLayoutCols)
	p2, _ := m.st.CreatePen("(default)", "p2", "Two", domain.PenLayoutRows)
	// Only p2 is pre-seeded in the store. p1 membership will live on panes only
	// (same as launch/assignSessionToPane before any SetPen flush).
	p2.SessionIDs = []string{"b"}
	m.st.SetPen("(default)", p2)
	p1, _ = m.st.Pen(p1.ID)
	p2, _ = m.st.Pen(p2.ID)
	m.applyActivePen(p1)
	// Mutate panes as the product path does after launch/assign — never through
	// the store. This is the regression that misses a switchToPen flush.
	m.nPanes = 2
	m.panes[0].SessionID = "a"
	m.panes[0].Title = "A"
	m.panes[0].Status = domain.StatusIdle
	m.panes[1].SessionID = "extra"
	m.panes[1].Title = "Extra"
	m.panes[1].Status = domain.StatusIdle
	m.pen.SessionIDs = []string{"a", "extra"}
	if sp, _ := m.st.Pen(p1.ID); len(sp.SessionIDs) != 0 {
		t.Fatalf("precondition: store p1 must be empty before flush, got %+v", sp.SessionIDs)
	}

	next, _ := m.switchToPen(p2.ID)
	m = next.(Model)
	if m.pen.ID != "p2" {
		t.Fatalf("pen=%s", m.pen.ID)
	}
	if m.panes[0].SessionID != "b" {
		t.Fatalf("after switch pane0=%s want b", m.panes[0].SessionID)
	}
	if m.st.ActivePen("(default)").ID != "p2" {
		t.Fatal("store active pen not switched")
	}
	// Flush must have written pane-only membership for p1 into the store.
	flushed, ok := m.st.Pen(p1.ID)
	if !ok {
		t.Fatal("p1 missing from store")
	}
	if len(flushed.SessionIDs) != 2 || flushed.SessionIDs[0] != "a" || flushed.SessionIDs[1] != "extra" {
		t.Fatalf("switchToPen did not flush p1 membership: %+v", flushed.SessionIDs)
	}

	// Round-trip: switch back — must restore both sessions (E2 exit #4).
	next, _ = m.switchToPen(p1.ID)
	m = next.(Model)
	if m.pen.ID != "p1" {
		t.Fatalf("round-trip pen=%s", m.pen.ID)
	}
	if m.nPanes != 2 {
		t.Fatalf("round-trip nPanes=%d want 2", m.nPanes)
	}
	if m.panes[0].SessionID != "a" {
		t.Fatalf("round-trip pane0=%s want a", m.panes[0].SessionID)
	}
	if m.panes[1].SessionID != "extra" {
		t.Fatalf("round-trip pane1=%s want extra (membership lost on switch)", m.panes[1].SessionID)
	}

	// Palette path: pen: id selection
	m.rebuildPaletteItems()
	found := false
	for _, it := range m.paletteItems {
		if it.ID == "pen:p1" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("palette missing Switch pen items: %+v", m.paletteItems)
	}
}

func TestEmptyTableCTALaunch(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Caps: testLocalCaps()})
	m.applySize(80, 24)
	out := renderTable(m, 80, 16)
	if !strings.Contains(out, "press n to launch") {
		t.Fatalf("empty table CTA: %s", out)
	}
	if !strings.Contains(out, "Agents(local)[0]") {
		t.Fatalf("an empty table still says what it is: %s", out)
	}
}

func TestEmptyStateMentionsLaunch(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true})
	msg := emptyStateMessage(m)
	if !strings.Contains(msg, "launch") {
		t.Fatal(msg)
	}
}

func TestKeyNOpensLaunch(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Caps: testLocalCaps()})
	m.width, m.height = 80, 24
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	m = next.(Model)
	if m.stage != StageLaunch {
		t.Fatalf("stage=%s", m.stage)
	}
}
