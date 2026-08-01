// Mouse support: hit-testing the chrome the renderers drew, from one geometry.
package app

import (
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/ui/pen"
)

// mouseWheelLines is how far one wheel notch scrolls a text surface.
const mouseWheelLines = 3

// chromeTop is the first body row: the title bar, plus the connectivity banner
// while the backend is being retried. Both are measured rather than assumed —
// the title wraps to two rows on a narrow terminal, and a hit-test that assumed
// one would be a row off for every click.
func (m Model) chromeTop() int {
	top := lipgloss.Height(renderHeader(m))
	if m.showBanner() {
		top += lipgloss.Height(renderBanner(m))
	}
	return top
}

// bodyHeight is the rows between the chrome and the shell drawer. paneRects and
// every hit-test read it, so a click cannot land a row away from what was drawn.
func (m Model) bodyHeight() int {
	drawerH := 0
	if m.shellOpen {
		drawerH = shellDrawerHeight(m.height)
	}
	// chrome + the statusline row under the body.
	return max(m.height-m.chromeTop()-1-drawerH, 1)
}

// dockReserve is the rows View hands to a bottom-docked overlay so the surface
// behind it stays usable.
func (m Model) dockReserve() int {
	switch m.stage {
	case StagePalette:
		return min(14, max(8, m.height/3))
	case StageRespond, StageRename, StageFilter:
		return 5
	}
	return 0
}

// stageBodyHeight is the height of the box the stage body is drawn into: the
// body, minus whatever a docked overlay took from it.
func (m Model) stageBodyHeight() int {
	h := m.bodyHeight()
	if m.dockReserve() > 0 {
		// The dock replaces the status strip while it is open.
		h++
	}
	return max(h-m.dockReserve(), 1)
}

// stageGeometry is where the panes are on the screen. paneRects' Y is relative
// to the stage body — which is what the PTY sizing needs — so hit-testing lifts
// it into absolute rows rather than laying the panes out a second time.
func (m Model) stageGeometry() map[int]pen.Rect {
	rects := m.paneRects()
	if rects == nil {
		return nil
	}
	top := m.chromeTop()
	out := make(map[int]pen.Rect, len(rects))
	for i, r := range rects {
		r.Y += top
		out[i] = r
	}
	return out
}

// tableRect is the box the agents table is drawn in: the whole body, and only
// while the table is the surface on screen.
func (m Model) tableRect() (pen.Rect, bool) {
	if m.bodyStage() != StageTable {
		return pen.Rect{}, false
	}
	return m.stageRect()
}

func (m Model) stageRect() (pen.Rect, bool) {
	if m.width <= 0 || m.height <= 0 {
		return pen.Rect{}, false
	}
	return pen.Rect{X: 0, Y: m.chromeTop(), W: m.width, H: m.bodyHeight()}, true
}

func (m Model) drawerRect() (pen.Rect, bool) {
	if !m.shellOpen || m.height <= 0 {
		return pen.Rect{}, false
	}
	return pen.Rect{
		X: 0,
		Y: m.chromeTop() + m.bodyHeight(),
		W: max(m.width, 1),
		H: shellDrawerHeight(m.height),
	}, true
}

func inRect(r pen.Rect, x, y int) bool {
	return x >= r.X && x < r.X+r.W && y >= r.Y && y < r.Y+r.H
}

// paneAt is the pane drawn under (x, y), if any.
func (m Model) paneAt(x, y int) (int, bool) {
	for i, r := range m.stageGeometry() {
		if inRect(r, x, y) {
			return i, true
		}
	}
	return 0, false
}

// mouseEnabled honors the ui.mouse setting live: capture is armed at startup,
// but turning it off in Settings must take the pointer back without a restart.
func (m Model) mouseEnabled() bool {
	return m.cfg == nil || m.cfg.UI.Mouse
}

// handleMouse routes a mouse event to the surface under the pointer.
//
// In ModeInput the pointer belongs to the agent's terminal, and shep-tui has
// no way to know whether the program inside enabled mouse tracking: forwarding
// SGR sequences to one that did not would inject garbage into its input, so the
// event is swallowed. Detach (chrome mode) to use the mouse on the paddock.
func (m Model) handleMouse(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if !m.mouseEnabled() || m.fatal || m.showSplash || m.mode == ModeInput {
		return m, nil
	}
	if msg.Action != tea.MouseActionPress {
		return m, nil
	}
	if m.stage == StagePalette {
		return m.mousePalette(msg)
	}
	if m.stage.floating() || m.stage == StageLaunch {
		// A modal overlay owns the screen; a click behind it is not a click on it.
		return m, nil
	}
	switch msg.Button {
	case tea.MouseButtonWheelUp:
		return m.mouseWheel(msg, true)
	case tea.MouseButtonWheelDown:
		return m.mouseWheel(msg, false)
	case tea.MouseButtonLeft:
		return m.mouseClick(msg)
	}
	return m, nil
}

func (m Model) mouseWheel(msg tea.MouseMsg, up bool) (tea.Model, tea.Cmd) {
	step := 1
	if !up {
		step = -1
	}
	if r, ok := m.tableRect(); ok && inRect(r, msg.X, msg.Y) {
		m.moveTableCursor(-step)
		return m, nil
	}
	if r, ok := m.stageRect(); !ok || !inRect(r, msg.X, msg.Y) {
		return m, nil
	}
	switch m.bodyStage() {
	case StagePanel:
		if up {
			m.panel.LineUp(mouseWheelLines)
		} else {
			m.panel.LineDown(mouseWheelLines)
		}
		return m, nil
	case StageSettings:
		n := int(settingRowCount)
		m.settingsCursor = (m.settingsCursor - step + n) % n
		return m, nil
	}
	if i, ok := m.paneAt(msg.X, msg.Y); ok {
		// Wheel up walks back into the pane's scrollback.
		m.scrollPane(i, step*mouseWheelLines)
	}
	return m, nil
}

func (m Model) mouseClick(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	if r, ok := m.tableRect(); ok && inRect(r, msg.X, msg.Y) {
		m.region = RegionMain
		if row, ok := m.tableRowAt(msg.Y - r.Y); ok {
			m.setTableCursor(row)
		}
		return m, nil
	}
	if r, ok := m.drawerRect(); ok && inRect(r, msg.X, msg.Y) {
		m.region = RegionShell
		return m, nil
	}
	// The stage column belongs to whatever renderStage drew there. Only the pen
	// and zen surfaces show panes, so only they may hit-test one: paneRects returns
	// pane rects behind the other surfaces too, and a click there must move that
	// surface's cursor, not focus a pane the user cannot see.
	if r, ok := m.stageRect(); ok && inRect(r, msg.X, msg.Y) {
		switch m.bodyStage() {
		case StageSettings:
			m.region = RegionMain
			if row, ok := m.settingsRowAt(msg.Y - r.Y); ok {
				m.settingsCursor = row
			}
			return m, nil
		case StagePanel, StageLaunch:
			return m, nil
		}
	}
	if i, ok := m.paneAt(msg.X, msg.Y); ok {
		switch m.bodyStage() {
		case StagePen, StageZen:
			return m.focusPane(i)
		}
	}
	return m, nil
}

// settingsRowAt maps a row inside the settings surface to an editable row. Only
// the setting rows are selectable: the doctor readout below them is read-only.
func (m Model) settingsRowAt(y int) (int, bool) {
	cursor := min(max(m.settingsCursor, 0), int(settingRowCount)-1)
	lines := m.settingsLines(cursor, max(m.width, 1))
	row, ok := listRowAt(y, len(lines), cursor, m.boxedListRows(), boxedListTop)
	if !ok || row >= int(settingRowCount) {
		return 0, false
	}
	return row, true
}

// tableRowAt maps a row inside the table (y relative to its top) to an agent,
// through the same window renderTable drew: the box border and the column
// heading are above the first agent, and one agent is one line.
func (m Model) tableRowAt(y int) (int, bool) {
	if m.table == nil || m.table.Len() == 0 {
		return 0, false
	}
	return listRowAt(y, m.table.Len(), m.table.Cursor(),
		m.tableRows(m.stageBodyHeight()), tableTop)
}

// tableTop is the rows the table spends above its first agent: the top border
// and the column heading.
const tableTop = 2

// boxedListTop is the rows a boxed list spends above its first entry: the border
// and the list title.
const boxedListTop = 2

// boxedListRows is how many entries a list drawn in a full-stage box gets.
func (m Model) boxedListRows() int {
	return max(m.stageBodyHeight()-5, 1)
}

// listRowAt inverts listRows: the surface's own chrome (top), then the window —
// minus the row the "↑ N more" marker takes when there is history above.
func listRowAt(y, n, cursor, rows, top int) (int, bool) {
	if n == 0 {
		return 0, false
	}
	start, end := listWindow(n, cursor, rows)
	row := y - top
	if start > 0 {
		row--
	}
	if row < 0 {
		return 0, false
	}
	idx := start + row
	if idx >= end {
		return 0, false
	}
	return idx, true
}

// mousePalette selects (and runs) the palette row under the pointer, and lets
// the wheel walk the result list.
func (m Model) mousePalette(msg tea.MouseMsg) (tea.Model, tea.Cmd) {
	switch msg.Button {
	case tea.MouseButtonWheelUp:
		if len(m.paletteItems) > 0 {
			m.paletteCursor = (m.paletteCursor - 1 + len(m.paletteItems)) % len(m.paletteItems)
		}
		return m, nil
	case tea.MouseButtonWheelDown:
		if len(m.paletteItems) > 0 {
			m.paletteCursor = (m.paletteCursor + 1) % len(m.paletteItems)
		}
		return m, nil
	case tea.MouseButtonLeft:
		item, ok := m.paletteItemAt(msg.Y)
		if !ok {
			return m, nil
		}
		m.paletteCursor = item
		return m.runPaletteSelection()
	}
	return m, nil
}

// paletteItemAt maps a screen row to a palette item. The palette is docked at
// the bottom, so its top row depends on how tall it rendered.
func (m Model) paletteItemAt(y int) (int, bool) {
	if m.width <= 0 || m.height <= 0 {
		return 0, false
	}
	top := m.height - lipgloss.Height(renderPalette(m, m.width))
	// box border, header, filter input
	row := y - top - 3
	rows := m.paletteRows()
	if row < 0 || row >= len(rows) || rows[row].item < 0 {
		return 0, false
	}
	return rows[row].item, true
}

// mouseProgramOpts arms mouse capture unless the user turned it off: capture
// takes native text selection away from the terminal, which is not ours to take
// by default without the setting saying so.
func mouseProgramOpts(mouse bool) []tea.ProgramOption {
	if !mouse {
		return nil
	}
	return []tea.ProgramOption{tea.WithMouseCellMotion()}
}
