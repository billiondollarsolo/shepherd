package session

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

// fakeClaudeScript is a stub `claude --print --input-format stream-json …` process:
// it emits a canned init/assistant/tool/result burst on start, then — because its
// stdin stays OPEN — echoes one assistant+result burst for EACH user-turn line it
// reads on stdin. This exercises the driver's read loop (chat + status) and its
// stdin turn framing without the real CLI.
const fakeClaudeScript = `#!/usr/bin/env bash
emit() { printf '%s\n' "$1"; }
emit '{"type":"system","subtype":"init","model":"claude-sonnet-test","slash_commands":["/help"],"tools":["Write"]}'
emit '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from claude"}]}}'
emit '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file":"x"}}]}}'
emit '{"type":"user","message":{"content":[{"tool_use_id":"t1","type":"tool_result","content":"ok"}]}}'
emit '{"type":"result","subtype":"success","result":"hello from claude","stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":5}}'
# Persistent: keep reading user turns until stdin closes.
while IFS= read -r line; do
  emit '{"type":"assistant","message":{"content":[{"type":"text","text":"reply"}]}}'
  emit '{"type":"result","subtype":"success","result":"reply","stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":1}}'
done
`

// chatSink is an httptest server capturing every hook POST: the role/text of
// {chat:…} messages AND the raw JSON of the structured agentEvent bodies
// (tool.started / tool.updated / commands.updated).
type chatSink struct {
	mu     sync.Mutex
	msgs   []struct{ Role, Text string }
	events []map[string]any // structured (non-chat) agentEvent bodies
}

func (c *chatSink) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var raw map[string]any
		_ = json.NewDecoder(r.Body).Decode(&raw)
		c.mu.Lock()
		if chat, ok := raw["chat"].(map[string]any); ok {
			role, _ := chat["role"].(string)
			text, _ := chat["text"].(string)
			c.msgs = append(c.msgs, struct{ Role, Text string }{role, text})
		} else if _, ok := raw["kind"]; ok {
			c.events = append(c.events, raw)
		}
		c.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}
}

func (c *chatSink) has(role, text string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, m := range c.msgs {
		if m.Role == role && strings.Contains(m.Text, text) {
			return true
		}
	}
	return false
}

// hasEvent reports whether any captured structured event has kind==kind and, for
// each key in fields, a matching (string) top-level value.
func (c *chatSink) hasEvent(kind string, fields map[string]string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		if k, _ := e["kind"].(string); k != kind {
			continue
		}
		ok := true
		for key, want := range fields {
			if got, _ := e[key].(string); got != want {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func writeFakeClaude(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-claude.sh")
	if err := os.WriteFile(path, []byte(fakeClaudeScript), 0o755); err != nil {
		t.Fatalf("write fake claude: %v", err)
	}
	return path
}

// fakeClaudeApprovalScript is a stub that, on start, emits an init line then a
// can_use_tool CONTROL request (as `claude --permission-prompt-tool stdio` does). It
// then reads ONE line from its stdin — the control_response the driver writes when the
// operator answers — and saves it VERBATIM to $FLOCK_CAPTURE so the test can assert the
// exact bytes. Afterwards it behaves like the main stub (echoes a reply for each further
// user turn), so the no-pending framing path can be exercised too.
const fakeClaudeApprovalScript = `#!/usr/bin/env bash
emit() { printf '%s\n' "$1"; }
emit '{"type":"system","subtype":"init","model":"claude-sonnet-test","tools":["Write"]}'
emit '{"type":"control_request","request_id":"req-42","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"foo.txt","content":"bar"}}}'
IFS= read -r resp
printf '%s\n' "$resp" > "$FLOCK_CAPTURE"
emit '{"type":"result","subtype":"success","result":"done","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
while IFS= read -r line; do
  emit '{"type":"assistant","message":{"content":[{"type":"text","text":"ack"}]}}'
  emit '{"type":"result","subtype":"success","result":"ack","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
done
`

func writeFakeClaudeApproval(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-claude-approval.sh")
	if err := os.WriteFile(path, []byte(fakeClaudeApprovalScript), 0o755); err != nil {
		t.Fatalf("write fake claude approval: %v", err)
	}
	return path
}

// event returns the first captured structured event with the given kind.
func (c *chatSink) event(kind string) (map[string]any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, e := range c.events {
		if k, _ := e["kind"].(string); k == kind {
			return e, true
		}
	}
	return nil, false
}

func TestOpenClaudeStreamDrivesChatAndStatus(t *testing.T) {
	sink := &chatSink{}
	srv := httptest.NewServer(sink.handler())
	defer srv.Close()

	script := writeFakeClaude(t)
	var mu sync.Mutex
	var states []string
	var model string
	push := func(u status.Update) {
		mu.Lock()
		if u.State != "" {
			states = append(states, u.State)
		}
		if u.Model != "" {
			model = u.Model
		}
		mu.Unlock()
	}

	s, err := OpenClaudeStream(Spec{
		ID:      "cs1",
		Command: []string{"bash", script},
		Env:     []string{"FLOCK_HOOK_URL=" + srv.URL},
	}, push)
	if err != nil {
		t.Fatalf("OpenClaudeStream: %v", err)
	}
	defer s.Close()

	// Wait for the initial burst: assistant text should reach the chat sink.
	waitFor(t, 3*time.Second, func() bool { return sink.has("assistant", "hello from claude") })

	mu.Lock()
	gotModel := model
	initialStates := append([]string(nil), states...)
	mu.Unlock()
	if gotModel != "claude-sonnet-test" {
		t.Fatalf("model = %q, want claude-sonnet-test (from init)", gotModel)
	}
	// The initial burst must drive running (assistant/tool) then idle (result).
	if !containsState(initialStates, status.StateRunning) || last(initialStates) != status.StateIdle {
		t.Fatalf("initial states = %v, want running … idle", initialStates)
	}
	// The tool_use must post a STRUCTURED tool.started event (name + args), NOT the
	// old flattened {chat:{role:"tool"}}.
	waitFor(t, 3*time.Second, func() bool {
		return sink.hasEvent("tool.started", map[string]string{"title": "Write"})
	})
	if sink.has("tool", "Write") {
		t.Fatalf("tool must NOT double-post a {chat role:tool}; msgs=%+v", sink.msgs)
	}
	// The tool_result must post a tool.updated (completed) event.
	if !sink.hasEvent("tool.updated", map[string]string{"status": "completed"}) {
		t.Fatalf("expected a tool.updated event; events=%+v", sink.events)
	}
	// The init line's slash_commands must post a commands.updated event.
	if !sink.hasEvent("commands.updated", nil) {
		t.Fatalf("expected a commands.updated event; events=%+v", sink.events)
	}

	// Typed input → a correctly-framed {"type":"user",…} line on the process stdin,
	// which the stub answers with another assistant reply reaching the chat sink.
	if err := s.Write([]byte("do a thing\r")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool { return sink.has("user", "do a thing") })
	waitFor(t, 3*time.Second, func() bool { return sink.has("assistant", "reply") })
}

// TestClaudeSendTurnFraming asserts the exact JSON frame written to claude's stdin
// for a user turn (the persistent-process protocol contract), including safe
// escaping of special characters.
func TestClaudeSendTurnFraming(t *testing.T) {
	pr, pw, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer pr.Close()
	cst := &claudeState{stdin: pw}
	s := &Session{}

	got := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(pr).ReadString('\n')
		got <- line
	}()

	if err := s.claudeSendTurn(cst, `hi "there"`); err != nil {
		t.Fatalf("claudeSendTurn: %v", err)
	}
	_ = pw.Close()

	select {
	case line := <-got:
		var frame struct {
			Type    string `json:"type"`
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &frame); err != nil {
			t.Fatalf("stdin frame not valid JSON: %q (%v)", line, err)
		}
		if frame.Type != "user" || frame.Message.Role != "user" || frame.Message.Content != `hi "there"` {
			t.Fatalf("bad frame: %+v", frame)
		}
		if !strings.HasSuffix(line, "\n") {
			t.Fatalf("frame not newline-terminated: %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no frame written to stdin")
	}
}

// TestClaudeStreamApprovalAllow drives a can_use_tool control request through the
// driver: it must post a request.opened event (title = tool name + the tool input),
// flip to awaiting_input, and on a 'y' answer write the EXACT allow control_response
// (behavior:allow, matching request_id, updatedInput echoing the original input) to the
// process stdin. It also confirms a subsequent normal turn (no pending) still frames a
// user message, and that request.resolved is posted.
func TestClaudeStreamApprovalAllow(t *testing.T) {
	captured := runClaudeApproval(t, "y\r")

	// (c) EXACT allow control_response line written to the process stdin.
	var frame struct {
		Type     string `json:"type"`
		Response struct {
			Subtype   string `json:"subtype"`
			RequestID string `json:"request_id"`
			Response  struct {
				Behavior     string          `json:"behavior"`
				UpdatedInput json.RawMessage `json:"updatedInput"`
			} `json:"response"`
		} `json:"response"`
	}
	if err := json.Unmarshal([]byte(captured), &frame); err != nil {
		t.Fatalf("captured control_response not valid JSON: %q (%v)", captured, err)
	}
	if frame.Type != "control_response" || frame.Response.Subtype != "success" {
		t.Fatalf("bad allow frame envelope: %q", captured)
	}
	if frame.Response.RequestID != "req-42" {
		t.Fatalf("request_id = %q, want req-42", frame.Response.RequestID)
	}
	if frame.Response.Response.Behavior != "allow" {
		t.Fatalf("behavior = %q, want allow", frame.Response.Response.Behavior)
	}
	// updatedInput must echo the ORIGINAL tool input verbatim (semantically).
	var got, want map[string]any
	_ = json.Unmarshal(frame.Response.Response.UpdatedInput, &got)
	_ = json.Unmarshal([]byte(`{"file_path":"foo.txt","content":"bar"}`), &want)
	if len(got) != 2 || got["file_path"] != "foo.txt" || got["content"] != "bar" {
		t.Fatalf("updatedInput = %s, want the original input echoed", frame.Response.Response.UpdatedInput)
	}
}

// TestClaudeStreamApprovalDeny asserts the 'n' answer writes the deny control_response.
func TestClaudeStreamApprovalDeny(t *testing.T) {
	captured := runClaudeApproval(t, "n\r")
	var frame struct {
		Type     string `json:"type"`
		Response struct {
			Subtype   string `json:"subtype"`
			RequestID string `json:"request_id"`
			Response  struct {
				Behavior string `json:"behavior"`
				Message  string `json:"message"`
			} `json:"response"`
		} `json:"response"`
	}
	if err := json.Unmarshal([]byte(captured), &frame); err != nil {
		t.Fatalf("captured control_response not valid JSON: %q (%v)", captured, err)
	}
	if frame.Type != "control_response" || frame.Response.Subtype != "success" {
		t.Fatalf("bad deny frame envelope: %q", captured)
	}
	if frame.Response.RequestID != "req-42" {
		t.Fatalf("request_id = %q, want req-42", frame.Response.RequestID)
	}
	if frame.Response.Response.Behavior != "deny" || frame.Response.Response.Message == "" {
		t.Fatalf("deny frame body = %+v, want behavior:deny + message", frame.Response.Response)
	}
}

// runClaudeApproval starts the approval stub, waits for the request.opened event +
// awaiting_input status, answers with `answer`, and returns the EXACT control_response
// line the driver wrote to the process stdin (read from $FLOCK_CAPTURE).
func runClaudeApproval(t *testing.T, answer string) string {
	t.Helper()
	sink := &chatSink{}
	srv := httptest.NewServer(sink.handler())
	defer srv.Close()

	script := writeFakeClaudeApproval(t)
	capture := filepath.Join(t.TempDir(), "control_response.json")

	var mu sync.Mutex
	var states []string
	push := func(u status.Update) {
		mu.Lock()
		if u.State != "" {
			states = append(states, u.State)
		}
		mu.Unlock()
	}

	s, err := OpenClaudeStream(Spec{
		ID:      "cs-approval",
		Command: []string{"bash", script},
		Env:     []string{"FLOCK_HOOK_URL=" + srv.URL, "FLOCK_CAPTURE=" + capture},
	}, push)
	if err != nil {
		t.Fatalf("OpenClaudeStream: %v", err)
	}
	defer s.Close()

	// (a) request.opened posted with title = tool name and the tool input.
	waitFor(t, 3*time.Second, func() bool {
		return sink.hasEvent("request.opened", map[string]string{
			"title": "Write", "requestKind": "permission", "requestId": "req-42",
		})
	})
	ev, _ := sink.event("request.opened")
	ti, ok := ev["toolInput"].(map[string]any)
	if !ok || ti["file_path"] != "foo.txt" {
		t.Fatalf("request.opened toolInput missing/wrong: %+v", ev)
	}

	// (b) flipped to awaiting_input.
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return containsState(states, status.StateAwaiting)
	})

	// Answer the approval → the driver writes the control_response to the stub's stdin.
	if err := s.Write([]byte(answer)); err != nil {
		t.Fatalf("Write answer: %v", err)
	}

	// request.resolved must be posted.
	waitFor(t, 3*time.Second, func() bool {
		return sink.hasEvent("request.resolved", map[string]string{"requestId": "req-42"})
	})

	// The stub saved the exact control_response line to $FLOCK_CAPTURE; read it back.
	var line string
	waitFor(t, 3*time.Second, func() bool {
		b, rerr := os.ReadFile(capture)
		if rerr != nil || len(strings.TrimSpace(string(b))) == 0 {
			return false
		}
		line = strings.TrimSpace(string(b))
		return true
	})

	// A NORMAL turn (no pending) must still frame a {"type":"user",…} message: the
	// approval path never posts a user chat, so this exercises the plain framing path.
	if err := s.Write([]byte("hello again\r")); err != nil {
		t.Fatalf("Write turn: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool { return sink.has("user", "hello again") })

	return line
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", d)
}

func containsState(states []string, want string) bool {
	for _, s := range states {
		if s == want {
			return true
		}
	}
	return false
}

func last(states []string) string {
	if len(states) == 0 {
		return ""
	}
	return states[len(states)-1]
}
