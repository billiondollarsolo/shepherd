// Package claudestream parses Claude Code's stream-json protocol
// (`claude --print --input-format stream-json --output-format stream-json --verbose`)
// into the SAME canonical acp.Event taxonomy the ACP client emits — so the whole
// downstream bridge (status + chat) is reused unchanged. This is the structured
// transport for Claude: unlike transcript tailing, it yields typed tool calls, tool
// results (with diffs), reasoning, usage, turn boundaries, and — from the `init`
// message — the current model and the agent's live slash-command list.
//
// Wire shape (one JSON object per line), from a live capture:
//
//	{"type":"system","subtype":"init","model":"…","slash_commands":[…],"tools":[…]}
//	{"type":"system","subtype":"thinking_tokens", …}                      (skipped)
//	{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"…"}]}}
//	{"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
//	{"type":"assistant","message":{"content":[{"type":"tool_use","id":"…","name":"Write","input":{…}}]}}
//	{"type":"user","message":{"content":[{"tool_use_id":"…","type":"tool_result","content":"…"}]}}
//	{"type":"result","subtype":"success","result":"…","stop_reason":"end_turn","usage":{…}}
package claudestream

import (
	"encoding/json"

	"github.com/billiondollarsolo/flock/agentd/internal/acp"
)

type streamMsg struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	// system/init
	Model         string   `json:"model"`
	SlashCommands []string `json:"slash_commands"`
	// assistant/user carry a nested Anthropic message
	Message json.RawMessage `json:"message"`
	// A user line carrying a tool_result also carries a TOP-LEVEL tool_use_result
	// (sibling of "message") with the structured diff — note it is NOT inside the
	// content block.
	ToolUseResult *toolUseResult `json:"tool_use_result"`
	// result (turn end)
	Result     string       `json:"result"`
	StopReason string       `json:"stop_reason"`
	IsError    bool         `json:"is_error"`
	Usage      *resultUsage `json:"usage"`
}

type resultUsage struct {
	InputTokens       int64 `json:"input_tokens"`
	OutputTokens      int64 `json:"output_tokens"`
	CacheReadTokens   int64 `json:"cache_read_input_tokens"`
	CacheCreateTokens int64 `json:"cache_creation_input_tokens"`
}

// toolUseResult is the TOP-LEVEL sibling of "message" on a user line that carries
// a tool_result. Only the structuredPatch (Claude's unified-diff hunks) is
// forwarded; other fields (type/filePath/…) are ignored (tolerant).
type toolUseResult struct {
	StructuredPatch json.RawMessage `json:"structuredPatch"`
}

type innerMessage struct {
	Content json.RawMessage `json:"content"`
}

type contentBlock struct {
	Type     string `json:"type"` // text | thinking | tool_use | tool_result
	Text     string `json:"text"`
	Thinking string `json:"thinking"`
	// tool_use
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
	// tool_result
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`  // string, or an array of content blocks
	IsError   bool            `json:"is_error"` // a failed tool (non-zero exit / write error)
}

// InitInfo is the session metadata Claude reports once at start-up. Exposed so the
// driver can forward the CURRENT model and the DYNAMIC slash-command list to the
// orchestrator (both are otherwise unavailable for Claude — the CLI enumerates
// neither).
type InitInfo struct {
	Model         string
	SlashCommands []string
}

// ParseInit returns the init metadata if b is the `system/init` line, else nil.
func ParseInit(b []byte) *InitInfo {
	var m streamMsg
	if json.Unmarshal(b, &m) != nil || m.Type != "system" || m.Subtype != "init" {
		return nil
	}
	return &InitInfo{Model: m.Model, SlashCommands: m.SlashCommands}
}

// ParseLine maps one stream-json line to zero-or-more canonical events. Tolerant:
// unknown/aux lines (hooks, thinking_tokens, rate_limit_event) yield nothing.
func ParseLine(b []byte) []acp.Event {
	var m streamMsg
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	switch m.Type {
	case "system":
		if m.Subtype == "init" {
			out := []acp.Event{{Kind: acp.EventSessionStarted}}
			if m.Model != "" {
				out = append(out, acp.Event{Kind: acp.EventUsageUpdated, Usage: &acp.Usage{Model: m.Model}})
			}
			// Forward Claude's DYNAMIC slash-command list (the CLI enumerates it only
			// here) so the composer can offer the real menu.
			if len(m.SlashCommands) > 0 {
				out = append(out, acp.Event{Kind: acp.EventCommandsUpdated, Commands: m.SlashCommands})
			}
			return out
		}
		return nil // hook_started/hook_response/thinking_tokens/etc.
	case "assistant", "user":
		return blocksToEvents(m.Message, m.ToolUseResult)
	case "result":
		if m.IsError {
			msg := m.Result
			if msg == "" {
				msg = "agent error"
			}
			return []acp.Event{{Kind: acp.EventError, Message: msg}}
		}
		ev := acp.Event{Kind: acp.EventTurnCompleted}
		if m.Usage != nil {
			ev.Usage = &acp.Usage{
				InputTokens:  m.Usage.InputTokens + m.Usage.CacheReadTokens + m.Usage.CacheCreateTokens,
				OutputTokens: m.Usage.OutputTokens,
			}
		}
		return []acp.Event{ev}
	default:
		return nil // rate_limit_event, etc.
	}
}

// blocksToEvents turns an assistant/user message's content blocks into events.
// Assistant messages carry text / thinking / tool_use; user messages carry
// tool_result blocks (a completed tool call) or a plain-string prompt echo (skipped).
func blocksToEvents(raw json.RawMessage, tur *toolUseResult) []acp.Event {
	var msg innerMessage
	if json.Unmarshal(raw, &msg) != nil {
		return nil
	}
	var blocks []contentBlock
	if json.Unmarshal(msg.Content, &blocks) != nil {
		return nil // user content may be a plain string (prompt echo) — no events
	}
	var out []acp.Event
	for _, blk := range blocks {
		switch blk.Type {
		case "text":
			if blk.Text != "" {
				out = append(out, acp.Event{Kind: acp.EventContentDelta, StreamKind: "assistant_text", Text: blk.Text})
			}
		case "thinking":
			if blk.Thinking != "" {
				out = append(out, acp.Event{Kind: acp.EventContentDelta, StreamKind: "reasoning_text", Text: blk.Thinking})
			}
		case "tool_use":
			out = append(out, acp.Event{
				Kind:      acp.EventToolStarted,
				ToolID:    blk.ID,
				ToolName:  blk.Name,
				ToolInput: blk.Input,
			})
		case "tool_result":
			// Honor Claude's is_error so a FAILED tool renders as an error, not a green
			// success check.
			toolStatus := "completed"
			if blk.IsError {
				toolStatus = "error"
			}
			ev := acp.Event{
				Kind:       acp.EventToolUpdated,
				ToolID:     blk.ToolUseID,
				ToolStatus: toolStatus,
				ToolOutput: toolResultText(blk.Content),
			}
			// The structured diff rides on the TOP-LEVEL tool_use_result (sibling of
			// "message"), not in the content block.
			if tur != nil {
				ev.ToolDiff = tur.StructuredPatch
			}
			out = append(out, ev)
		}
	}
	return out
}

// toolResultText renders a tool_result's `content` (a JSON string, or an array of
// content blocks) into plain text.
func toolResultText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []contentBlock
	if json.Unmarshal(raw, &blocks) == nil {
		var b []byte
		for _, blk := range blocks {
			if blk.Type == "text" && blk.Text != "" {
				if len(b) > 0 {
					b = append(b, '\n')
				}
				b = append(b, blk.Text...)
			}
		}
		return string(b)
	}
	return ""
}
