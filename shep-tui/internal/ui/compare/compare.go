// Package compare is a client-side run-N-and-compare board (MVP model).
//
// UI shells render Board.Lines(); this package owns sort/filter-free table state.
package compare

import (
	"fmt"
	"sort"
	"strings"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// Run is one bake-off contestant. There is no duration here: no backend reports
// when a session started, and a column of 0s is worse than no column.
type Run struct {
	SessionID string
	Agent     string
	Model     string
	Status    domain.Status
	CostUSD   float64
	Summary   string
}

// Board holds runs for a compare view. ShowCost is the backend's Caps.Cost: a
// board that cannot price a run does not print a price for it.
type Board struct {
	Runs     []Run
	ShowCost bool
}

// Add appends a run (does not de-dupe by SessionID).
func (b *Board) Add(r Run) {
	if b == nil {
		return
	}
	b.Runs = append(b.Runs, r)
}

// SortByCost orders runs ascending by CostUSD (stable for equal cost).
func (b *Board) SortByCost() {
	if b == nil || len(b.Runs) < 2 {
		return
	}
	sort.SliceStable(b.Runs, func(i, j int) bool {
		return b.Runs[i].CostUSD < b.Runs[j].CostUSD
	})
}

// Lines returns a simple table for CLI/TUI display.
func (b *Board) Lines() []string {
	if b == nil || len(b.Runs) == 0 {
		return []string{"(no compare runs)"}
	}
	hSess, hAgent, hModel, hStatus, hCost, hSum :=
		"SESSION", "AGENT", "MODEL", "STATUS", "COST", "SUMMARY"
	wSess, wAgent, wModel, wStatus, wCost, wSum :=
		len(hSess), len(hAgent), len(hModel), len(hStatus), len(hCost), len(hSum)

	type row struct {
		sess, agent, model, status, cost, sum string
	}
	rows := make([]row, 0, len(b.Runs))
	for _, r := range b.Runs {
		sess := dash(r.SessionID)
		agent := dash(r.Agent)
		model := dash(r.Model)
		st := r.Status.Label()
		cost := ""
		if b.ShowCost {
			cost = fmt.Sprintf("$%.4f", r.CostUSD)
		}
		sum := dash(r.Summary)
		rows = append(rows, row{sess, agent, model, st, cost, sum})
		wSess = max(wSess, len(sess))
		wAgent = max(wAgent, len(agent))
		wModel = max(wModel, len(model))
		wStatus = max(wStatus, len(st))
		wCost = max(wCost, len(cost))
		wSum = max(wSum, len(sum))
	}

	line := func(sess, agent, model, status, cost, sum string) string {
		out := fmt.Sprintf("%-*s  %-*s  %-*s  %-*s",
			wSess, sess, wAgent, agent, wModel, model, wStatus, status)
		if b.ShowCost {
			out += fmt.Sprintf("  %*s", wCost, cost)
		}
		return out + fmt.Sprintf("  %-*s", wSum, sum)
	}

	header := line(hSess, hAgent, hModel, hStatus, hCost, hSum)
	out := make([]string, 0, 2+len(rows))
	out = append(out, header, strings.Repeat("-", len(header)))
	for _, r := range rows {
		out = append(out, line(r.sess, r.agent, r.model, r.status, r.cost, r.sum))
	}
	return out
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
