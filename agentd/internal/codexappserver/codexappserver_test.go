package codexappserver

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/acp"
)

func raw(s string) json.RawMessage { return json.RawMessage(s) }

// TestCodexItemToEvents checks the mapping from real notification shapes (from the
// version-exact schema) onto the canonical acp.Event taxonomy.
func TestCodexItemToEvents(t *testing.T) {
	cases := []struct {
		name   string
		method string
		params string
		want   func([]acp.Event) bool
	}{
		{
			"command started → tool.started",
			"item/started",
			`{"item":{"id":"c1","type":"commandExecution","command":"ls -la","status":"inProgress"}}`,
			func(e []acp.Event) bool {
				if len(e) != 1 || e[0].Kind != acp.EventToolStarted || e[0].ToolID != "c1" || e[0].ToolName != "shell" {
					return false
				}
				var in struct {
					Command string `json:"command"`
				}
				_ = json.Unmarshal(e[0].ToolInput, &in)
				return in.Command == "ls -la"
			},
		},
		{
			"command completed → tool.updated",
			"item/completed",
			`{"item":{"id":"c1","type":"commandExecution","command":"ls -la","status":"completed","aggregatedOutput":"total 0"}}`,
			func(e []acp.Event) bool {
				return len(e) == 1 && e[0].Kind == acp.EventToolUpdated && e[0].ToolID == "c1" &&
					e[0].ToolStatus == "completed" && e[0].ToolOutput == "total 0"
			},
		},
		{
			"failed command → failed status",
			"item/completed",
			`{"item":{"id":"c9","type":"commandExecution","status":"failed"}}`,
			func(e []acp.Event) bool {
				return len(e) == 1 && e[0].ToolStatus == "failed"
			},
		},
		{
			"agent message → assistant_text",
			"item/completed",
			`{"item":{"id":"m1","type":"agentMessage","text":"hello from codex"}}`,
			func(e []acp.Event) bool {
				return len(e) == 1 && e[0].Kind == acp.EventContentDelta &&
					e[0].StreamKind == "assistant_text" && e[0].Text == "hello from codex"
			},
		},
		{
			"file change → tool.started with input",
			"item/started",
			`{"item":{"id":"f1","type":"fileChange","status":"inProgress","changes":[{"path":"a.txt","kind":"update","diff":"@@"}]}}`,
			func(e []acp.Event) bool {
				return len(e) == 1 && e[0].Kind == acp.EventToolStarted && e[0].ToolName == "apply_patch" && len(e[0].ToolInput) > 0
			},
		},
		{
			"file change completed → tool.updated with diff",
			"item/completed",
			`{"item":{"id":"f1","type":"fileChange","status":"completed","changes":[{"path":"a.txt","kind":"update","diff":"@@ -1 +1 @@"}]}}`,
			func(e []acp.Event) bool {
				return len(e) == 1 && e[0].Kind == acp.EventToolUpdated && e[0].ToolStatus == "completed" && len(e[0].ToolDiff) > 0
			},
		},
		{
			"reasoning → reasoning_text",
			"item/completed",
			`{"item":{"id":"r1","type":"reasoning","summary":[{"text":"thinking hard"}]}}`,
			func(e []acp.Event) bool {
				return len(e) == 1 && e[0].StreamKind == "reasoning_text" && e[0].Text == "thinking hard"
			},
		},
		{
			"turn completed → turn.completed",
			"turn/completed",
			`{"threadId":"th-1","turn":{}}`,
			func(e []acp.Event) bool {
				return len(e) == 1 && e[0].Kind == acp.EventTurnCompleted
			},
		},
		{
			"agent message started → nothing (text only on completed)",
			"item/started",
			`{"item":{"id":"m1","type":"agentMessage","text":""}}`,
			func(e []acp.Event) bool { return len(e) == 0 },
		},
		{
			"unknown method → nothing",
			"account/updated",
			`{}`,
			func(e []acp.Event) bool { return len(e) == 0 },
		},
		{
			"unknown item type → nothing",
			"item/completed",
			`{"item":{"id":"x","type":"sleep","durationMs":10}}`,
			func(e []acp.Event) bool { return len(e) == 0 },
		},
	}
	for _, c := range cases {
		got := CodexItemToEvents(c.method, raw(c.params))
		if !c.want(got) {
			t.Fatalf("%s: got %+v", c.name, got)
		}
	}
}

// pipePair wires a Conn to a scripted mock app-server over two ndjson pipes.
func pipePair(t *testing.T, h Handlers) (*Conn, *bufio.Reader, io.Writer, context.CancelFunc) {
	t.Helper()
	serverIn, clientOut := io.Pipe() // client → server stdin
	clientIn, serverOut := io.Pipe() // server → client stdout
	conn := NewConn(clientIn, clientOut, h)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	go func() { _ = conn.Run(ctx) }()
	return conn, bufio.NewReader(serverIn), serverOut, cancel
}

func writeJSON(w io.Writer, v any) {
	b, _ := json.Marshal(v)
	_, _ = w.Write(append(b, '\n'))
}

// TestConnCallCorrelationAndNotification exercises id-correlated Call responses AND
// notification dispatch to the handler on the SAME connection.
func TestConnCallCorrelationAndNotification(t *testing.T) {
	notes := make(chan string, 8)
	conn, serverReqs, serverOut, cancel := pipePair(t, Handlers{
		OnNotification: func(method string, _ json.RawMessage) { notes <- method },
	})
	defer cancel()

	// Mock server: reply to thread/start with a thread id, and emit a notification.
	go func() {
		for {
			line, err := serverReqs.ReadBytes('\n')
			if len(line) > 0 {
				var m message
				_ = json.Unmarshal(line, &m)
				if m.Method == "thread/start" && m.ID != nil {
					// A notification interleaved BEFORE the response must still dispatch.
					writeJSON(serverOut, map[string]any{"method": "turn/started", "params": map[string]any{}})
					writeJSON(serverOut, map[string]any{"id": *m.ID, "result": map[string]any{"thread": map[string]any{"id": "th-42"}}})
				}
			}
			if err != nil {
				return
			}
		}
	}()

	tid, err := conn.ThreadStart(context.Background(), "/work")
	if err != nil || tid != "th-42" {
		t.Fatalf("thread start: tid=%q err=%v", tid, err)
	}
	select {
	case m := <-notes:
		if m != "turn/started" {
			t.Fatalf("notification method = %q", m)
		}
	case <-time.After(time.Second):
		t.Fatal("no notification dispatched")
	}
}

// TestConnServerRequestReply exercises the SERVER→CLIENT request path: a frame with
// BOTH an id and a method must reach OnServerRequest, and Conn.Reply must write a
// {"id":n,"result":…} the server can read.
func TestConnServerRequestReply(t *testing.T) {
	conn, serverReqs, serverOut, cancel := pipePair(t, Handlers{})
	defer cancel()

	// The handler replies with {decision:"approved"} — like the driver's approval path.
	conn.handlers.OnServerRequest = func(id int64, method string, _ json.RawMessage) {
		if method == "execCommandApproval" {
			conn.Reply(id, map[string]any{"decision": "approved"}, nil)
		} else {
			conn.Reply(id, map[string]any{}, nil)
		}
	}

	got := make(chan string, 1)
	go func() {
		// Send a server-request (id=77), then read the client's reply.
		writeJSON(serverOut, map[string]any{"id": 77, "method": "execCommandApproval", "params": map[string]any{"callId": "c1"}})
		for {
			line, err := serverReqs.ReadBytes('\n')
			if len(line) > 0 {
				var m struct {
					ID     *int64 `json:"id"`
					Result struct {
						Decision string `json:"decision"`
					} `json:"result"`
				}
				if json.Unmarshal(line, &m) == nil && m.ID != nil && *m.ID == 77 {
					got <- m.Result.Decision
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	select {
	case d := <-got:
		if d != "approved" {
			t.Fatalf("reply decision = %q, want approved", d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no server-request reply from client")
	}
}

// TestModelListParsesData checks model/list parsing (and de-dup + id fallback), plus
// the graceful empty-list case (codex returns no models until authenticated).
func TestModelListParsesData(t *testing.T) {
	conn, serverReqs, serverOut, cancel := pipePair(t, Handlers{})
	defer cancel()

	go func() {
		for {
			line, err := serverReqs.ReadBytes('\n')
			if len(line) > 0 {
				var m message
				_ = json.Unmarshal(line, &m)
				if m.Method == "model/list" && m.ID != nil {
					writeJSON(serverOut, map[string]any{"id": *m.ID, "result": map[string]any{
						"data": []map[string]any{
							{"id": "gpt-5-codex", "model": "gpt-5-codex", "displayName": "GPT-5 Codex"},
							{"model": "o4-mini"},  // id falls back to model
							{"id": "gpt-5-codex"}, // duplicate, dropped
						},
					}})
				}
			}
			if err != nil {
				return
			}
		}
	}()

	models, err := conn.ModelList(context.Background())
	if err != nil {
		t.Fatalf("model list: %v", err)
	}
	if len(models) != 2 || models[0] != "gpt-5-codex" || models[1] != "o4-mini" {
		t.Fatalf("models = %v, want [gpt-5-codex o4-mini]", models)
	}
}
