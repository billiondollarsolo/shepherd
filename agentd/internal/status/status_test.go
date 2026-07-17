package status

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func alwaysClaim(string) bool { return true }

func TestDetectAgent(t *testing.T) {
	cases := map[string]string{
		"":       "",
		"claude": "claude",
		"codex":  "codex",
		// T21: OpenCode is no longer transcript-tailed (status comes from its hook
		// plugin), so DetectAgent returns "" for it like any non-tailed program.
		"opencode": "",
		"bash":     "",
	}
	for arg, want := range cases {
		var cmd []string
		if arg != "" {
			cmd = []string{arg, "--flag"}
		}
		if got := DetectAgent(cmd); got != want {
			t.Errorf("DetectAgent(%q) = %q, want %q", arg, got, want)
		}
	}
	// full path resolves by basename
	if got := DetectAgent([]string{"/usr/bin/codex"}); got != "codex" {
		t.Errorf("DetectAgent(/usr/bin/codex) = %q", got)
	}
}

func TestCodexLineToUpdate(t *testing.T) {
	cases := []struct {
		evt  string
		want string
		ok   bool
	}{
		{"task_started", StateRunning, true},
		{"agent_reasoning", StateRunning, true},
		{"exec_command_begin", StateRunning, true},
		{"exec_approval_request", StateAwaiting, true},
		{"request_user_input", StateAwaiting, true},
		{"task_complete", StateIdle, true},
		{"turn_aborted", StateIdle, true},
		{"error", StateError, true},
		{"token_count", "", false}, // usage only, not a state
		{"session_configured", "", false},
	}
	for _, c := range cases {
		line := fmt.Sprintf(`{"timestamp":"2026-06-02T10:00:00Z","type":"event_msg","payload":{"type":%q}}`, c.evt)
		u, ok := codexLineToUpdate([]byte(line))
		if ok != c.ok || u.State != c.want {
			t.Errorf("evt %q → (%q,%v), want (%q,%v)", c.evt, u.State, ok, c.want, c.ok)
		}
	}
	// non-event_msg lines are ignored
	if _, ok := codexLineToUpdate([]byte(`{"type":"response_item","payload":{}}`)); ok {
		t.Error("response_item should be ignored")
	}
}

func TestCodexTokenCount(t *testing.T) {
	line := `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"output_tokens":234,"total_tokens":1234}}}}`
	u, ok := codexLineToUpdate([]byte(line))
	if !ok || u.Tokens != 1234 {
		t.Fatalf("token_count → tokens %d ok %v, want 1234 true", u.Tokens, ok)
	}
}

// T19: model + context-window occupancy extraction.
func TestClaudeModelAndContext(t *testing.T) {
	line := `{"type":"assistant","message":{"model":"claude-opus-4-8","stop_reason":"end_turn",` +
		`"usage":{"input_tokens":100,"output_tokens":40,"cache_read_input_tokens":2000,"cache_creation_input_tokens":300}}}`
	u, ok := claudeLineToUpdate([]byte(line))
	if !ok || u.Model != "claude-opus-4-8" {
		t.Fatalf("model = %q ok=%v, want claude-opus-4-8", u.Model, ok)
	}
	// context = input + both cache tiers (excludes output): 100 + 2000 + 300 = 2400
	if u.ContextTokens != 2400 {
		t.Fatalf("contextTokens = %d, want 2400", u.ContextTokens)
	}
}

func TestCodexModelFromTurnContext(t *testing.T) {
	// Model is in turn_context (real shape), NOT session_meta.
	tc := `{"type":"turn_context","payload":{"turn_id":"t1","cwd":"/x","model":"gpt-5.5","approval_policy":"never"}}`
	u, ok := codexLineToUpdate([]byte(tc))
	if !ok || u.Model != "gpt-5.5" {
		t.Fatalf("turn_context model = %q ok=%v, want gpt-5.5", u.Model, ok)
	}
	// session_meta (no model) → no update.
	if _, ok := codexLineToUpdate([]byte(`{"type":"session_meta","payload":{"cwd":"/x","model_provider":"openai"}}`)); ok {
		t.Fatalf("session_meta should not yield a model update")
	}
}

func TestCodexTokenCountContextAndLimit(t *testing.T) {
	// Real shape: info carries total_token_usage, last_token_usage AND
	// model_context_window. input_tokens already includes cached → no double-count.
	tc := `{"type":"event_msg","payload":{"type":"token_count","info":{` +
		`"total_token_usage":{"input_tokens":20761,"cached_input_tokens":18816,"output_tokens":220,"total_tokens":20981},` +
		`"last_token_usage":{"input_tokens":20761,"cached_input_tokens":18816,"output_tokens":220,"total_tokens":20981},` +
		`"model_context_window":258400}}}`
	u, ok := codexLineToUpdate([]byte(tc))
	if !ok {
		t.Fatal("token_count not parsed")
	}
	if u.Tokens != 20981 {
		t.Fatalf("cumulative tokens = %d, want 20981", u.Tokens)
	}
	if u.ContextTokens != 20761 { // input_tokens only, NOT input+cached (39577)
		t.Fatalf("contextTokens = %d, want 20761 (no cached double-count)", u.ContextTokens)
	}
	if u.ContextLimit != 258400 {
		t.Fatalf("contextLimit = %d, want 258400", u.ContextLimit)
	}
}

func TestCodexTokenCountNullInfo(t *testing.T) {
	// Rate-limit-only token_count: info is null → no token/context update.
	tc := `{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":23.0}}}}`
	if _, ok := codexLineToUpdate([]byte(tc)); ok {
		t.Fatalf("null-info token_count should yield no update")
	}
}

func TestClaudeTokensAndTool(t *testing.T) {
	line := `{"type":"assistant","message":{"stop_reason":"tool_use","usage":{"input_tokens":50,"output_tokens":20,"cache_read_input_tokens":5},` +
		`"content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"Edit","input":{"file_path":"/home/flock/src/app.ts"}}]}}`
	u, ok := claudeLineToUpdate([]byte(line))
	if !ok || u.Tokens != 75 || u.Tool != "Edit app.ts" || u.State != StateRunning {
		t.Fatalf("got state=%q tokens=%d tool=%q ok=%v", u.State, u.Tokens, u.Tool, ok)
	}
	// Bash tool → "Bash: <cmd>"
	bash := `{"type":"assistant","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}`
	u2, _ := claudeLineToUpdate([]byte(bash))
	if u2.Tool != "Bash: npm test" {
		t.Fatalf("bash tool = %q", u2.Tool)
	}
}

func TestClaudeLineToUpdate(t *testing.T) {
	cases := []struct {
		line string
		want string
		ok   bool
	}{
		{`{"type":"user","cwd":"/x","message":{"role":"user"}}`, StateRunning, true},
		{`{"type":"assistant","message":{"stop_reason":"tool_use"}}`, StateRunning, true},
		{`{"type":"assistant","message":{"stop_reason":"end_turn"}}`, StateIdle, true},
		{`{"type":"assistant","message":{"stop_reason":null}}`, StateRunning, true},
		{`{"type":"error","message":{}}`, StateError, true},
		{`{"type":"summary"}`, "", false},
		{`{"type":"system"}`, "", false},
	}
	for _, c := range cases {
		u, ok := claudeLineToUpdate([]byte(c.line))
		if ok != c.ok || u.State != c.want {
			t.Errorf("line %s → (%q,%v), want (%q,%v)", c.line, u.State, ok, c.want, c.ok)
		}
	}
}

// TestWatchAntigravityUsesRuntimeHome proves the watcher tails the RUNTIME user's
// home (the `home` param), not the daemon's HOME env. agentd runs as root
// (HOME=/root) while agy writes under /home/<user>, so a regression here means no
// chat / no status for antigravity sessions.
func TestWatchAntigravityUsesRuntimeHome(t *testing.T) {
	// Point HOME at an EMPTY dir; the transcript lives only under runtimeHome. If
	// the watcher used HOME (the old bug) it would find nothing and emit nothing.
	t.Setenv("HOME", t.TempDir())
	runtimeHome := t.TempDir()
	dir := filepath.Join(runtimeHome, ".gemini", "antigravity-cli", "brain", "conv-1", ".system_generated", "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>\nhello\n</USER_REQUEST>"}`,
		`{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY","status":"DONE","content":null}`,
		`{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"hi there"}`,
	}
	if err := os.WriteFile(filepath.Join(dir, "transcript.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var states []string
	var msgs []ChatMsg
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		watchAntigravity(ctx, "/home/flock-agent/proj", "", runtimeHome, time.Now(), alwaysClaim,
			func(u Update) { mu.Lock(); states = append(states, u.State); mu.Unlock() },
			func(role, text string) { mu.Lock(); msgs = append(msgs, ChatMsg{role, text}); mu.Unlock() })
		close(done)
	}()
	time.Sleep(800 * time.Millisecond)
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	wantMsgs := []ChatMsg{{Role: "user", Text: "hello"}, {Role: "assistant", Text: "hi there"}}
	if fmt.Sprint(msgs) != fmt.Sprint(wantMsgs) {
		t.Fatalf("antigravity chat = %v, want %v", msgs, wantMsgs)
	}
	wantStates := []string{StateRunning, StateIdle} // USER_INPUT(running) → PLANNER_RESPONSE DONE(idle)
	if fmt.Sprint(states) != fmt.Sprint(wantStates) {
		t.Fatalf("antigravity states = %v, want %v", states, wantStates)
	}
}

func TestWatchClaudeEmitsStateProgression(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cwd := "/home/flock/proj"
	start := time.Now()
	dir := filepath.Join(home, ".claude", "projects", "-home-flock-proj")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []string{
		`{"type":"user","cwd":"/home/flock/proj","message":{"role":"user"}}`,
		`{"type":"assistant","cwd":"/home/flock/proj","message":{"stop_reason":"tool_use"}}`,
		`{"type":"user","cwd":"/home/flock/proj","message":{"role":"user"}}`,
		`{"type":"assistant","cwd":"/home/flock/proj","message":{"stop_reason":"end_turn"}}`,
	}
	if err := os.WriteFile(filepath.Join(dir, "sess.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var states []string
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		watchClaude(ctx, cwd, "", "", start, alwaysClaim, func(u Update) { mu.Lock(); states = append(states, u.State); mu.Unlock() }, nil)
		close(done)
	}()
	time.Sleep(800 * time.Millisecond)
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	want := []string{StateRunning, StateIdle} // user/tool_use(running, deduped) → end_turn(idle)
	if fmt.Sprint(states) != fmt.Sprint(want) {
		t.Fatalf("claude states = %v, want %v", states, want)
	}
}

// writeRollout creates a codex rollout file with a session_meta + given events.
func writeRollout(t *testing.T, dir, cwd string, startTs time.Time, events ...string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, fmt.Sprintf("rollout-%d.jsonl", startTs.UnixNano()))
	var b []byte
	b = append(b, []byte(fmt.Sprintf(
		`{"timestamp":%q,"type":"session_meta","payload":{"cwd":%q}}`+"\n",
		startTs.Format(time.RFC3339), cwd))...)
	for _, e := range events {
		b = append(b, []byte(fmt.Sprintf(
			`{"timestamp":%q,"type":"event_msg","payload":{"type":%q}}`+"\n",
			startTs.Format(time.RFC3339), e))...)
	}
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFindCodexRolloutMatchesCwdAndTime(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	// a stale file in the same cwd from long ago — must be ignored
	writeRollout(t, filepath.Join(dir, "2026", "06", "01"), "/home/flock/proj", now.Add(-1*time.Hour))
	// a file in a different cwd — must be ignored
	writeRollout(t, filepath.Join(dir, "2026", "06", "02"), "/home/flock/other", now)
	// the right one
	want := writeRollout(t, filepath.Join(dir, "2026", "06", "02"), "/home/flock/proj", now)
	got := findCodexRollout(dir, "/home/flock/proj", now, alwaysClaim)
	if got != want {
		t.Fatalf("findCodexRollout = %q, want %q", got, want)
	}
}

func TestCodexClaimSeparatesSameCwdSessions(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	fA := writeRollout(t, filepath.Join(dir, "a"), "/home/flock", now)
	fB := writeRollout(t, filepath.Join(dir, "b"), "/home/flock", now.Add(2*time.Second))
	claimed := map[string]string{}
	var mu sync.Mutex
	mk := func(id string) func(string) bool {
		return func(p string) bool {
			mu.Lock()
			defer mu.Unlock()
			if o, ok := claimed[p]; ok && o != id {
				return false
			}
			claimed[p] = id
			return true
		}
	}
	gotA := findCodexRollout(dir, "/home/flock", now, mk("A"))
	gotB := findCodexRollout(dir, "/home/flock", now.Add(2*time.Second), mk("B"))
	if gotA != fA || gotB != fB {
		t.Fatalf("same-cwd sessions crossed streams: A=%q (want %q) B=%q (want %q)", gotA, fA, gotB, fB)
	}
}

func TestWatchCodexEmitsStateProgression(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	cwd := "/home/flock/proj"
	start := time.Now()
	// running → (approval) awaiting → running → idle
	writeRollout(t, filepath.Join(home, "sessions", "2026", "06", "02"), cwd, start,
		"task_started", "agent_reasoning", "exec_approval_request", "agent_message", "task_complete")

	var mu sync.Mutex
	var states []string
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		watchCodex(ctx, cwd, "", "", start, alwaysClaim, func(u Update) {
			mu.Lock()
			states = append(states, u.State)
			mu.Unlock()
		}, nil)
		close(done)
	}()
	// give the watcher time to find + read the file
	time.Sleep(800 * time.Millisecond)
	cancel()
	<-done

	mu.Lock()
	defer mu.Unlock()
	want := []string{StateRunning, StateAwaiting, StateRunning, StateIdle}
	if fmt.Sprint(states) != fmt.Sprint(want) {
		t.Fatalf("states = %v, want %v", states, want)
	}
}

func TestCodexUpdatePlan(t *testing.T) {
	line := `{"type":"response_item","payload":{"type":"function_call","name":"update_plan",` +
		`"arguments":"{\"plan\":[{\"step\":\"Add API\",\"status\":\"completed\"},{\"step\":\"Wire UI\",\"status\":\"in_progress\"},{\"step\":\"Test\",\"status\":\"pending\"}]}"}}`
	u, ok := codexLineToUpdate([]byte(line))
	if !ok || u.Plan == "" {
		t.Fatalf("update_plan not parsed: ok=%v plan=%q", ok, u.Plan)
	}
	var items []struct{ Content, Status string }
	if err := json.Unmarshal([]byte(u.Plan), &items); err != nil {
		t.Fatalf("plan json: %v", err)
	}
	if len(items) != 3 || items[0].Content != "Add API" || items[0].Status != "completed" || items[1].Status != "in_progress" {
		t.Fatalf("plan items wrong: %+v", items)
	}
	// A non-update_plan function_call yields nothing.
	if _, ok := codexLineToUpdate([]byte(`{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}`)); ok {
		t.Fatalf("non-update_plan should not yield a plan")
	}
}

// The shared Emitter merges partials and emits the full snapshot only on change.
func TestEmitterDedupAndSnapshot(t *testing.T) {
	var got []Update
	e := NewEmitter(func(u Update) { got = append(got, u) })
	e.Push(Update{State: StateRunning})
	e.Push(Update{State: StateRunning}) // no change → no emit
	e.Push(Update{Tokens: 100})         // change → emit full snapshot
	e.Push(Update{State: StateIdle})
	if len(got) != 3 {
		t.Fatalf("emits = %d, want 3 (%+v)", len(got), got)
	}
	// snapshot is cumulative: the tokens emit still carries the running state.
	if got[1].State != StateRunning || got[1].Tokens != 100 {
		t.Fatalf("snapshot not merged: %+v", got[1])
	}
	if got[2].State != StateIdle || got[2].Tokens != 100 {
		t.Fatalf("snapshot lost tokens on state change: %+v", got[2])
	}
}
