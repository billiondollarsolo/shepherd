package session

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

// fakeCodexAppServer is a stub `codex app-server` process: a JSON-RPC ndjson server
// over stdin/stdout. It replies to initialize + thread/start, and on the first
// turn/start it streams a command tool call (started + completed), an agent message,
// an execCommandApproval SERVER-REQUEST, and turn/completed — then replies to the
// turn. When the driver replies to the approval (id 9001), it saves that reply
// VERBATIM to $FLOCK_CAPTURE so the test can assert the exact decision.
const fakeCodexAppServerScript = `#!/usr/bin/env bash
emit() { printf '%s\n' "$1"; }
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      emit "{\"id\":$id,\"result\":{}}" ;;
    *'"method":"thread/start"'*)
      emit "{\"id\":$id,\"result\":{\"thread\":{\"id\":\"th-1\"}}}" ;;
    *'"method":"turn/start"'*)
      emit '{"method":"item/started","params":{"item":{"id":"c1","type":"commandExecution","command":"ls -la","status":"inProgress"}}}'
      emit '{"method":"item/completed","params":{"item":{"id":"c1","type":"commandExecution","command":"ls -la","status":"completed","aggregatedOutput":"total 0"}}}'
      emit '{"method":"item/completed","params":{"item":{"id":"m1","type":"agentMessage","text":"hello from codex"}}}'
      emit '{"id":9001,"method":"execCommandApproval","params":{"callId":"call-1","command":["rm","-rf","x"],"conversationId":"th-1","cwd":"/w","parsedCmd":[]}}'
      emit '{"method":"turn/completed","params":{"threadId":"th-1","turn":{}}}'
      emit "{\"id\":$id,\"result\":{\"turn\":{}}}" ;;
    *'"id":9001'*)
      printf '%s\n' "$line" > "$FLOCK_CAPTURE" ;;
  esac
done
`

func writeFakeCodex(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-codex.sh")
	if err := os.WriteFile(path, []byte(fakeCodexAppServerScript), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	return path
}

// TestOpenCodexAppServerDrivesChatToolsAndApproval drives the full happy path through
// the codex-app-server driver against the stub: a user turn yields a structured tool
// card (started + updated), an assistant chat message, and an approval that — on a 'y'
// answer — replies the server-request with {decision:"approved"} (the exact enum for
// the execCommandApproval family).
func TestOpenCodexAppServerDrivesChatToolsAndApproval(t *testing.T) {
	sink := &chatSink{}
	srv := httptest.NewServer(sink.handler())
	defer srv.Close()

	script := writeFakeCodex(t)
	capture := filepath.Join(t.TempDir(), "approval_reply.json")

	var mu sync.Mutex
	var states []string
	push := func(u status.Update) {
		mu.Lock()
		if u.State != "" {
			states = append(states, u.State)
		}
		mu.Unlock()
	}

	s, err := OpenCodexAppServer(Spec{
		ID:      "cx1",
		Command: []string{"bash", script},
		Env:     []string{"FLOCK_HOOK_URL=" + srv.URL, "FLOCK_CAPTURE=" + capture},
	}, push)
	if err != nil {
		t.Fatalf("OpenCodexAppServer: %v", err)
	}
	defer s.Close()

	// After the handshake the session must reach idle (ready).
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return containsState(states, status.StateIdle)
	})

	// A user turn: the driver posts the user chat and submits turn/start.
	if err := s.Write([]byte("do a thing\r")); err != nil {
		t.Fatalf("Write turn: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool { return sink.has("user", "do a thing") })

	// The command item must post a STRUCTURED tool.started (title "shell") and a
	// tool.updated (completed) — the same cards the Claude/ACP paths produce.
	waitFor(t, 3*time.Second, func() bool {
		return sink.hasEvent("tool.started", map[string]string{"title": "shell"})
	})
	if !sink.hasEvent("tool.updated", map[string]string{"status": "completed"}) {
		t.Fatalf("expected a tool.updated event; events=%+v", sink.events)
	}
	// The agent message must land in Chat as an assistant message.
	waitFor(t, 3*time.Second, func() bool { return sink.has("assistant", "hello from codex") })

	// The approval server-request must post request.opened (title = the command) and
	// flip to awaiting_input.
	waitFor(t, 3*time.Second, func() bool {
		return sink.hasEvent("request.opened", map[string]string{
			"requestKind": "permission", "title": "rm -rf x",
		})
	})
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return containsState(states, status.StateAwaiting)
	})

	// Answer 'y' → the driver replies the approval server-request; request.resolved posts.
	if err := s.Write([]byte("y\r")); err != nil {
		t.Fatalf("Write answer: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool {
		return sink.hasEvent("request.resolved", nil)
	})

	// The stub captured the EXACT reply written to it — assert {decision:"approved"}.
	var line string
	waitFor(t, 3*time.Second, func() bool {
		b, rerr := os.ReadFile(capture)
		if rerr != nil || len(strings.TrimSpace(string(b))) == 0 {
			return false
		}
		line = strings.TrimSpace(string(b))
		return true
	})
	var reply struct {
		ID     int64 `json:"id"`
		Result struct {
			Decision string `json:"decision"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(line), &reply); err != nil {
		t.Fatalf("captured approval reply not valid JSON: %q (%v)", line, err)
	}
	if reply.ID != 9001 {
		t.Fatalf("reply id = %d, want 9001", reply.ID)
	}
	if reply.Result.Decision != "approved" {
		t.Fatalf("decision = %q, want approved", reply.Result.Decision)
	}
}

// TestCodexApprovalDeny asserts an 'n' answer replies {decision:"denied"} (the
// execCommandApproval / ReviewDecision family).
func TestCodexApprovalDeny(t *testing.T) {
	sink := &chatSink{}
	srv := httptest.NewServer(sink.handler())
	defer srv.Close()

	script := writeFakeCodex(t)
	capture := filepath.Join(t.TempDir(), "approval_reply.json")

	var mu sync.Mutex
	var states []string
	s, err := OpenCodexAppServer(Spec{
		ID:      "cx2",
		Command: []string{"bash", script},
		Env:     []string{"FLOCK_HOOK_URL=" + srv.URL, "FLOCK_CAPTURE=" + capture},
	}, func(u status.Update) {
		mu.Lock()
		if u.State != "" {
			states = append(states, u.State)
		}
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("OpenCodexAppServer: %v", err)
	}
	defer s.Close()

	// Wait for the handshake to finish (idle) so the thread id is set before the turn.
	waitFor(t, 3*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return containsState(states, status.StateIdle)
	})
	if err := s.Write([]byte("do a thing\r")); err != nil {
		t.Fatalf("Write turn: %v", err)
	}
	waitFor(t, 3*time.Second, func() bool { return sink.hasEvent("request.opened", nil) })

	if err := s.Write([]byte("n\r")); err != nil {
		t.Fatalf("Write answer: %v", err)
	}
	var line string
	waitFor(t, 3*time.Second, func() bool {
		b, rerr := os.ReadFile(capture)
		if rerr != nil || len(strings.TrimSpace(string(b))) == 0 {
			return false
		}
		line = strings.TrimSpace(string(b))
		return true
	})
	var reply struct {
		Result struct {
			Decision string `json:"decision"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(line), &reply); err != nil {
		t.Fatalf("captured reply not valid JSON: %q (%v)", line, err)
	}
	if reply.Result.Decision != "denied" {
		t.Fatalf("decision = %q, want denied", reply.Result.Decision)
	}
}
