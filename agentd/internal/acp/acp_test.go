package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

func TestLaunchCommand(t *testing.T) {
	cases := map[string][]string{
		"cursor": {"cursor-agent", "acp"},
	}
	for agent, want := range cases {
		got, ok := LaunchCommand(agent)
		if !ok || len(got) != len(want) {
			t.Fatalf("%s: got %v ok=%v", agent, got, ok)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s argv[%d]=%q want %q", agent, i, got[i], want[i])
			}
		}
	}
	if _, ok := LaunchCommand("claude-code"); ok {
		t.Fatal("claude-code must NOT claim ACP (PTY fallback)")
	}
	// Grok's stdio protocol is NOT ACP (ignores initialize) — native PTY only.
	if _, ok := LaunchCommand("grok"); ok {
		t.Fatal("grok must NOT claim ACP (native PTY + hooks)")
	}
	if SupportsACP("terminal") {
		t.Fatal("terminal is not an ACP agent")
	}
}

func TestParseSessionUpdate(t *testing.T) {
	raw := func(s string) json.RawMessage { return json.RawMessage(s) }
	cases := []struct {
		name   string
		params string
		want   func(Event) bool
	}{
		{"assistant chunk", `{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"hi"}}}`,
			func(e Event) bool {
				return e.Kind == EventContentDelta && e.StreamKind == "assistant_text" && e.Text == "hi"
			}},
		{"reasoning chunk", `{"update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"why"}}}`,
			func(e Event) bool { return e.Kind == EventContentDelta && e.StreamKind == "reasoning_text" }},
		{"tool call", `{"update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Run shell"}}`,
			func(e Event) bool { return e.Kind == EventToolStarted && e.ToolID == "t1" && e.ToolName == "Run shell" }},
		{"tool update", `{"update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed"}}`,
			func(e Event) bool { return e.Kind == EventToolUpdated && e.ToolStatus == "completed" }},
		{"plan", `{"update":{"sessionUpdate":"plan","entries":[{"content":"step","status":"in_progress"}]}}`,
			func(e Event) bool {
				return e.Kind == EventPlanUpdated && len(e.Plan) == 1 && e.Plan[0].Status == "in_progress"
			}},
		{"usage", `{"update":{"sessionUpdate":"usage_update","usage":{"totalTokens":42}}}`,
			func(e Event) bool { return e.Kind == EventUsageUpdated && e.Usage != nil && e.Usage.TotalTokens == 42 }},
	}
	for _, c := range cases {
		evs := parseSessionUpdate(raw(c.params))
		if len(evs) != 1 || !c.want(evs[0]) {
			t.Fatalf("%s: got %+v", c.name, evs)
		}
	}
	if evs := parseSessionUpdate(raw(`{"update":{"sessionUpdate":"unknown_kind"}}`)); len(evs) != 0 {
		t.Fatalf("unknown update should yield no events, got %+v", evs)
	}
}

// pipePair wires a Conn to a scripted mock agent over two ndjson pipes.
func pipePair(t *testing.T, h Handlers) (*Conn, *bufio.Reader, io.Writer, context.CancelFunc) {
	t.Helper()
	agentIn, clientOut := io.Pipe() // client → agent stdin
	clientIn, agentOut := io.Pipe() // agent → client stdout
	conn := NewConn(clientIn, clientOut, h)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	go func() { _ = conn.Run(ctx) }()
	return conn, bufio.NewReader(agentIn), agentOut, cancel
}

func writeJSON(w io.Writer, v any) {
	b, _ := json.Marshal(v)
	_, _ = w.Write(append(b, '\n'))
}

func TestClientHandshakeAndStreamedUpdate(t *testing.T) {
	events := make(chan Event, 16)
	conn, agentReqs, agentOut, cancel := pipePair(t, Handlers{OnUpdate: func(e Event) { events <- e }})
	defer cancel()

	// Mock agent: respond to initialize/session.new, and on prompt stream one
	// assistant chunk then resolve the turn.
	go func() {
		for {
			line, err := agentReqs.ReadBytes('\n')
			if len(line) > 0 {
				var m struct {
					ID     json.RawMessage `json:"id"`
					Method string          `json:"method"`
				}
				_ = json.Unmarshal(line, &m)
				switch m.Method {
				case "initialize":
					writeJSON(agentOut, map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"protocolVersion": 1}})
				case "session/new":
					writeJSON(agentOut, map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"sessionId": "sess-1"}})
				case "session/prompt":
					writeJSON(agentOut, map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{
						"sessionId": "sess-1",
						"update":    map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "hello"}},
					}})
					writeJSON(agentOut, map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"stopReason": "end_turn"}})
				}
			}
			if err != nil {
				return
			}
		}
	}()

	ctx := context.Background()
	if err := conn.Initialize(ctx); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	sid, err := conn.NewSession(ctx, "/work", nil)
	if err != nil || sid != "sess-1" {
		t.Fatalf("new session: sid=%q err=%v", sid, err)
	}
	if err := conn.Prompt(ctx, sid, "hi"); err != nil {
		t.Fatalf("prompt: %v", err)
	}
	select {
	case e := <-events:
		if e.Kind != EventContentDelta || e.Text != "hello" {
			t.Fatalf("unexpected event %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no session/update event delivered")
	}
}

func TestPermissionRoundTrip(t *testing.T) {
	// The control-plane foundation (P1): the agent asks, the client answers.
	_, agentReqs, agentOut, cancel := pipePair(t, Handlers{
		OnPermission: func(req PermissionRequest) string {
			if len(req.Options) == 0 {
				return ""
			}
			return req.Options[0].OptionID // approve the first option
		},
	})
	defer cancel()

	got := make(chan string, 1)
	go func() {
		// Send a permission request (id=99), then read the client's response.
		writeJSON(agentOut, map[string]any{"jsonrpc": "2.0", "id": 99, "method": "session/request_permission", "params": map[string]any{
			"toolCall": map[string]any{"title": "Run rm -rf"},
			"options":  []map[string]any{{"optionId": "allow", "name": "Allow", "kind": "allow_once"}},
		}})
		for {
			line, err := agentReqs.ReadBytes('\n')
			if len(line) > 0 {
				var m struct {
					Result struct {
						Outcome struct {
							Outcome  string `json:"outcome"`
							OptionID string `json:"optionId"`
						} `json:"outcome"`
					} `json:"result"`
				}
				if json.Unmarshal(line, &m) == nil && m.Result.Outcome.Outcome != "" {
					got <- m.Result.Outcome.OptionID
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	select {
	case optionID := <-got:
		if optionID != "allow" {
			t.Fatalf("expected the client to select 'allow', got %q", optionID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no permission response from client")
	}
}
