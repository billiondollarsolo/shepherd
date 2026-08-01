package table

import (
	"strings"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func testNodeSet() []domain.Node {
	return []domain.Node{
		{ID: "n2", Name: "beta", Kind: domain.NodeSSH, Host: "10.0.0.2", Port: 2222,
			SSHUser: "mj", Pool: "gpu", ConnectionStatus: domain.NodeConnected,
			LastSeenAt: time.Now().Add(-2 * time.Minute)},
		{ID: "n1", Name: "alpha", Kind: domain.NodeLocal, ConnectionStatus: domain.NodeDisconnected},
	}
}

func TestNodeRowsAreNamedSortedAndAddressed(t *testing.T) {
	m := BuildNodes(testNodeSet())
	if m.Len() != 2 {
		t.Fatalf("len = %d", m.Len())
	}
	rows := m.Rows()
	if rows[0].Name != "alpha" || rows[1].Name != "beta" {
		t.Fatalf("rows out of order: %+v", rows)
	}
	if rows[1].Host != "mj@10.0.0.2:2222" {
		t.Fatalf("host cell = %q", rows[1].Host)
	}
	if rows[0].Cell(ColNodeStatus) != "disconnected" || rows[0].Seen != "-" {
		t.Fatalf("row = %+v", rows[0])
	}
	if rows[1].Seen != "2m" {
		t.Fatalf("seen = %q", rows[1].Seen)
	}
}

func TestNodeCursorSurvivesARebuild(t *testing.T) {
	m := BuildNodes(testNodeSet())
	m.SetCursor(1)
	if m.SelectedNodeID() != "n2" {
		t.Fatalf("selected = %q", m.SelectedNodeID())
	}
	m.Rebuild(append(testNodeSet(), domain.Node{ID: "n3", Name: "aaa"}))
	if m.SelectedNodeID() != "n2" {
		t.Fatalf("the cursor moved off the node under it: %q", m.SelectedNodeID())
	}
	m.SetFilter("gpu")
	if m.Len() != 1 || m.SelectedNodeID() != "n2" {
		t.Fatalf("filter: len=%d selected=%q", m.Len(), m.SelectedNodeID())
	}
	m.SetFilter("")
	if m.Len() != 3 {
		t.Fatalf("len after clearing the filter = %d", m.Len())
	}
}

// A narrow terminal gives up the cheap columns; it never gives up the name or
// the status, and the columns always fill the box.
func TestNodeLayoutFitsAndKeepsNameAndStatus(t *testing.T) {
	for _, w := range []int{20, 40, 80, 200} {
		cols := NodeLayout(w)
		total := 0
		for i, c := range cols {
			total += c.Width
			if i > 0 {
				total += colGap
			}
		}
		if w >= 30 && total != w {
			t.Errorf("width %d: columns total %d", w, total)
		}
		names := map[Col]bool{}
		for _, c := range cols {
			names[c.Col] = true
		}
		if !names[ColNodeName] || !names[ColNodeStatus] {
			t.Errorf("width %d dropped NAME or STATUS", w)
		}
		if got := len(strings.Split(NodeHeader(w), "\n")); got != 1 {
			t.Errorf("header wrapped into %d lines", got)
		}
	}
}
