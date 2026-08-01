// Package cost builds spend tables from session telemetry.
package cost

import (
	"fmt"
	"sort"
	"strings"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// Row is one aggregated cost line (session, agent, model, etc.).
type Row struct {
	Key     string
	Tokens  int
	CostUSD float64
}

// Table is a set of cost rows with helpers for totals and display.
type Table struct {
	Rows []Row
}

// FromSessions rebuilds the table keyed by session ID from session telemetry.
// Sessions with neither tokens nor cost still appear (zero rows) so the table
// mirrors the full session list.
func (t *Table) FromSessions(sessions []domain.Session) {
	if t == nil {
		return
	}
	t.Rows = make([]Row, 0, len(sessions))
	for _, s := range sessions {
		key := s.ID
		if key == "" {
			key = s.Name
		}
		if key == "" {
			key = "-"
		}
		cost := 0.0
		if s.Telemetry.CostUSD != nil {
			cost = *s.Telemetry.CostUSD
		}
		t.Rows = append(t.Rows, Row{
			Key:     key,
			Tokens:  s.Telemetry.Tokens,
			CostUSD: cost,
		})
	}
	// Stable alphabetical by key for predictable CLI output.
	sort.SliceStable(t.Rows, func(i, j int) bool {
		return t.Rows[i].Key < t.Rows[j].Key
	})
}

// Total returns the sum of CostUSD across rows.
func (t *Table) Total() float64 {
	if t == nil {
		return 0
	}
	var sum float64
	for _, r := range t.Rows {
		sum += r.CostUSD
	}
	return sum
}

// Lines returns a simple table including a TOTAL footer.
func (t *Table) Lines() []string {
	if t == nil || len(t.Rows) == 0 {
		return []string{"(no cost rows)", "TOTAL  $0.0000"}
	}
	hKey, hTok, hCost := "KEY", "TOKENS", "COST"
	wKey, wTok, wCost := len(hKey), len(hTok), len(hCost)
	type cells struct{ key, tok, cost string }
	rows := make([]cells, 0, len(t.Rows))
	for _, r := range t.Rows {
		key := r.Key
		if key == "" {
			key = "-"
		}
		tok := fmt.Sprintf("%d", r.Tokens)
		cost := fmt.Sprintf("$%.4f", r.CostUSD)
		rows = append(rows, cells{key, tok, cost})
		wKey = max(wKey, len(key))
		wTok = max(wTok, len(tok))
		wCost = max(wCost, len(cost))
	}
	total := fmt.Sprintf("$%.4f", t.Total())
	wCost = max(wCost, len(total))

	header := fmt.Sprintf("%-*s  %*s  %*s", wKey, hKey, wTok, hTok, wCost, hCost)
	sep := strings.Repeat("-", len(header))
	out := make([]string, 0, 3+len(rows))
	out = append(out, header, sep)
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%-*s  %*s  %*s", wKey, r.key, wTok, r.tok, wCost, r.cost))
	}
	out = append(out, sep)
	out = append(out, fmt.Sprintf("%-*s  %*s  %*s", wKey, "TOTAL", wTok, "", wCost, total))
	return out
}
