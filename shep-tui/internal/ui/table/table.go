// Package table is the pure navigation model for the agents table.
//
// It flattens []domain.Session into one row per agent — the sessions that need
// you first, then the roster by name — supports cursor movement, live filtering
// and column fitting, and formats cells for rendering without depending on
// Bubble Tea.
package table

import (
	"fmt"
	"math"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// Row is one agent, one line.
type Row struct {
	SessionID string
	ShortID   string
	Name      string
	Agent     string
	Status    domain.Status
	Model     string
	Ctx       string
	Tokens    string
	Cost      string
	Project   string
	Seen      string
	Badge     string
	NeedsYou  bool
}

// Col is a table column.
type Col int

const (
	ColName Col = iota
	ColAgent
	ColStatus
	ColModel
	ColCtx
	ColTokens
	ColCost
	ColProject
	ColSeen
)

// Column is a column as it will be drawn: its heading, the cells it takes and
// how wide they are.
type Column struct {
	Col   Col
	Title string
	Width int
	Right bool
}

// colGap is the space between two columns.
const colGap = 2

// colSpec is a column's fixed shape. NAME is the flex column: it takes whatever
// the others leave, and it is never dropped.
var colSpec = map[Col]Column{
	ColName:    {Col: ColName, Title: "NAME", Width: 16},
	ColAgent:   {Col: ColAgent, Title: "AGENT", Width: 9},
	ColStatus:  {Col: ColStatus, Title: "STATUS", Width: 11},
	ColModel:   {Col: ColModel, Title: "MODEL", Width: 8},
	ColCtx:     {Col: ColCtx, Title: "CTX", Width: 5, Right: true},
	ColTokens:  {Col: ColTokens, Title: "TOKENS", Width: 7, Right: true},
	ColCost:    {Col: ColCost, Title: "COST", Width: 7, Right: true},
	ColProject: {Col: ColProject, Title: "PROJECT", Width: 14},
	// UpdatedAt is the last time the backend said anything about the session, not
	// when it was born: the column says SEEN because that is what the number is.
	ColSeen: {Col: ColSeen, Title: "SEEN", Width: 5, Right: true},
}

// colOrder is the order the columns are drawn in.
var colOrder = []Col{ColName, ColAgent, ColStatus, ColModel, ColCtx, ColTokens, ColCost, ColProject, ColSeen}

// dropOrder is what a narrow terminal gives up, cheapest first. NAME and STATUS
// are never in it: an agent you cannot name and cannot read the state of is a
// row that says nothing.
var dropOrder = []Col{ColCost, ColTokens, ColModel, ColProject, ColCtx, ColSeen, ColAgent}

// minNameWidth is the narrowest NAME that still names an agent; maxNameWidth is
// the widest one worth printing.
const (
	minNameWidth = 10
	maxNameWidth = 28
)

// Layout is the columns that fit in width, widest set first. NAME absorbs
// whatever is left over, so the table always fills its box.
func Layout(width int) []Column {
	return LayoutOmit(width)
}

// LayoutOmit is Layout without the columns the backend cannot fill. A column of
// blanks is a column that says the value is zero; a backend that cannot report
// it does not get the column.
func LayoutOmit(width int, omit ...Col) []Column {
	drop := map[Col]bool{}
	for _, c := range omit {
		drop[c] = true
	}
	order := make([]Col, 0, len(colOrder))
	for _, c := range colOrder {
		if !drop[c] {
			order = append(order, c)
		}
	}
	fallback := make([]Col, 0, len(dropOrder))
	for _, c := range dropOrder {
		if !drop[c] {
			fallback = append(fallback, c)
		}
	}
	return layout(width, order, colSpec, fallback, ColName, ColProject)
}

// layout is the column fitter both tables use: drop the cheapest columns until
// the set fits, then hand the slack to flex (and, past the width a name is ever
// worth printing at, to spill instead — a name column half of which is blank is
// half the table wasted).
func layout(width int, order []Col, spec map[Col]Column, drop []Col, flex, spill Col) []Column {
	if width < 1 {
		width = 1
	}
	keep := map[Col]bool{}
	for _, c := range order {
		keep[c] = true
	}
	fits := func() bool {
		total := 0
		n := 0
		for _, c := range order {
			if !keep[c] {
				continue
			}
			w := spec[c].Width
			if c == flex {
				w = minNameWidth
			}
			total += w
			n++
		}
		return total+colGap*max(n-1, 0) <= width
	}
	for _, d := range drop {
		if fits() {
			break
		}
		keep[d] = false
	}

	var cols []Column
	for _, c := range order {
		if keep[c] {
			cols = append(cols, spec[c])
		}
	}
	used := 0
	for _, c := range cols {
		if c.Col == flex {
			continue
		}
		used += c.Width
	}
	used += colGap * max(len(cols)-1, 0)
	slack := max(width-used, minNameWidth)
	over := 0
	if slack > maxNameWidth {
		over = slack - maxNameWidth
		slack = maxNameWidth
	}
	for i := range cols {
		switch cols[i].Col {
		case flex:
			cols[i].Width = slack
		case spill:
			cols[i].Width += over
			over = 0
		}
	}
	// Nothing to spill into: the flex column keeps it, so the columns still fill
	// the box.
	for i := range cols {
		if cols[i].Col == flex {
			cols[i].Width += over
		}
	}
	return cols
}

// Cell is the row's value for a column.
func (r Row) Cell(c Col) string {
	switch c {
	case ColName:
		return r.Name
	case ColAgent:
		return r.Agent
	case ColStatus:
		return r.Status.Label()
	case ColModel:
		return r.Model
	case ColCtx:
		return r.Ctx
	case ColTokens:
		return r.Tokens
	case ColCost:
		return r.Cost
	case ColProject:
		return r.Project
	case ColSeen:
		return r.Seen
	}
	return ""
}

// Model is the pure table navigation state.
type Model struct {
	sessions []domain.Session
	penBadge map[string]string
	filter   string

	rows   []Row
	cursor int
}

// Build constructs a table from sessions.
func Build(sessions []domain.Session) *Model {
	m := &Model{
		sessions: append([]domain.Session(nil), sessions...),
		penBadge: make(map[string]string),
	}
	m.rebuild()
	m.cursor = m.clamp(0)
	return m
}

// SetPenBadges sets sessionID → pen display name.
func (m *Model) SetPenBadges(badges map[string]string) {
	m.penBadge = make(map[string]string, len(badges))
	for k, v := range badges {
		m.penBadge[k] = v
	}
	m.rebuild()
}

// SetFilter narrows the table to the rows matching q (name, agent or project).
func (m *Model) SetFilter(q string) {
	prev := m.SelectedSessionID()
	m.filter = q
	m.rebuild()
	m.restore(prev)
}

// Filter is the live query.
func (m *Model) Filter() string { return m.filter }

// Rebuild replaces the session snapshot. The cursor stays on the same session
// when it is still listed; otherwise it is clamped.
func (m *Model) Rebuild(sessions []domain.Session) {
	prev := m.SelectedSessionID()
	m.sessions = append([]domain.Session(nil), sessions...)
	m.rebuild()
	m.restore(prev)
}

// restore re-anchors the cursor on a session across a re-sort.
func (m *Model) restore(id string) {
	if id != "" {
		for i, r := range m.rows {
			if r.SessionID == id {
				m.cursor = i
				return
			}
		}
	}
	m.cursor = m.clamp(m.cursor)
}

func (m *Model) rebuild() {
	var needs, roster []domain.Session
	for _, s := range m.sessions {
		if !matches(s, m.filter) {
			continue
		}
		if s.Status == domain.StatusAwaitingInput {
			needs = append(needs, s)
			continue
		}
		roster = append(roster, s)
	}
	// The queue sorts by urgency; the roster sorts by name and stays where the
	// user left it — a roster sorted by status reorders itself under the cursor
	// every time an agent starts or finishes.
	domain.SortSessionsByAttention(needs)
	sort.SliceStable(roster, func(i, j int) bool {
		return roster[i].Label() < roster[j].Label()
	})

	rows := make([]Row, 0, len(needs)+len(roster))
	for _, s := range append(needs, roster...) {
		rows = append(rows, m.row(s))
	}
	m.rows = rows
}

func matches(s domain.Session, q string) bool {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return true
	}
	for _, field := range []string{s.Label(), string(s.AgentType), s.AgentType.Short(), ProjectLabel(s)} {
		if strings.Contains(strings.ToLower(field), q) {
			return true
		}
	}
	return false
}

func (m *Model) row(s domain.Session) Row {
	r := Row{
		SessionID: s.ID,
		ShortID:   domain.ShortID(s.ID),
		Name:      s.Label(),
		Agent:     s.AgentType.Short(),
		Status:    s.Status,
		Model:     s.Telemetry.Model,
		Tokens:    FormatTokens(s.Telemetry.Tokens),
		Project:   ProjectLabel(s),
		Seen:      FormatAge(s.UpdatedAt, time.Now()),
		Badge:     m.penBadge[s.ID],
		NeedsYou:  s.Status == domain.StatusAwaitingInput,
	}
	if pct, ok := ContextPercent(s.Telemetry); ok {
		r.Ctx = fmt.Sprintf("%d%%", pct)
	}
	if s.Telemetry.CostUSD != nil {
		r.Cost = FormatCost(*s.Telemetry.CostUSD)
	}
	return r
}

// Move steps the cursor by delta rows, clamping at both ends.
func (m *Model) Move(delta int) {
	if len(m.rows) == 0 {
		m.cursor = -1
		return
	}
	m.cursor = m.clamp(m.cursor + delta)
}

// SetCursor parks the cursor on a row (a click, not a step).
func (m *Model) SetCursor(i int) { m.cursor = m.clamp(i) }

func (m *Model) clamp(i int) int {
	if len(m.rows) == 0 {
		return -1
	}
	if i < 0 {
		return 0
	}
	if i >= len(m.rows) {
		return len(m.rows) - 1
	}
	return i
}

// Cursor returns the current row index (-1 if empty).
func (m *Model) Cursor() int { return m.cursor }

// Len is how many rows the table has.
func (m *Model) Len() int { return len(m.rows) }

// Rows returns a copy of the visible rows.
func (m *Model) Rows() []Row {
	return append([]Row(nil), m.rows...)
}

// Selected returns the row under the cursor.
func (m *Model) Selected() (Row, bool) {
	if m.cursor < 0 || m.cursor >= len(m.rows) {
		return Row{}, false
	}
	return m.rows[m.cursor], true
}

// SelectedSessionID returns the session under the cursor, or "".
func (m *Model) SelectedSessionID() string {
	r, ok := m.Selected()
	if !ok {
		return ""
	}
	return r.SessionID
}

// Lines returns render-ready strings for each row (no theme).
func (m *Model) Lines(width int) []string {
	cols := Layout(width)
	out := make([]string, 0, len(m.rows))
	for _, r := range m.rows {
		cells := make([]string, 0, len(cols))
		for _, c := range cols {
			cells = append(cells, Pad(r.Cell(c.Col), c.Width, c.Right))
		}
		out = append(out, strings.Join(cells, strings.Repeat(" ", colGap)))
	}
	return out
}

// Header is the column heading line.
func Header(width int) string {
	return headerLine(Layout(width))
}

// HeaderCols is the heading line for a column set the caller already fitted.
func HeaderCols(cols []Column) string {
	return headerLine(cols)
}

func headerLine(cols []Column) string {
	cells := make([]string, 0, len(cols))
	for _, c := range cols {
		cells = append(cells, Pad(c.Title, c.Width, c.Right))
	}
	return strings.Join(cells, strings.Repeat(" ", colGap))
}

// Pad fits s into width, padding left (right-aligned) or right, and truncating
// what will not fit — a table cell never wraps.
func Pad(s string, width int, right bool) string {
	if width <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) > width {
		if width == 1 {
			return "…"
		}
		return string(runes[:width-1]) + "…"
	}
	pad := strings.Repeat(" ", width-len(runes))
	if right {
		return pad + s
	}
	return s + pad
}

// String implements fmt.Stringer for debugging.
func (m *Model) String() string {
	return strings.Join(m.Lines(100), "\n")
}

// ProjectLabel is the session's project as a cell: the last element of the
// project id (a cwd, in practice), which is what tells two checkouts apart.
func ProjectLabel(s domain.Session) string {
	id := s.ProjectID
	if id == "" || id == "(default)" {
		id = s.Cwd
	}
	if id == "" || id == "(default)" {
		return ""
	}
	if strings.ContainsRune(id, '/') {
		return path.Base(id)
	}
	return id
}

// ContextPercent returns 0–100 from ContextTokens/ContextLimit.
// ok is false when ContextLimit <= 0 (unknown budget).
func ContextPercent(tel domain.Telemetry) (pct int, ok bool) {
	if tel.ContextLimit <= 0 {
		return 0, false
	}
	raw := float64(tel.ContextTokens) / float64(tel.ContextLimit) * 100
	if raw < 0 {
		raw = 0
	}
	p := int(math.Round(raw))
	if p > 100 {
		p = 100
	}
	return p, true
}

// FormatTokens renders a token count for a cell ("12k", "1.5k", "42"). Zero is
// nothing rather than a zero: a column of noughts is a column of noise.
func FormatTokens(n int) string {
	if n <= 0 {
		return ""
	}
	if n >= 1000 {
		if n >= 10000 || n%1000 == 0 {
			return fmt.Sprintf("%dk", n/1000)
		}
		return fmt.Sprintf("%.1fk", float64(n)/1000.0)
	}
	return fmt.Sprintf("%d", n)
}

// FormatCost renders a USD cost ("$0.18", "$1.20").
func FormatCost(usd float64) string {
	if usd < 0 {
		usd = 0
	}
	return fmt.Sprintf("$%.2f", usd)
}

// FormatAge is a relative time, k9s-style: 45s, 17m, 3h, 2d. A zero time is
// unknown, and says so with a dash rather than with a made-up number.
func FormatAge(t, now time.Time) string {
	if t.IsZero() {
		return "-"
	}
	d := now.Sub(t)
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
