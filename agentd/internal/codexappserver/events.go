package codexappserver

import (
	"encoding/json"

	"github.com/billiondollarsolo/flock/agentd/internal/acp"
)

// events.go — the pure mapping from Codex app-server streaming notifications onto the
// canonical acp.Event taxonomy (internal/acp/events.go). Reusing that taxonomy is the
// whole point: the session driver feeds these events straight into renderACPEvent, so
// Codex tool cards + chat + status flow through the EXACT downstream pipeline already
// built for Claude/ACP — nothing new is invented on the render side.
//
// Only the notifications we act on are mapped; every other method (and every unknown
// item type) yields nothing — the parser is deliberately tolerant, per the protocol's
// large, evolving surface. Authoritative shapes: codex-schema/v2/{ItemStarted,
// ItemCompleted,TurnCompleted}Notification.json and the ThreadItem union.

// codexItem is the tolerant shape of a ThreadItem (only the fields we render). The
// discriminator is `type`; the rest are read per-variant.
type codexItem struct {
	ID   string `json:"id"`
	Type string `json:"type"` // agentMessage | reasoning | commandExecution | fileChange | mcpToolCall | …

	// agentMessage
	Text string `json:"text"`

	// reasoning
	Summary json.RawMessage `json:"summary"`
	Content json.RawMessage `json:"content"`

	// commandExecution
	Command          string `json:"command"`
	AggregatedOutput string `json:"aggregatedOutput"`
	ExitCode         *int   `json:"exitCode"`

	// fileChange
	Changes json.RawMessage `json:"changes"` // []FileUpdateChange{path,kind,diff}

	// mcpToolCall / dynamicToolCall
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`

	// commandExecution | fileChange | mcpToolCall all carry a status enum.
	Status string `json:"status"` // inProgress | completed | failed | declined
}

// itemNotification is the {item,threadId,turnId,…} envelope shared by item/started
// and item/completed.
type itemNotification struct {
	Item codexItem `json:"item"`
}

// CodexItemToEvents maps ONE server notification to zero-or-more canonical events.
//
//   - item/started for a TOOL item (command exec / file change / mcp tool) →
//     EventToolStarted (ToolName + ToolInput = the command/args).
//   - item/completed for a TOOL item → EventToolUpdated (mapped status, ToolOutput /
//     ToolDiff).
//   - item/completed for an agentMessage → EventContentDelta assistant_text (the
//     whole message; renderACPEvent accumulates then flushes on a tool/turn boundary).
//   - item/completed for a reasoning item → EventContentDelta reasoning_text.
//   - turn/completed → EventTurnCompleted (back to idle).
//
// Assistant/reasoning items are emitted only on COMPLETED (their started frame has no
// text yet); tool items emit on BOTH so the card appears immediately and updates when
// it finishes. Everything else yields nil.
func CodexItemToEvents(method string, params json.RawMessage) []acp.Event {
	switch method {
	case "item/started":
		var n itemNotification
		if json.Unmarshal(params, &n) != nil {
			return nil
		}
		return codexToolStarted(n.Item)
	case "item/completed":
		var n itemNotification
		if json.Unmarshal(params, &n) != nil {
			return nil
		}
		return codexItemCompleted(n.Item)
	case "turn/completed":
		return []acp.Event{{Kind: acp.EventTurnCompleted}}
	case "error":
		// Turn-level failure (ErrorNotification: {error: TurnError, ...}). Without this
		// the failure is swallowed and the session never returns to idle. Tolerant about
		// the message location (error.message, or error as a bare string).
		return []acp.Event{{Kind: acp.EventError, Message: codexErrorMessage(params)}}
	default:
		return nil
	}
}

// codexErrorMessage tolerantly extracts a human message from an `error` notification.
func codexErrorMessage(params json.RawMessage) string {
	var withMsg struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(params, &withMsg) == nil && withMsg.Error.Message != "" {
		return withMsg.Error.Message
	}
	var asString struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(params, &asString) == nil && asString.Error != "" {
		return asString.Error
	}
	return "codex turn error"
}

// codexToolStarted emits an EventToolStarted for a tool item; non-tool items (agent
// message, reasoning, plan, …) yield nothing on start.
func codexToolStarted(it codexItem) []acp.Event {
	name, input := codexToolNameAndInput(it)
	if name == "" {
		return nil
	}
	return []acp.Event{{Kind: acp.EventToolStarted, ToolID: it.ID, ToolName: name, ToolInput: input}}
}

// codexItemCompleted emits the terminal event for a completed item.
func codexItemCompleted(it codexItem) []acp.Event {
	switch it.Type {
	case "agentMessage":
		if it.Text == "" {
			return nil
		}
		return []acp.Event{{Kind: acp.EventContentDelta, StreamKind: "assistant_text", Text: it.Text}}
	case "reasoning":
		if text := codexReasoningText(it); text != "" {
			return []acp.Event{{Kind: acp.EventContentDelta, StreamKind: "reasoning_text", Text: text}}
		}
		return nil
	case "commandExecution":
		return []acp.Event{{
			Kind:       acp.EventToolUpdated,
			ToolID:     it.ID,
			ToolStatus: codexToolStatus(it.Status),
			ToolOutput: it.AggregatedOutput,
		}}
	case "fileChange":
		ev := acp.Event{Kind: acp.EventToolUpdated, ToolID: it.ID, ToolStatus: codexToolStatus(it.Status)}
		if len(it.Changes) > 0 {
			ev.ToolDiff = it.Changes
		}
		return []acp.Event{ev}
	case "mcpToolCall", "dynamicToolCall":
		return []acp.Event{{Kind: acp.EventToolUpdated, ToolID: it.ID, ToolStatus: codexToolStatus(it.Status)}}
	default:
		return nil
	}
}

// codexToolNameAndInput returns a display name + structured input for a tool item, or
// ("",nil) for a non-tool item. The input is a small JSON object the web renders as the
// tool card's args (capped downstream by renderACPEvent).
func codexToolNameAndInput(it codexItem) (string, json.RawMessage) {
	switch it.Type {
	case "commandExecution":
		return "shell", mustJSON(map[string]any{"command": it.Command})
	case "fileChange":
		if len(it.Changes) > 0 {
			return "apply_patch", mustJSON(map[string]json.RawMessage{"changes": it.Changes})
		}
		return "apply_patch", nil
	case "mcpToolCall", "dynamicToolCall":
		name := it.Tool
		if name == "" {
			name = "tool"
		}
		return name, it.Arguments
	default:
		return "", nil
	}
}

// codexToolStatus maps a Codex item status enum onto the canonical tool status the
// ACP bridge expects (pending|in_progress|completed|failed).
func codexToolStatus(s string) string {
	switch s {
	case "inProgress":
		return "in_progress"
	case "completed":
		return "completed"
	case "failed", "declined":
		return "failed"
	default:
		return s
	}
}

// codexReasoningText pulls displayable text out of a reasoning item's summary or
// content (each an array of {text} parts). Tolerant: returns "" when nothing is found.
func codexReasoningText(it codexItem) string {
	if t := textParts(it.Summary); t != "" {
		return t
	}
	return textParts(it.Content)
}

// textParts concatenates the `text` fields of a raw JSON array of {text} objects
// (or a bare string). Returns "" for anything else.
func textParts(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	out := ""
	for _, p := range parts {
		out += p.Text
	}
	return out
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}
