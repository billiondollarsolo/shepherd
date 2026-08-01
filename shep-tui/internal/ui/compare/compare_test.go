package compare

import (
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func TestBoardAddAndLines(t *testing.T) {
	b := Board{ShowCost: true}
	b.Add(Run{
		SessionID: "s1",
		Agent:     "claude-code",
		Model:     "sonnet",
		Status:    domain.StatusDone,
		CostUSD:   0.12,
		Summary:   "ok",
	})
	lines := b.Lines()
	if len(lines) < 3 {
		t.Fatalf("lines = %v", lines)
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"SESSION", "s1", "claude-code", "sonnet", "Done", "0.1200", "ok"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestBoardEmptyLines(t *testing.T) {
	var b Board
	lines := b.Lines()
	if len(lines) != 1 || !strings.Contains(lines[0], "no compare") {
		t.Fatalf("empty lines = %v", lines)
	}
}

func TestSortByCost(t *testing.T) {
	b := Board{Runs: []Run{
		{SessionID: "expensive", CostUSD: 1.5},
		{SessionID: "cheap", CostUSD: 0.1},
		{SessionID: "mid", CostUSD: 0.5},
	}}
	b.SortByCost()
	if b.Runs[0].SessionID != "cheap" || b.Runs[2].SessionID != "expensive" {
		t.Fatalf("order = %#v", b.Runs)
	}
}
