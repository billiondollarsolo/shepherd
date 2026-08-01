package domain

import "time"

// NodeKind is local vs ssh (Flock NodeKindEnum).
type NodeKind string

const (
	NodeLocal NodeKind = "local"
	NodeSSH   NodeKind = "ssh"
)

// AgentType is a first-class or generic agent.
type AgentType string

const (
	AgentClaudeCode AgentType = "claude-code"
	AgentCodex      AgentType = "codex"
	AgentOpenCode   AgentType = "opencode"
	AgentGemini     AgentType = "gemini"
	AgentGrok       AgentType = "grok"
	AgentGeneric    AgentType = "generic"
)

// ConnectionStatus is a node's link state (Flock ConnectionStatusEnum).
type ConnectionStatus string

const (
	NodeConnected    ConnectionStatus = "connected"
	NodeConnecting   ConnectionStatus = "connecting"
	NodeDisconnected ConnectionStatus = "disconnected"
	NodeErrored      ConnectionStatus = "error"
)

// Label is the connection status as a table cell.
func (c ConnectionStatus) Label() string {
	if c == "" {
		return string(NodeDisconnected)
	}
	return string(c)
}

// Node is an execution host.
type Node struct {
	ID               string
	Name             string
	Kind             NodeKind
	Host             string
	Port             int
	SSHUser          string
	Pool             string
	ConnectionStatus ConnectionStatus
	LastSeenAt       time.Time
}

// Online reports that the node is reachable right now.
func (n Node) Online() bool { return n.ConnectionStatus == NodeConnected }

// Label is the node's display name, falling back to its id.
func (n Node) Label() string {
	if n.Name != "" {
		return n.Name
	}
	return n.ID
}

// Project is a workdir grouping on a node.
type Project struct {
	ID     string
	NodeID string
	Name   string
	Cwd    string
}

// Telemetry is per-session live metrics (subset of Flock status frames).
type Telemetry struct {
	Model         string
	Tool          string
	Tokens        int
	ContextTokens int
	ContextLimit  int
	CostUSD       *float64
	PlanJSON      string
}

// Session is the atomic unit: one agent instance.
type Session struct {
	ID        string
	NodeID    string
	ProjectID string
	Name      string
	AgentType AgentType
	Status    Status
	Cwd       string
	Telemetry Telemetry
	UpdatedAt time.Time
}

// PenLayout is a pen geometry preset (web pens: cols/rows/2×2).
type PenLayout string

const (
	PenLayoutCols      PenLayout = "cols"
	PenLayoutRows      PenLayout = "rows"
	PenLayoutGrid2x2   PenLayout = "grid2x2"
	PenLayoutMainStack PenLayout = "main+stack"
)

// Pen is a named group of 1–4 sessions with a layout.
type Pen struct {
	ID         string
	ProjectID  string
	Name       string
	Layout     PenLayout
	SessionIDs []string // max 4
}

// MaxPenSessions is the hard cap matching web Flock pens.
const MaxPenSessions = 4

// Short is the agent's display label, and the name a session falls back to when
// it has none. Mirrors the web paddock's AGENT_SHORT.
func (a AgentType) Short() string {
	switch a {
	case AgentClaudeCode:
		return "Claude"
	case AgentCodex:
		return "Codex"
	case AgentOpenCode:
		return "OpenCode"
	case AgentGemini:
		return "Gemini"
	case AgentGrok:
		return "Grok"
	case AgentGeneric, "":
		return "Agent"
	default:
		return string(a)
	}
}

// ShortID is the readable head of a session id. Six characters, as the web
// paddock shows — enough to tell sessions apart, short enough to sit beside a
// name without crowding it out.
func ShortID(id string) string {
	if len(id) <= shortIDLen {
		return id
	}
	return id[:shortIDLen]
}

const shortIDLen = 6

// Label is how a session is named in a list: its name, or the agent it runs.
func (s Session) Label() string {
	if s.Name != "" {
		return s.Name
	}
	return s.AgentType.Short()
}
