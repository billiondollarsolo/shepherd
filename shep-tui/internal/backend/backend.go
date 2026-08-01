// Package backend defines the dual-mode transport surface (local agentd / fleet).
package backend

import (
	"context"
	"errors"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// ErrNotSupported is returned when a Backend method is not available
// (e.g. fleet backend before session create is wired).
var ErrNotSupported = errors.New("not supported by this backend")

// StatusUpdate is a live status/telemetry change for one session.
type StatusUpdate struct {
	SessionID string
	Status    domain.Status
	Telemetry domain.Telemetry
}

// PtyStream is a bidirectional PTY attachment.
type PtyStream interface {
	// Read channel of output chunks (closes when stream ends).
	Output() <-chan []byte
	Write(p []byte) (int, error)
	Resize(cols, rows uint16) error
	Close() error
}

// Backend is the UI-facing interface; fleet and local implement it.
type Backend interface {
	// Close tears down connections.
	Close() error

	// ListSessions returns currently known sessions (tree may expand later).
	ListSessions(ctx context.Context) ([]domain.Session, error)

	// WatchStatus streams status updates until ctx is done.
	WatchStatus(ctx context.Context) (<-chan StatusUpdate, error)

	// OpenPty attaches to sessionID at the given size.
	OpenPty(ctx context.Context, sessionID string, cols, rows uint16) (PtyStream, error)

	// CreateShell opens (or re-opens) a shell session with the given id.
	// cwd may be empty — the implementation chooses a default (home or getwd).
	// cols/rows may be 0 — implementations apply a sensible default size.
	// Fleet may return ErrNotSupported until session create is wired.
	CreateShell(ctx context.Context, id, cwd string, cols, rows uint16) error

	// LaunchAgent opens an agent (or shell) session with an explicit command.
	// kind is typically "agent" or "shell". Fleet may return ErrNotSupported.
	LaunchAgent(ctx context.Context, id, kind, cwd string, command []string, cols, rows uint16) error

	// CloseSession asks the backend to tear down the session by id.
	// Fleet may return ErrNotSupported until session close is wired.
	CloseSession(ctx context.Context, id string) error

	// ListAudit returns orchestrator audit log entries when supported.
	// Local agentd and fleet stubs return ErrNotSupported.
	ListAudit(ctx context.Context) ([]AuditEntry, error)

	// ListNodes returns the execution hosts this backend runs sessions on.
	// A local agentd is one node — itself.
	ListNodes(ctx context.Context) ([]domain.Node, error)

	// CreateNode registers a node with the orchestrator (fleet only).
	// Local agentd returns ErrNotSupported: it cannot register anything.
	CreateNode(ctx context.Context, spec NodeSpec) (domain.Node, error)

	// Capabilities reports what this connection supports.
	Capabilities() Caps
}

// NodeSpec is a node registration (POST /api/nodes). The credentials are carried
// to the transport and no further: nothing here is stored, logged or echoed back.
type NodeSpec struct {
	Name          string
	Kind          domain.NodeKind
	Host          string
	Port          int
	SSHUser       string
	SSHAuthMethod string // "key" | "password"; empty = key
	SSHPrivateKey string
	SSHPassphrase string
	SSHPassword   string
	Pool          string
}

// Secrets are the values of spec that may never reach a log, a toast or the
// screen. Callers scrub them out of anything they render.
func (s NodeSpec) Secrets() []string {
	var out []string
	for _, v := range []string{s.SSHPrivateKey, s.SSHPassphrase, s.SSHPassword} {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

// AuditEntry is a transport-level audit log row (fleet API / fixtures).
type AuditEntry struct {
	Time   string // RFC3339 when known; empty if omitted
	Action string
	Actor  string
	Target string
	Detail string
}

// Caps is feature detection for the UI. Every field here gates a surface: a flag
// nothing reads is a claim nothing keeps.
type Caps struct {
	Mode string // "local" | "fleet"
	// MultiNode gates the nodes surface (list + add node).
	MultiNode bool
	// Launch gates every surface that creates a session: launch agent, spawn shell.
	Launch bool
	// Git, Files, Chat, StructuredChat, Handoff gate the session actions of the
	// same names.
	Git            bool
	Files          bool
	Handoff        bool
	Chat           bool
	StructuredChat bool
	// ShellDrawer gates the secondary shell PTY (needs CreateShell).
	ShellDrawer bool
	// Audit gates the audit log surface (ListAudit).
	Audit bool
	// Cost gates the cost table and the COST column: false means the backend
	// cannot report a cost, and the UI prints no cost at all.
	Cost bool
	// AgentControl gates sessions explain/prompt and server-side wait (agentd
	// agent_control_v1 / screendetect_v1). Local agentd advertises after hello.
	AgentControl bool
}

// AgentController is an optional extension for agentd control ops (H2.4).
// Type-assert from Backend; fleet may return ErrNotSupported.
type AgentController interface {
	// SessionPrompt submits text+Enter via session.prompt when capable.
	SessionPrompt(ctx context.Context, sessionID, text string) error
	// SessionExplain returns statusExplain JSON for the session.
	SessionExplain(ctx context.Context, sessionID string) (map[string]any, error)
	// SessionWaitStatus blocks until status matches until (server-side when capable).
	SessionWaitStatus(ctx context.Context, sessionID string, until []string, timeout time.Duration) (state string, err error)
	// HasAgentControl reports whether agent_control_v1 (or equivalent) is available.
	HasAgentControl() bool
}
