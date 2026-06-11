package session

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sync"
	"testing"
	"time"

	"flock-agentd/internal/acp"
	"flock-agentd/internal/status"
)

func TestAcpEventToUpdate(t *testing.T) {
	cases := []struct {
		name string
		ev   acp.Event
		want status.Update
		ok   bool
	}{
		{"content delta → running", acp.Event{Kind: acp.EventContentDelta, Text: "hi"}, status.Update{State: status.StateRunning}, true},
		{"tool started → running + tool", acp.Event{Kind: acp.EventToolStarted, ToolName: "Run shell"}, status.Update{State: status.StateRunning, Tool: "Run shell"}, true},
		{"tool failed → error", acp.Event{Kind: acp.EventToolUpdated, ToolStatus: "failed"}, status.Update{State: status.StateError}, true},
		{"tool completed → no update", acp.Event{Kind: acp.EventToolUpdated, ToolStatus: "completed"}, status.Update{}, false},
		{"turn complete → idle", acp.Event{Kind: acp.EventTurnCompleted}, status.Update{State: status.StateIdle}, true},
		{"error → error", acp.Event{Kind: acp.EventError, Message: "boom"}, status.Update{State: status.StateError}, true},
		{"usage → tokens/model/ctx", acp.Event{Kind: acp.EventUsageUpdated, Usage: &acp.Usage{TotalTokens: 100, InputTokens: 40, Model: "gemini-2"}}, status.Update{Tokens: 100, Model: "gemini-2", ContextTokens: 40}, true},
	}
	for _, c := range cases {
		got, ok := acpEventToUpdate(c.ev)
		if ok != c.ok || got != c.want {
			t.Fatalf("%s: got %+v ok=%v, want %+v ok=%v", c.name, got, ok, c.want, c.ok)
		}
	}
	// plan marshals to [{content,status}]
	u, ok := acpEventToUpdate(acp.Event{Kind: acp.EventPlanUpdated, Plan: []acp.PlanItem{{Content: "step", Status: "in_progress"}}})
	if !ok || u.Plan != `[{"content":"step","status":"in_progress"}]` {
		t.Fatalf("plan: %q ok=%v", u.Plan, ok)
	}
}

func TestNewACPHandlersPermission(t *testing.T) {
	var mu sync.Mutex
	var states []string
	push := func(u status.Update) {
		if u.State != "" {
			mu.Lock()
			states = append(states, u.State)
			mu.Unlock()
		}
	}
	h := newACPHandlers(push, func(req acp.PermissionRequest) string {
		if len(req.Options) > 0 {
			return req.Options[0].OptionID
		}
		return ""
	})
	// A content update → running.
	h.OnUpdate(acp.Event{Kind: acp.EventContentDelta, Text: "x"})
	// A permission request → awaiting_input then running, returning the chosen id.
	got := h.OnPermission(acp.PermissionRequest{Options: []acp.PermissionOption{{OptionID: "allow"}}})
	if got != "allow" {
		t.Fatalf("decision = %q", got)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{status.StateRunning, status.StateAwaiting, status.StateRunning}
	if len(states) != len(want) {
		t.Fatalf("states = %v", states)
	}
	for i := range want {
		if states[i] != want[i] {
			t.Fatalf("states = %v, want %v", states, want)
		}
	}
}

func TestRunACPOverConn(t *testing.T) {
	agentIn, clientOut := io.Pipe() // client → agent
	clientIn, agentOut := io.Pipe() // agent → client

	var mu sync.Mutex
	var states []string
	push := func(u status.Update) {
		if u.State != "" {
			mu.Lock()
			states = append(states, u.State)
			mu.Unlock()
		}
	}
	conn := acp.NewConn(clientIn, clientOut, newACPHandlers(push, nil))
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() { _ = conn.Run(ctx) }()

	// Mock agent.
	go func() {
		br := bufio.NewReader(agentIn)
		emit := func(v any) { b, _ := json.Marshal(v); _, _ = agentOut.Write(append(b, '\n')) }
		for {
			line, err := br.ReadBytes('\n')
			if len(line) > 0 {
				var m struct {
					ID     json.RawMessage `json:"id"`
					Method string          `json:"method"`
				}
				_ = json.Unmarshal(line, &m)
				switch m.Method {
				case "initialize":
					emit(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{}})
				case "session/new":
					emit(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"sessionId": "s1"}})
				case "session/prompt":
					emit(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{
						"update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"text": "working"}},
					}})
					emit(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": map[string]any{"stopReason": "end_turn"}})
				}
			}
			if err != nil {
				return
			}
		}
	}()

	if err := runACPOverConn(ctx, conn, "/work", "do it", push); err != nil {
		t.Fatalf("runACPOverConn: %v", err)
	}
	// Give the streamed update a beat to be delivered by the Run goroutine.
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	// Expect: running (lifecycle) … idle (turn end), with the streamed content
	// having pushed a running in between.
	if len(states) < 2 || states[0] != status.StateRunning || states[len(states)-1] != status.StateIdle {
		t.Fatalf("states = %v (want running … idle)", states)
	}
}
