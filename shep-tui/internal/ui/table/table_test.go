package table

import (
	"strings"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func sampleSessions() []domain.Session {
	return []domain.Session{
		{ID: "s1", NodeID: "node-a", ProjectID: "proj-1", Name: "alpha", Status: domain.StatusIdle},
		{ID: "s2", NodeID: "node-a", ProjectID: "proj-1", Name: "need-me", Status: domain.StatusAwaitingInput},
		{ID: "s3", NodeID: "node-a", ProjectID: "proj-2", Name: "beta", Status: domain.StatusRunning},
		{ID: "s4", NodeID: "node-b", ProjectID: "proj-3", Name: "gamma", Status: domain.StatusError},
	}
}

// One row per agent: the ones that need you first, then the roster by name.
func TestBuildPutsAttentionFirstThenNames(t *testing.T) {
	m := Build(sampleSessions())
	rows := m.Rows()
	if len(rows) != 4 {
		t.Fatalf("rows = %d, want one per agent", len(rows))
	}
	if rows[0].SessionID != "s2" || !rows[0].NeedsYou {
		t.Fatalf("first row = %+v, want the session that needs you", rows[0])
	}
	for i, want := range []string{"alpha", "beta", "gamma"} {
		if rows[i+1].Name != want {
			t.Fatalf("roster not name-ordered: %+v", rows)
		}
	}
	if got := rows[0].Status.Label(); got != "Needs you" {
		t.Fatalf("status cell = %q", got)
	}
}

// A roster that reorders itself when an agent changes state moves rows out from
// under the cursor mid-keystroke. Only the attention queue may reorder.
func TestAgentRosterDoesNotReorderOnStatusChange(t *testing.T) {
	m := Build(sampleSessions())
	before := m.Rows()[1:]

	changed := sampleSessions()
	changed[0].Status = domain.StatusRunning // alpha: idle -> working
	changed[2].Status = domain.StatusIdle    // beta:  working -> idle
	m.Rebuild(changed)

	after := m.Rows()[1:]
	for i := range before {
		if before[i].SessionID != after[i].SessionID {
			t.Fatalf("row %d moved after a status change: %q → %q",
				i, before[i].SessionID, after[i].SessionID)
		}
	}
}

func TestEmptyTable(t *testing.T) {
	m := Build(nil)
	if m.Cursor() != -1 {
		t.Fatalf("cursor = %d", m.Cursor())
	}
	if m.SelectedSessionID() != "" {
		t.Fatal("expected empty selection")
	}
	if m.Len() != 0 {
		t.Fatal("expected no rows")
	}
	m.Move(1) // no panic
}

// The cursor walks rows and clamps at both ends — every row is selectable.
func TestMoveClampsAtBothEnds(t *testing.T) {
	m := Build(sampleSessions())
	if got := m.SelectedSessionID(); got != "s2" {
		t.Fatalf("start selection = %q, want the session that needs you", got)
	}
	m.Move(1)
	if got := m.SelectedSessionID(); got != "s1" {
		t.Fatalf("after one step = %q want s1 (alpha, first roster row)", got)
	}
	m.Move(-1)
	if got := m.SelectedSessionID(); got != "s2" {
		t.Fatalf("stepping back = %q want s2", got)
	}
	m.Move(-10)
	if got := m.SelectedSessionID(); got != "s2" {
		t.Fatalf("clamp low = %q", got)
	}
	m.Move(100)
	if m.Cursor() != m.Len()-1 {
		t.Fatalf("clamp high: cursor = %d of %d rows", m.Cursor(), m.Len())
	}
}

func TestSetCursorClamps(t *testing.T) {
	m := Build(sampleSessions())
	m.SetCursor(99)
	if m.Cursor() != 3 {
		t.Fatalf("cursor = %d want the last row", m.Cursor())
	}
	m.SetCursor(-4)
	if m.Cursor() != 0 {
		t.Fatalf("cursor = %d want the first row", m.Cursor())
	}
}

// The selection is held by session id: a re-sort must not move the cursor onto
// another agent.
func TestRebuildKeepsSessionSelection(t *testing.T) {
	m := Build(sampleSessions())
	m.SetCursor(2)
	sel := m.SelectedSessionID()
	if sel != "s3" {
		t.Fatalf("selection = %q", sel)
	}

	changed := sampleSessions()
	changed[0].Status = domain.StatusAwaitingInput // alpha jumps the queue
	m.Rebuild(changed)
	if m.SelectedSessionID() != sel {
		t.Fatalf("the re-sort moved the cursor off %q onto %q", sel, m.SelectedSessionID())
	}

	m.Rebuild([]domain.Session{{ID: "s1", Name: "alpha", Status: domain.StatusIdle}})
	if m.SelectedSessionID() != "s1" {
		t.Fatalf("cursor should clamp onto a live session, got %q", m.SelectedSessionID())
	}
}

// The filter narrows the table by name, agent or project, and the selection
// survives it when the row is still listed.
func TestFilterNarrowsRows(t *testing.T) {
	m := Build(sampleSessions())
	m.SetFilter("bet")
	if m.Len() != 1 || m.SelectedSessionID() != "s3" {
		t.Fatalf("filter bet: %d rows, selection %q", m.Len(), m.SelectedSessionID())
	}
	m.SetFilter("proj-3")
	if m.Len() != 1 || m.SelectedSessionID() != "s4" {
		t.Fatalf("filter by project: %d rows, selection %q", m.Len(), m.SelectedSessionID())
	}
	m.SetFilter("nothing-matches-this")
	if m.Len() != 0 || m.SelectedSessionID() != "" {
		t.Fatalf("empty filter result: %d rows", m.Len())
	}
	m.SetFilter("")
	if m.Len() != 4 {
		t.Fatalf("clearing the filter left %d rows", m.Len())
	}
}

// A session with no name is labelled by the agent it runs, never by its uuid.
func TestUnnamedSessionIsLabelledByItsAgent(t *testing.T) {
	m := Build([]domain.Session{
		{ID: "8ca97ef3-d20b-4480-8773-4d7d5e5f0ead", AgentType: domain.AgentClaudeCode, Status: domain.StatusIdle},
	})
	row := m.Rows()[0]
	if row.Name != "Claude" {
		t.Errorf("name = %q, want the agent name", row.Name)
	}
	if row.Agent != "Claude" {
		t.Errorf("agent = %q", row.Agent)
	}
	if row.ShortID != "8ca97e" {
		t.Errorf("short id = %q, want a readable head of the uuid", row.ShortID)
	}
	if strings.Contains(strings.Join(m.Lines(120), "\n"), "d20b") {
		t.Errorf("the full uuid leaked into the row")
	}
}

func TestPenBadgesReachTheRows(t *testing.T) {
	m := Build(sampleSessions())
	m.SetPenBadges(map[string]string{"s2": "Main"})
	if m.Rows()[0].Badge != "Main" {
		t.Fatalf("missing pen badge: %+v", m.Rows()[0])
	}
	if m.SelectedSessionID() != "s2" {
		t.Fatalf("badges moved the cursor: %q", m.SelectedSessionID())
	}
}

// A narrow terminal drops the cheap columns; NAME and STATUS never go, and the
// columns always fill the width they were laid out for.
func TestLayoutDropsCheapColumnsFirst(t *testing.T) {
	for _, w := range []int{40, 60, 80, 100, 120, 200} {
		cols := Layout(w)
		has := map[Col]bool{}
		total := 0
		for i, c := range cols {
			has[c.Col] = true
			total += c.Width
			if i > 0 {
				total += colGap
			}
		}
		if !has[ColName] || !has[ColStatus] {
			t.Fatalf("width %d dropped NAME or STATUS: %+v", w, cols)
		}
		if total != w && w >= 40 {
			t.Fatalf("width %d: columns total %d", w, total)
		}
		if got := len(Header(w)); got == 0 {
			t.Fatalf("width %d: no header", w)
		}
	}
	wide := Layout(200)
	if len(wide) != len(colOrder) {
		t.Fatalf("a wide terminal must show every column: %d", len(wide))
	}
	narrow := Layout(45)
	for _, c := range narrow {
		if c.Col == ColCost || c.Col == ColTokens {
			t.Fatalf("narrow table kept a low-value column: %+v", narrow)
		}
	}
}

// A cell is truncated, never wrapped, and the numeric ones are right-aligned.
func TestPadFitsAndAligns(t *testing.T) {
	if got := Pad("claude-api", 6, false); got != "claud…" {
		t.Fatalf("truncate = %q", got)
	}
	if got := Pad("12k", 6, true); got != "   12k" {
		t.Fatalf("right align = %q", got)
	}
	if got := Pad("ab", 5, false); got != "ab   " {
		t.Fatalf("left align = %q", got)
	}
}

func TestContextPercent(t *testing.T) {
	pct, ok := ContextPercent(domain.Telemetry{ContextTokens: 42, ContextLimit: 100})
	if !ok || pct != 42 {
		t.Fatalf("pct=%d ok=%v", pct, ok)
	}
	pct, ok = ContextPercent(domain.Telemetry{ContextTokens: 1, ContextLimit: 3})
	if !ok || pct != 33 {
		t.Fatalf("pct=%d ok=%v", pct, ok)
	}
	pct, ok = ContextPercent(domain.Telemetry{ContextTokens: 2, ContextLimit: 3})
	if !ok || pct != 67 {
		t.Fatalf("pct=%d ok=%v", pct, ok)
	}
	if _, ok := ContextPercent(domain.Telemetry{ContextLimit: 0}); ok {
		t.Fatal("limit 0 should be !ok")
	}
	pct, ok = ContextPercent(domain.Telemetry{ContextTokens: 500, ContextLimit: 100})
	if !ok || pct != 100 {
		t.Fatalf("clamp: %d", pct)
	}
}

func TestFormatTokens(t *testing.T) {
	cases := map[int]string{
		0:     "",
		42:    "42",
		999:   "999",
		1000:  "1k",
		1500:  "1.5k",
		12000: "12k",
		12500: "12k",
	}
	for n, want := range cases {
		if got := FormatTokens(n); got != want {
			t.Errorf("FormatTokens(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestFormatCost(t *testing.T) {
	if got := FormatCost(0.18); got != "$0.18" {
		t.Fatal(got)
	}
	if got := FormatCost(1.2); got != "$1.20" {
		t.Fatal(got)
	}
}

// The telemetry a row carries is the session's own, so the table can draw a
// column of it without going back to the session list.
func TestRowsCarryTelemetry(t *testing.T) {
	cost := 0.18
	m := Build([]domain.Session{{
		ID:     "a",
		Name:   "claude-api",
		Status: domain.StatusRunning,
		Telemetry: domain.Telemetry{Model: "sonnet", ContextTokens: 42, ContextLimit: 100,
			Tokens: 12000, CostUSD: &cost},
	}})
	r := m.Rows()[0]
	if r.Model != "sonnet" || r.Ctx != "42%" || r.Tokens != "12k" || r.Cost != "$0.18" {
		t.Fatalf("row telemetry = %+v", r)
	}
	// A session the backend reports nothing for gets empty cells, not zeroes.
	empty := Build([]domain.Session{{ID: "b", Name: "b"}}).Rows()[0]
	if empty.Model != "" || empty.Ctx != "" || empty.Tokens != "" || empty.Cost != "" {
		t.Fatalf("unknown telemetry invented values: %+v", empty)
	}
}

func TestFormatAgeIsRelative(t *testing.T) {
	now := time.Date(2026, 7, 12, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		d    time.Duration
		want string
	}{
		{45 * time.Second, "45s"},
		{5 * time.Minute, "5m"},
		{17 * time.Hour, "17h"},
		{50 * time.Hour, "2d"},
	}
	for _, tc := range cases {
		if got := FormatAge(now.Add(-tc.d), now); got != tc.want {
			t.Errorf("FormatAge(-%s) = %q, want %q", tc.d, got, tc.want)
		}
	}
	if got := FormatAge(time.Time{}, now); got != "-" {
		t.Errorf("an unknown time must say so, got %q", got)
	}
}

// The project is a cell, not a level of nesting.
func TestProjectLabelIsTheProjectBasename(t *testing.T) {
	if got := ProjectLabel(domain.Session{ProjectID: "/work/shep-tui"}); got != "shep-tui" {
		t.Fatalf("got %q", got)
	}
	if got := ProjectLabel(domain.Session{Cwd: "/work/other"}); got != "other" {
		t.Fatalf("cwd fallback = %q", got)
	}
	if got := ProjectLabel(domain.Session{ProjectID: "(default)"}); got != "" {
		t.Fatalf("placeholder project = %q, want no cell", got)
	}
}
