package cost

import (
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func TestFromSessionsAndTotal(t *testing.T) {
	c1, c2 := 0.25, 0.75
	var tbl Table
	tbl.FromSessions([]domain.Session{
		{ID: "b", Telemetry: domain.Telemetry{Tokens: 100, CostUSD: &c1}},
		{ID: "a", Telemetry: domain.Telemetry{Tokens: 50, CostUSD: &c2}},
		{ID: "z", Telemetry: domain.Telemetry{Tokens: 0}}, // nil cost
	})
	if len(tbl.Rows) != 3 {
		t.Fatalf("rows = %d", len(tbl.Rows))
	}
	// Sorted by key: a, b, z
	if tbl.Rows[0].Key != "a" || tbl.Rows[1].Key != "b" || tbl.Rows[2].Key != "z" {
		t.Fatalf("order = %#v", tbl.Rows)
	}
	if tbl.Rows[0].CostUSD != 0.75 || tbl.Rows[0].Tokens != 50 {
		t.Fatalf("row a = %#v", tbl.Rows[0])
	}
	if tbl.Rows[2].CostUSD != 0 {
		t.Fatalf("nil cost should be 0, got %v", tbl.Rows[2].CostUSD)
	}
	if tbl.Total() != 1.0 {
		t.Fatalf("total = %v", tbl.Total())
	}
}

func TestLines(t *testing.T) {
	c := 1.2345
	var tbl Table
	tbl.FromSessions([]domain.Session{
		{ID: "sess-1", Telemetry: domain.Telemetry{Tokens: 42, CostUSD: &c}},
	})
	joined := strings.Join(tbl.Lines(), "\n")
	for _, want := range []string{"KEY", "sess-1", "42", "1.2345", "TOTAL"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in:\n%s", want, joined)
		}
	}
}

func TestEmptyLines(t *testing.T) {
	var tbl Table
	lines := tbl.Lines()
	if len(lines) < 2 {
		t.Fatalf("lines = %v", lines)
	}
	if !strings.Contains(lines[0], "no cost") {
		t.Fatalf("want empty notice: %v", lines)
	}
	if tbl.Total() != 0 {
		t.Fatalf("empty total = %v", tbl.Total())
	}
}
