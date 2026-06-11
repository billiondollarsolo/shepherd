package status

import "testing"

func TestClaudeLineToChat(t *testing.T) {
	cases := []struct {
		name string
		line string
		want []ChatMsg
	}{
		{
			"assistant text",
			`{"type":"assistant","message":{"content":[{"type":"text","text":"Hello there"}]}}`,
			[]ChatMsg{{Role: "assistant", Text: "Hello there"}},
		},
		{
			"assistant text + tool",
			`{"type":"assistant","message":{"content":[{"type":"text","text":"Editing"},{"type":"tool_use","name":"Edit","input":{"file_path":"/a/b.ts"}}]}}`,
			[]ChatMsg{{Role: "assistant", Text: "Editing"}, {Role: "tool", Text: "Edit b.ts"}},
		},
		{
			"user prompt (string content)",
			`{"type":"user","message":{"content":"fix the bug"}}`,
			[]ChatMsg{{Role: "user", Text: "fix the bug"}},
		},
		{
			"user prompt (array content)",
			`{"type":"user","message":{"content":[{"type":"text","text":"fix it"}]}}`,
			[]ChatMsg{{Role: "user", Text: "fix it"}},
		},
		{
			"tool_result is not a user prompt",
			`{"type":"user","message":{"content":[{"type":"tool_result","content":"output"}]}}`,
			nil,
		},
		{"system line ignored", `{"type":"system"}`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := claudeLineToChat([]byte(c.line))
			if len(got) != len(c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("[%d] got %+v, want %+v", i, got[i], c.want[i])
				}
			}
		})
	}
}

func TestCodexLineToChat(t *testing.T) {
	cases := []struct {
		name string
		line string
		want []ChatMsg
	}{
		{
			"agent_message",
			`{"type":"event_msg","payload":{"type":"agent_message","message":"done"}}`,
			[]ChatMsg{{Role: "assistant", Text: "done"}},
		},
		{
			"user_message",
			`{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}`,
			[]ChatMsg{{Role: "user", Text: "hi"}},
		},
		{
			"non-message event ignored",
			`{"type":"event_msg","payload":{"type":"task_started"}}`,
			nil,
		},
		{"non event_msg ignored", `{"type":"turn_context","payload":{}}`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := codexLineToChat([]byte(c.line))
			if len(got) != len(c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("[%d] got %+v, want %+v", i, got[i], c.want[i])
				}
			}
		})
	}
}
