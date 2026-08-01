// Package panel is the scrollable text surface behind StagePanel (git, chat,
// cost, compare, audit, files, handoff).
//
// It owns a bubbles/viewport, so panel content is never pre-clipped by its
// builder: everything the builder produced stays reachable by scrolling. The
// viewport's own key map is disabled — the app dispatches scrolling from the
// keybind registry, which is the only place a key may be named.
package panel

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/viewport"
	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

// Model is one open panel: its content plus the window onto it.
type Model struct {
	Kind  string
	Title string

	lines []string
	vp    viewport.Model
}

// New builds a panel sized for a w×h inner area.
func New(kind, title string, lines []string, w, h int) Model {
	m := Model{Kind: kind, Title: title}
	m.vp = viewport.New(max(w, 1), max(h, 1))
	m.vp.KeyMap = viewport.KeyMap{}
	m.SetLines(lines)
	return m
}

// SetSize re-lays the window (called from the app's single sizing path).
func (m *Model) SetSize(w, h int) {
	m.vp.Width = max(w, 1)
	m.vp.Height = max(h, 1)
}

// SetLines replaces the content, keeping the scroll offset in range.
func (m *Model) SetLines(lines []string) {
	m.lines = append([]string(nil), lines...)
	m.vp.SetContent(strings.Join(m.lines, "\n"))
	if m.vp.PastBottom() {
		m.vp.GotoBottom()
	}
}

// Lines returns the full (unclipped) content.
func (m Model) Lines() []string {
	return append([]string(nil), m.lines...)
}

func (m *Model) LineUp(n int)   { m.vp.LineUp(n) }
func (m *Model) LineDown(n int) { m.vp.LineDown(n) }
func (m *Model) HalfPageUp()    { m.vp.HalfViewUp() }
func (m *Model) HalfPageDown()  { m.vp.HalfViewDown() }
func (m *Model) GotoTop()       { m.vp.GotoTop() }
func (m *Model) GotoBottom()    { m.vp.GotoBottom() }
func (m Model) YOffset() int    { return m.vp.YOffset }

// View renders the title, the visible window and a line X/N scroll indicator.
// The caller owns the box; this is the content that goes inside it.
func (m Model) View(th theme.Theme) string {
	head := th.Title.Render(m.Title) + th.Muted.Render("  (esc to close)")
	body := m.vp.View()
	first := m.vp.YOffset + 1
	last := m.vp.YOffset + m.vp.Height
	if last > len(m.lines) {
		last = len(m.lines)
	}
	if len(m.lines) == 0 {
		first, last = 0, 0
	}
	foot := th.Muted.Render(fmt.Sprintf("line %d-%d/%d", first, last, len(m.lines)))
	return lipgloss.JoinVertical(lipgloss.Left, head, body, foot)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
