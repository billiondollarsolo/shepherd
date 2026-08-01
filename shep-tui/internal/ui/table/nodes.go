package table

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// NodeRow is one node, one line.
type NodeRow struct {
	NodeID string
	Name   string
	Kind   string
	Host   string
	Status domain.ConnectionStatus
	Pool   string
	Seen   string
}

// NodeCol is a column of the nodes table. The values continue Col's space so a
// Column carries either kind and the layout/padding code stays one code path.
const (
	ColNodeName Col = iota + 100
	ColNodeKind
	ColNodeHost
	ColNodeStatus
	ColNodePool
	ColNodeSeen
)

var nodeColSpec = map[Col]Column{
	ColNodeName:   {Col: ColNodeName, Title: "NAME", Width: 18},
	ColNodeKind:   {Col: ColNodeKind, Title: "KIND", Width: 6},
	ColNodeHost:   {Col: ColNodeHost, Title: "HOST", Width: 22},
	ColNodeStatus: {Col: ColNodeStatus, Title: "STATUS", Width: 12},
	ColNodePool:   {Col: ColNodePool, Title: "POOL", Width: 10},
	ColNodeSeen:   {Col: ColNodeSeen, Title: "SEEN", Width: 5, Right: true},
}

var nodeColOrder = []Col{ColNodeName, ColNodeKind, ColNodeHost, ColNodeStatus, ColNodePool, ColNodeSeen}

// nodeDropOrder is what a narrow terminal gives up, cheapest first. NAME and
// STATUS stay: a node you cannot name or reach is a row that says nothing.
var nodeDropOrder = []Col{ColNodePool, ColNodeSeen, ColNodeHost, ColNodeKind}

// NodeLayout is the node columns that fit in width; NAME takes the slack.
func NodeLayout(width int) []Column {
	return layout(width, nodeColOrder, nodeColSpec, nodeDropOrder, ColNodeName, ColNodeHost)
}

// NodeHeader is the node column heading line.
func NodeHeader(width int) string {
	return headerLine(NodeLayout(width))
}

// Cell is the row's value for a column.
func (r NodeRow) Cell(c Col) string {
	switch c {
	case ColNodeName:
		return r.Name
	case ColNodeKind:
		return r.Kind
	case ColNodeHost:
		return r.Host
	case ColNodeStatus:
		return r.Status.Label()
	case ColNodePool:
		return r.Pool
	case ColNodeSeen:
		return r.Seen
	}
	return ""
}

// NodeModel is the pure nodes-table navigation state: the same cursor/filter
// contract the agents table has, over []domain.Node.
type NodeModel struct {
	nodes  []domain.Node
	filter string
	rows   []NodeRow
	cursor int
}

// BuildNodes constructs a nodes table.
func BuildNodes(nodes []domain.Node) *NodeModel {
	m := &NodeModel{}
	m.Rebuild(nodes)
	return m
}

// Rebuild replaces the node snapshot, keeping the cursor on the same node.
func (m *NodeModel) Rebuild(nodes []domain.Node) {
	prev := m.SelectedNodeID()
	m.nodes = append([]domain.Node(nil), nodes...)
	m.rebuild()
	if prev != "" {
		for i, r := range m.rows {
			if r.NodeID == prev {
				m.cursor = i
				return
			}
		}
	}
	m.cursor = m.clamp(m.cursor)
}

// SetFilter narrows the table to the nodes matching q (name, host or pool).
func (m *NodeModel) SetFilter(q string) {
	prev := m.SelectedNodeID()
	m.filter = q
	m.rebuild()
	if prev != "" {
		for i, r := range m.rows {
			if r.NodeID == prev {
				m.cursor = i
				return
			}
		}
	}
	m.cursor = m.clamp(m.cursor)
}

// Filter is the live query.
func (m *NodeModel) Filter() string { return m.filter }

func (m *NodeModel) rebuild() {
	kept := make([]domain.Node, 0, len(m.nodes))
	for _, n := range m.nodes {
		if nodeMatches(n, m.filter) {
			kept = append(kept, n)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].Label() < kept[j].Label() })
	rows := make([]NodeRow, 0, len(kept))
	now := time.Now()
	for _, n := range kept {
		host := n.Host
		if host != "" && n.SSHUser != "" {
			host = n.SSHUser + "@" + host
		}
		if host != "" && n.Port > 0 {
			host += ":" + strconv.Itoa(n.Port)
		}
		rows = append(rows, NodeRow{
			NodeID: n.ID,
			Name:   n.Label(),
			Kind:   string(n.Kind),
			Host:   host,
			Status: n.ConnectionStatus,
			Pool:   n.Pool,
			Seen:   FormatAge(n.LastSeenAt, now),
		})
	}
	m.rows = rows
}

func nodeMatches(n domain.Node, q string) bool {
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return true
	}
	for _, field := range []string{n.Label(), n.Host, n.Pool, string(n.Kind), n.SSHUser} {
		if field != "" && strings.Contains(strings.ToLower(field), q) {
			return true
		}
	}
	return false
}

// Move steps the cursor by delta rows, clamping at both ends.
func (m *NodeModel) Move(delta int) {
	if len(m.rows) == 0 {
		m.cursor = -1
		return
	}
	m.cursor = m.clamp(m.cursor + delta)
}

// SetCursor parks the cursor on a row.
func (m *NodeModel) SetCursor(i int) { m.cursor = m.clamp(i) }

func (m *NodeModel) clamp(i int) int {
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
func (m *NodeModel) Cursor() int { return m.cursor }

// Len is how many rows the table has.
func (m *NodeModel) Len() int { return len(m.rows) }

// Rows returns a copy of the visible rows.
func (m *NodeModel) Rows() []NodeRow { return append([]NodeRow(nil), m.rows...) }

// Selected returns the row under the cursor.
func (m *NodeModel) Selected() (NodeRow, bool) {
	if m.cursor < 0 || m.cursor >= len(m.rows) {
		return NodeRow{}, false
	}
	return m.rows[m.cursor], true
}

// SelectedNodeID returns the node under the cursor, or "".
func (m *NodeModel) SelectedNodeID() string {
	r, ok := m.Selected()
	if !ok {
		return ""
	}
	return r.NodeID
}
