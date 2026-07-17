package acp

import "encoding/json"

// EventKind mirrors the shared canonical taxonomy (packages/shared agentEvents.ts,
// roadmap F5). The orchestrator projects these onto the unified Status.
type EventKind string

const (
	EventSessionStarted  EventKind = "session.started"
	EventSessionEnded    EventKind = "session.ended"
	EventTurnStarted     EventKind = "turn.started"
	EventTurnCompleted   EventKind = "turn.completed"
	EventContentDelta    EventKind = "content.delta"
	EventToolStarted     EventKind = "tool.started"
	EventToolUpdated     EventKind = "tool.updated"
	EventPlanUpdated     EventKind = "plan.updated"
	EventUsageUpdated    EventKind = "usage.updated"
	EventCommandsUpdated EventKind = "commands.updated"
	EventError           EventKind = "error"
)

// PlanItem is one entry of a plan/tasks update.
type PlanItem struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

// Usage is a token-usage snapshot.
type Usage struct {
	InputTokens   int64  `json:"inputTokens,omitempty"`
	OutputTokens  int64  `json:"outputTokens,omitempty"`
	TotalTokens   int64  `json:"totalTokens,omitempty"`
	ContextWindow int64  `json:"contextWindow,omitempty"`
	Model         string `json:"model,omitempty"`
}

// Event is a canonical runtime event derived from an ACP session/update. A flat
// struct (consumers switch on Kind) — friendlier in Go than a union.
type Event struct {
	Kind       EventKind
	StreamKind string // content.delta: assistant_text | reasoning_text | user_text
	Text       string // content.delta
	ToolID     string // tool.*
	ToolName   string // tool.started (title/kind)
	ToolStatus string // tool.updated: pending|in_progress|completed|failed
	// Structured tool detail (populated by the claude-stream transport; the ACP
	// path leaves these empty — its tool calls are name-only).
	ToolInput  json.RawMessage // tool.started: the tool's args object (e.g. {file_path,content} or {command})
	ToolOutput string          // tool.updated: the tool_result content as text
	ToolDiff   json.RawMessage // tool.updated: Claude's structuredPatch (unified-diff hunks)
	Commands   []string        // commands.updated: the agent's live slash-command list
	Plan       []PlanItem
	Usage      *Usage
	Message    string // error
}

// acpUpdate is the tolerant shape of a `session/update` params object across ACP
// agents (extra fields are ignored; missing fields default).
type acpUpdate struct {
	Update struct {
		SessionUpdate string `json:"sessionUpdate"`
		Content       struct {
			Text string `json:"text"`
		} `json:"content"`
		ToolCallID string     `json:"toolCallId"`
		Title      string     `json:"title"`
		Kind       string     `json:"kind"`
		Status     string     `json:"status"`
		Entries    []PlanItem `json:"entries"`
		Usage      *Usage     `json:"usage"`
	} `json:"update"`
}

// parseSessionUpdate maps one ACP `session/update` into zero-or-one canonical
// events. Unknown update kinds yield nothing (tolerant).
func parseSessionUpdate(params json.RawMessage) []Event {
	var p acpUpdate
	if json.Unmarshal(params, &p) != nil {
		return nil
	}
	u := p.Update
	switch u.SessionUpdate {
	case "agent_message_chunk":
		return []Event{{Kind: EventContentDelta, StreamKind: "assistant_text", Text: u.Content.Text}}
	case "agent_thought_chunk":
		return []Event{{Kind: EventContentDelta, StreamKind: "reasoning_text", Text: u.Content.Text}}
	case "user_message_chunk":
		return []Event{{Kind: EventContentDelta, StreamKind: "user_text", Text: u.Content.Text}}
	case "tool_call":
		name := u.Title
		if name == "" {
			name = u.Kind
		}
		return []Event{{Kind: EventToolStarted, ToolID: u.ToolCallID, ToolName: name}}
	case "tool_call_update":
		return []Event{{Kind: EventToolUpdated, ToolID: u.ToolCallID, ToolStatus: u.Status}}
	case "plan":
		return []Event{{Kind: EventPlanUpdated, Plan: u.Entries}}
	case "usage_update":
		return []Event{{Kind: EventUsageUpdated, Usage: u.Usage}}
	default:
		return nil
	}
}

// PermissionOption is one allow/deny choice the agent offers.
type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

// PermissionRequest is a parsed `session/request_permission`.
type PermissionRequest struct {
	Title   string
	Options []PermissionOption
}

func parsePermissionRequest(params json.RawMessage) PermissionRequest {
	var p struct {
		ToolCall struct {
			Title string `json:"title"`
		} `json:"toolCall"`
		Options []PermissionOption `json:"options"`
	}
	_ = json.Unmarshal(params, &p)
	return PermissionRequest{Title: p.ToolCall.Title, Options: p.Options}
}
