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

func TestAntigravityLineToChat(t *testing.T) {
	cases := []struct {
		name string
		line string
		want []ChatMsg
	}{
		{
			"user input unwrapped",
			`{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<USER_REQUEST>\nfix the bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>cwd=/x</ADDITIONAL_METADATA>"}`,
			[]ChatMsg{{Role: "user", Text: "fix the bug"}},
		},
		{
			"user input no wrapper",
			`{"source":"USER_EXPLICIT","type":"USER_INPUT","content":"just do it"}`,
			[]ChatMsg{{Role: "user", Text: "just do it"}},
		},
		{
			"planner response",
			`{"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Here is the plan"}`,
			[]ChatMsg{{Role: "assistant", Text: "Here is the plan"}},
		},
		{
			"content object with text",
			`{"source":"MODEL","type":"PLANNER_RESPONSE","content":{"text":"nested"}}`,
			[]ChatMsg{{Role: "assistant", Text: "nested"}},
		},
		{"system history ignored", `{"source":"SYSTEM","type":"CONVERSATION_HISTORY","content":"x"}`, nil},
		{"checkpoint ignored", `{"source":"SYSTEM","type":"CHECKPOINT"}`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := antigravityLineToChat([]byte(c.line))
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

func TestAntigravityLineToUpdate(t *testing.T) {
	cases := []struct {
		name   string
		line   string
		want   string
		wantOK bool
	}{
		{"user input → running", `{"type":"USER_INPUT","source":"USER_EXPLICIT"}`, StateRunning, true},
		{"planner done → idle", `{"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE"}`, StateIdle, true},
		{"planner streaming → running", `{"source":"MODEL","type":"PLANNER_RESPONSE","status":"RUNNING"}`, StateRunning, true},
		{"error status → error", `{"source":"MODEL","type":"PLANNER_RESPONSE","status":"ERROR"}`, StateError, true},
		{"system → no change", `{"source":"SYSTEM","type":"CHECKPOINT"}`, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u, ok := antigravityLineToUpdate([]byte(c.line))
			if ok != c.wantOK {
				t.Fatalf("ok=%v, want %v", ok, c.wantOK)
			}
			if ok && u.State != c.want {
				t.Fatalf("state=%q, want %q", u.State, c.want)
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
