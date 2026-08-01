package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func mouseModel(t *testing.T) Model {
	t.Helper()
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions: []domain.Session{
			{ID: "alpha", Name: "Alpha", Status: domain.StatusRunning},
			{ID: "bravo", Name: "Bravo", Status: domain.StatusAwaitingInput},
		},
	})
	m.applySize(120, 40)
	// Two panes on the pens surface: a click has to be able to land on the one
	// that is not focused.
	nm, _ := m.setPaneCount(2)
	m = nm.(Model)
	nm, _ = m.openPens()
	return nm.(Model)
}

// tableModel is the same model on its home surface: the agents table.
func tableModel(t *testing.T) Model {
	t.Helper()
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions: []domain.Session{
			{ID: "alpha", Name: "Alpha", Status: domain.StatusRunning},
			{ID: "bravo", Name: "Bravo", Status: domain.StatusAwaitingInput},
		},
	})
	m.applySize(120, 40)
	return m
}

func click(m Model, x, y int) Model {
	next, _ := m.Update(tea.MouseMsg{X: x, Y: y, Action: tea.MouseActionPress, Button: tea.MouseButtonLeft})
	return next.(Model)
}

func wheel(m Model, x, y int, up bool) Model {
	btn := tea.MouseButtonWheelDown
	if up {
		btn = tea.MouseButtonWheelUp
	}
	next, _ := m.Update(tea.MouseMsg{X: x, Y: y, Action: tea.MouseActionPress, Button: btn})
	return next.(Model)
}

// center of a rect, so a click lands inside the box and not on its border.
func center(x, y, w, h int) (int, int) { return x + w/2, y + h/2 }

func TestStageGeometryIsAbsolute(t *testing.T) {
	m := mouseModel(t)
	geo := m.stageGeometry()
	if len(geo) != 2 {
		t.Fatalf("geometry = %v", geo)
	}
	for i, r := range geo {
		if r.Y < m.chromeTop() {
			t.Fatalf("pane %d starts at row %d, above the title bar", i, r.Y)
		}
		if r.Y+r.H > m.height {
			t.Fatalf("pane %d runs off the bottom: %+v", i, r)
		}
	}
	// The banner takes a row from the body, and the panes move down with it.
	before := geo[0].Y
	m.reconnecting = true
	if after := m.stageGeometry()[0].Y; after != before+1 {
		t.Fatalf("banner did not shift the stage: %d → %d", before, after)
	}
}

func TestMouseClickFocusesPane(t *testing.T) {
	m := mouseModel(t)
	m.focus = 0

	r := m.stageGeometry()[1]
	x, y := center(r.X, r.Y, r.W, r.H)
	m = click(m, x, y)

	if m.focus != 1 {
		t.Fatalf("focus = %d after clicking pane 2", m.focus)
	}
	if m.region != RegionMain {
		t.Fatalf("region = %s after clicking a pane", m.region)
	}
}

func TestMouseWheelScrollsPaneUnderPointer(t *testing.T) {
	m := mouseModel(t)
	m.panes[1].feed([]byte(strings.Repeat("line\r\n", 200)))

	r := m.stageGeometry()[1]
	x, y := center(r.X, r.Y, r.W, r.H)
	m = wheel(m, x, y, true)

	if m.panes[1].scrollOff != mouseWheelLines {
		t.Fatalf("scrollOff = %d want %d", m.panes[1].scrollOff, mouseWheelLines)
	}
	if m.panes[0].scrollOff != 0 {
		t.Fatalf("wheel scrolled the wrong pane: %d", m.panes[0].scrollOff)
	}
	m = wheel(m, x, y, false)
	if m.panes[1].scrollOff != 0 {
		t.Fatalf("wheel down did not return to live: %d", m.panes[1].scrollOff)
	}
}

// A click on a table row selects the agent it landed on.
func TestMouseClickSelectsTableRow(t *testing.T) {
	m := tableModel(t)
	r, ok := m.tableRect()
	if !ok {
		t.Fatal("no table on screen")
	}
	rows := m.table.Rows()
	if len(rows) != 2 {
		t.Fatalf("table has %d rows", len(rows))
	}
	// The box border and the column heading are above the first agent.
	m = click(m, r.X+2, r.Y+tableTop+1)

	if m.region != RegionMain {
		t.Fatalf("region = %s after clicking the table", m.region)
	}
	if m.table.Cursor() != 1 {
		t.Fatalf("table cursor = %d want the second row", m.table.Cursor())
	}
	if m.focusSessionID != rows[1].SessionID {
		t.Fatalf("click selected %q, not the row it landed on (%q)", m.focusSessionID, rows[1].SessionID)
	}
}

// The wheel walks the table cursor.
func TestMouseWheelWalksTheTable(t *testing.T) {
	m := tableModel(t)
	r, _ := m.tableRect()
	m = wheel(m, r.X+2, r.Y+tableTop+1, false)
	if m.table.Cursor() != 1 {
		t.Fatalf("wheel down cursor = %d", m.table.Cursor())
	}
	m = wheel(m, r.X+2, r.Y+tableTop+1, true)
	if m.table.Cursor() != 0 {
		t.Fatalf("wheel up cursor = %d", m.table.Cursor())
	}
}

// Every drawn line maps back to the agent on it: a hit-test a row out selects
// the wrong agent, and gets further off with every row.
func TestEveryTableLineMapsToItsRow(t *testing.T) {
	m := tableModel(t)
	for i := 0; i < m.table.Len(); i++ {
		got, ok := m.tableRowAt(tableTop + i)
		if !ok || got != i {
			t.Fatalf("line %d mapped to row %d (ok=%v)", i, got, ok)
		}
	}
	if _, ok := m.tableRowAt(0); ok {
		t.Fatal("the top border is not a row")
	}
}

// A stage surface is drawn instead of the panes, not over them: a click on a
// row selects the row and may not focus a pane the user cannot see.
func TestMouseClickSelectsSettingsRow(t *testing.T) {
	m := mouseModel(t)
	nm, _ := m.openSettings()
	m = nm.(Model)
	m.focus = 0

	r, ok := m.stageRect()
	if !ok {
		t.Fatal("no stage column")
	}
	m = click(m, r.X+2, r.Y+2+int(settingRowScrollback))

	if m.settingsCursor != int(settingRowScrollback) {
		t.Fatalf("settingsCursor = %d, want the clicked row", m.settingsCursor)
	}
	if m.focus != 0 {
		t.Fatalf("the click focused pane %d behind the settings surface", m.focus)
	}
}

func TestMouseClickRunsPaletteItem(t *testing.T) {
	m := mouseModel(t)
	next, _ := m.openPalette()
	m = next.(Model)
	m.paletteQuery = "help overlay"
	m.rebuildPaletteItems()
	if len(m.paletteItems) == 0 || m.paletteItems[0].ID != "action:help" {
		t.Fatalf("filter did not surface help: %+v", m.paletteItems)
	}

	// box border + header + filter input, then the group header above the row.
	top := m.height - strings.Count(renderPalette(m, m.width), "\n") - 1
	m = click(m, 4, top+3+1)

	if m.stage != StageHelp {
		t.Fatalf("stage = %s after clicking the help row", m.stage)
	}
}

func TestMouseDisabledByConfig(t *testing.T) {
	m := mouseModel(t)
	cfg := config.Default()
	cfg.UI.Mouse = false
	m.cfg = cfg
	m.focus = 0

	r := m.stageGeometry()[1]
	x, y := center(r.X, r.Y, r.W, r.H)
	m = click(m, x, y)

	if m.focus != 0 {
		t.Fatalf("focus = %d with ui.mouse off", m.focus)
	}
	if opts := mouseProgramOpts(m.mouseEnabled()); len(opts) != 0 {
		t.Fatal("mouse capture armed with ui.mouse off")
	}
}

func TestMouseSwallowedInInputMode(t *testing.T) {
	m := mouseModel(t)
	m.panes[0].Stream = &stubStream{}
	m.panes[0].feed([]byte(strings.Repeat("line\r\n", 200)))
	next, _ := m.enterInput()
	m = next.(Model)

	r := m.stageGeometry()[0]
	x, y := center(r.X, r.Y, r.W, r.H)
	m = wheel(m, x, y, true)

	// The agent's program owns the pointer; the paddock must not act on it.
	if m.panes[0].scrollOff != 0 {
		t.Fatalf("wheel scrolled a pane in input mode: %d", m.panes[0].scrollOff)
	}
}
