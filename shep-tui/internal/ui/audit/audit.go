// Package audit is a filterable audit-log browser model (UI + CLI).
package audit

import (
	"fmt"
	"strings"
	"time"
)

// Entry is one audit event (fleet or fixture).
type Entry struct {
	Time   time.Time `json:"time"`
	Action string    `json:"action"`
	Actor  string    `json:"actor"`
	Target string    `json:"target"`
	Detail string    `json:"detail"`
}

// Browser holds entries with a simple substring filter and cursor.
type Browser struct {
	Entries []Entry
	Filter  string
	Cursor  int
}

// SetFilter updates the filter string and clamps the cursor into the filtered set.
func (b *Browser) SetFilter(q string) {
	if b == nil {
		return
	}
	b.Filter = q
	n := len(b.Filtered())
	if n == 0 {
		b.Cursor = 0
		return
	}
	if b.Cursor < 0 {
		b.Cursor = 0
	}
	if b.Cursor >= n {
		b.Cursor = n - 1
	}
}

// Filtered returns entries matching the case-insensitive substring filter
// against action, actor, target, and detail.
func (b *Browser) Filtered() []Entry {
	if b == nil {
		return nil
	}
	q := strings.TrimSpace(b.Filter)
	if q == "" {
		out := make([]Entry, len(b.Entries))
		copy(out, b.Entries)
		return out
	}
	ql := strings.ToLower(q)
	out := make([]Entry, 0, len(b.Entries))
	for _, e := range b.Entries {
		if entryMatches(e, ql) {
			out = append(out, e)
		}
	}
	return out
}

func entryMatches(e Entry, ql string) bool {
	hay := strings.ToLower(strings.Join([]string{e.Action, e.Actor, e.Target, e.Detail}, " "))
	return strings.Contains(hay, ql)
}

// Lines formats filtered entries for CLI/TUI display.
func (b *Browser) Lines() []string {
	f := b.Filtered()
	if len(f) == 0 {
		if b != nil && strings.TrimSpace(b.Filter) != "" {
			return []string{fmt.Sprintf("(no audit entries match %q)", b.Filter)}
		}
		return []string{"(no audit entries)"}
	}
	out := make([]string, 0, len(f))
	for i, e := range f {
		mark := " "
		if b != nil && i == b.Cursor {
			mark = ">"
		}
		ts := e.Time.UTC().Format(time.RFC3339)
		if e.Time.IsZero() {
			ts = "-"
		}
		out = append(out, fmt.Sprintf("%s %s  %s  actor=%s  target=%s  %s",
			mark, ts, emptyDash(e.Action), emptyDash(e.Actor), emptyDash(e.Target), emptyDash(e.Detail)))
	}
	return out
}

func emptyDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
