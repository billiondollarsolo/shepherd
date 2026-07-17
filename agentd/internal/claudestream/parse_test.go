package claudestream

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/billiondollarsolo/flock/agentd/internal/acp"
)

// Lines below are trimmed-but-real captures from
// `claude --print --input-format stream-json --output-format stream-json --verbose`.

const initLine = `{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"s1","model":"claude-haiku-4-5-20251001","permissionMode":"default","slash_commands":["compact","context","model","clear"],"tools":["Bash","Write"]}`

func TestParseInit(t *testing.T) {
	info := ParseInit([]byte(initLine))
	if info == nil {
		t.Fatal("expected init info")
	}
	if info.Model != "claude-haiku-4-5-20251001" {
		t.Fatalf("model = %q", info.Model)
	}
	if len(info.SlashCommands) != 4 || info.SlashCommands[0] != "compact" {
		t.Fatalf("slash_commands = %v", info.SlashCommands)
	}
	// Non-init lines return nil.
	if ParseInit([]byte(`{"type":"system","subtype":"thinking_tokens"}`)) != nil {
		t.Fatal("thinking_tokens should not parse as init")
	}
}

func TestParseLine(t *testing.T) {
	cases := []struct {
		name string
		line string
		want []acp.Event
	}{
		{
			"init → session started + model + commands",
			initLine,
			[]acp.Event{
				{Kind: acp.EventSessionStarted},
				{Kind: acp.EventUsageUpdated, Usage: &acp.Usage{Model: "claude-haiku-4-5-20251001"}},
				{Kind: acp.EventCommandsUpdated, Commands: []string{"compact", "context", "model", "clear"}},
			},
		},
		{"thinking_tokens ignored", `{"type":"system","subtype":"thinking_tokens","estimated_tokens":5}`, nil},
		{"hook ignored", `{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}`, nil},
		{"rate_limit ignored", `{"type":"rate_limit_event","rate_limit_info":{}}`, nil},
		{
			"assistant thinking → reasoning delta",
			`{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Let me think"}]}}`,
			[]acp.Event{{Kind: acp.EventContentDelta, StreamKind: "reasoning_text", Text: "Let me think"}},
		},
		{
			"assistant text → assistant delta",
			`{"type":"assistant","message":{"content":[{"type":"text","text":"hello world"}]}}`,
			[]acp.Event{{Kind: acp.EventContentDelta, StreamKind: "assistant_text", Text: "hello world"}},
		},
		{
			"assistant tool_use → tool started (name + id + input)",
			`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01L5","name":"Write","input":{"file_path":"/x/hi.txt","content":"hi"}}]}}`,
			[]acp.Event{{Kind: acp.EventToolStarted, ToolID: "toolu_01L5", ToolName: "Write", ToolInput: json.RawMessage(`{"file_path":"/x/hi.txt","content":"hi"}`)}},
		},
		{
			"user tool_result → tool completed (output + diff)",
			`{"type":"user","message":{"content":[{"tool_use_id":"toolu_01L5","type":"tool_result","content":"File created"}]},"tool_use_result":{"type":"create","filePath":"/x/hi.txt","structuredPatch":[{"oldStart":1,"oldLines":0,"newStart":1,"newLines":1,"lines":["+hi"]}]}}`,
			[]acp.Event{{Kind: acp.EventToolUpdated, ToolID: "toolu_01L5", ToolStatus: "completed", ToolOutput: "File created", ToolDiff: json.RawMessage(`[{"oldStart":1,"oldLines":0,"newStart":1,"newLines":1,"lines":["+hi"]}]`)}},
		},
		{
			"user tool_result is_error → tool error status",
			`{"type":"user","message":{"content":[{"tool_use_id":"toolu_9","type":"tool_result","content":"exit 1","is_error":true}]}}`,
			[]acp.Event{{Kind: acp.EventToolUpdated, ToolID: "toolu_9", ToolStatus: "error", ToolOutput: "exit 1"}},
		},
		{
			"user prompt echo (string content) → nothing",
			`{"type":"user","message":{"content":"hi there"}}`,
			nil,
		},
		{
			"result success → turn completed with usage",
			`{"type":"result","subtype":"success","is_error":false,"result":"Done.","stop_reason":"end_turn","usage":{"input_tokens":18,"output_tokens":171,"cache_read_input_tokens":45994,"cache_creation_input_tokens":3170}}`,
			[]acp.Event{{Kind: acp.EventTurnCompleted, Usage: &acp.Usage{InputTokens: 18 + 45994 + 3170, OutputTokens: 171}}},
		},
		{
			"result error → error event",
			`{"type":"result","subtype":"error","is_error":true,"result":"boom"}`,
			[]acp.Event{{Kind: acp.EventError, Message: "boom"}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseLine([]byte(c.line))
			if len(got) != len(c.want) {
				t.Fatalf("got %d events %+v, want %d %+v", len(got), got, len(c.want), c.want)
			}
			for i := range got {
				a, b := got[i], c.want[i]
				if a.Kind != b.Kind || a.StreamKind != b.StreamKind || a.Text != b.Text ||
					a.ToolID != b.ToolID || a.ToolName != b.ToolName || a.ToolStatus != b.ToolStatus ||
					a.ToolOutput != b.ToolOutput {
					t.Fatalf("[%d] got %+v, want %+v", i, a, b)
				}
				if string(a.ToolInput) != string(b.ToolInput) {
					t.Fatalf("[%d] toolInput got %q, want %q", i, a.ToolInput, b.ToolInput)
				}
				if string(a.ToolDiff) != string(b.ToolDiff) {
					t.Fatalf("[%d] toolDiff got %q, want %q", i, a.ToolDiff, b.ToolDiff)
				}
				if !reflect.DeepEqual(a.Commands, b.Commands) {
					t.Fatalf("[%d] commands got %v, want %v", i, a.Commands, b.Commands)
				}
				if (a.Usage == nil) != (b.Usage == nil) {
					t.Fatalf("[%d] usage nil mismatch: %+v vs %+v", i, a.Usage, b.Usage)
				}
				if a.Usage != nil && (a.Usage.Model != b.Usage.Model ||
					a.Usage.InputTokens != b.Usage.InputTokens || a.Usage.OutputTokens != b.Usage.OutputTokens) {
					t.Fatalf("[%d] usage got %+v, want %+v", i, a.Usage, b.Usage)
				}
			}
		})
	}
}
