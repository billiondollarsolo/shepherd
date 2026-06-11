// Codex status from its rollout JSONL (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
//
// Each line is a RolloutLine: {"timestamp","type","payload"}. When type is
// "event_msg" the payload is a tagged EventMsg ({"type": "task_started", ...}).
// We map the lifecycle/activity events to a normalized state. Parsing is LENIENT
// (unknown line/event types are skipped) so it survives codex version drift.
//
// NOTE: codex's rollout persistence policy does NOT write approval/exec-begin
// events to disk, so `awaiting_input` is only emitted when a version DOES persist
// them; running/idle/error always work. The terminal still shows the live prompt.
package status

import (
	"bufio"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// codexSessionsDir is where codex writes its rollouts. A scoped CODEX_HOME
// (Flock hook injection, passed per-session) wins — codex then writes under
// <scoped>/sessions, so the tailer must follow it (the daemon's OWN env has no
// per-session CODEX_HOME). Falls back to a daemon-wide CODEX_HOME, then ~/.codex.
func codexSessionsDir(configDir string) string {
	if configDir != "" {
		return filepath.Join(configDir, "sessions")
	}
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return filepath.Join(h, "sessions")
	}
	return filepath.Join(homeDir(), ".codex", "sessions")
}

type rolloutLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexMeta struct {
	Cwd string `json:"cwd"` // used to match a rollout to its session (model lives in turn_context)
}

type taggedEvent struct {
	Type string `json:"type"`
}

func watchCodex(ctx context.Context, cwd, configDir string, startedAt time.Time, claim func(string) bool, emit func(Update), chat func(role, text string)) {
	dir := codexSessionsDir(configDir)
	path := waitForFile(ctx, func() string { return findCodexRollout(dir, cwd, startedAt, claim) })
	if path == "" {
		return
	}
	e := NewEmitter(emit)
	tailLines(ctx, path, func(b []byte) {
		if chat != nil {
			for _, m := range codexLineToChat(b) {
				chat(m.Role, m.Text)
			}
		}
		if u, ok := codexLineToUpdate(b); ok {
			e.Push(u)
		}
	})
}

// codexLineToChat pulls a whole assistant/user message out of a codex `event_msg`
// rollout line (agent_message / user_message). Lenient about the text field name.
func codexLineToChat(b []byte) []ChatMsg {
	var rl rolloutLine
	if json.Unmarshal(b, &rl) != nil || rl.Type != "event_msg" {
		return nil
	}
	var ev struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		Text    string `json:"text"`
	}
	if json.Unmarshal(rl.Payload, &ev) != nil {
		return nil
	}
	text := strings.TrimSpace(firstNonEmpty(ev.Message, ev.Text))
	if text == "" {
		return nil
	}
	switch ev.Type {
	case "agent_message":
		return []ChatMsg{{Role: "assistant", Text: text}}
	case "user_message":
		return []ChatMsg{{Role: "user", Text: text}}
	}
	return nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// findCodexRollout picks THIS session's rollout: among *.jsonl whose session_meta
// cwd matches and start-ts isn't long before startedAt, it takes the closest
// start-ts that `claim` will reserve — so concurrent same-cwd sessions each grab a
// distinct file instead of crossing streams.
func findCodexRollout(dir, cwd string, startedAt time.Time, claim func(string) bool) string {
	type cand struct {
		path string
		skew time.Duration
	}
	var cands []cand
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".jsonl") {
			return nil
		}
		// Cheap mtime pre-filter BEFORE opening+parsing every rollout: a file not
		// written since this session started can't be its rollout. Skips O(all
		// historical sessions) of open+JSON-parse on every discovery poll.
		if info, e := d.Info(); e != nil || info.ModTime().Before(startedAt.Add(-3*time.Second)) {
			return nil
		}
		mcwd, ts, ok := codexFirstLine(p)
		if !ok || mcwd != cwd || ts.Before(startedAt.Add(-3*time.Second)) {
			return nil
		}
		skew := ts.Sub(startedAt)
		if skew < 0 {
			skew = -skew
		}
		cands = append(cands, cand{p, skew})
		return nil
	})
	sort.Slice(cands, func(i, j int) bool { return cands[i].skew < cands[j].skew })
	for _, c := range cands {
		if claim(c.path) {
			return c.path
		}
	}
	return ""
}

// codexFirstLine finds the session_meta entry (its cwd + start time) by SCANNING
// the first lines, not by reading a fixed byte window: codex 0.137's session_meta
// line embeds `base_instructions`, pushing it well past 20 KB, so the old
// 8192-byte read TRUNCATED the JSON → Unmarshal failed → every rollout was
// skipped → codex got no status OR telemetry. We use a bufio.Scanner with a large
// buffer (like claudeFirstCwd) and take the first session_meta with a cwd.
func codexFirstLine(path string) (cwd string, ts time.Time, ok bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", time.Time{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // session_meta can be tens of KB
	for i := 0; i < 16 && sc.Scan(); i++ {
		var rl rolloutLine
		if json.Unmarshal(sc.Bytes(), &rl) != nil || rl.Type != "session_meta" {
			continue
		}
		var meta codexMeta
		if json.Unmarshal(rl.Payload, &meta) != nil || meta.Cwd == "" {
			continue
		}
		t, _ := time.Parse(time.RFC3339, rl.Timestamp)
		return meta.Cwd, t, true
	}
	return "", time.Time{}, false
}

// codexLineToUpdate maps one rollout line to a state, or ok=false to ignore it.
func codexLineToUpdate(b []byte) (Update, bool) {
	var rl rolloutLine
	if json.Unmarshal(b, &rl) != nil {
		return Update{}, false
	}
	// T19/T59: the model name lives in `turn_context` events (one per turn), NOT in
	// session_meta (which only carries cwd/model_provider in current Codex). Each
	// turn_context re-asserts the active model, so we pick it up even if it changes.
	if rl.Type == "turn_context" {
		var p struct {
			Model string `json:"model"`
		}
		if json.Unmarshal(rl.Payload, &p) == nil && p.Model != "" {
			return Update{Model: p.Model}, true
		}
		return Update{}, false
	}
	// T62: Codex's task list rides its `update_plan` tool, recorded as a
	// response_item function_call whose `arguments` is a JSON string
	// {"plan":[{"step","status"}]}. Normalize to Flock's plan shape.
	if rl.Type == "response_item" {
		if plan := codexPlanFromResponseItem(rl.Payload); plan != "" {
			return Update{Plan: plan}, true
		}
		return Update{}, false
	}
	if rl.Type != "event_msg" {
		return Update{}, false
	}
	var ev taggedEvent
	if json.Unmarshal(rl.Payload, &ev) != nil {
		return Update{}, false
	}
	switch ev.Type {
	case "task_started", "turn_started", "user_message",
		"agent_message", "agent_reasoning", "agent_reasoning_raw_content",
		"exec_command_begin", "exec_command_end",
		"patch_apply_begin", "patch_apply_end",
		"mcp_tool_call_begin", "mcp_tool_call_end",
		"web_search_begin", "web_search_end":
		return Update{State: StateRunning}, true
	case "task_complete", "turn_complete", "turn_aborted":
		return Update{State: StateIdle}, true
	case "exec_approval_request", "apply_patch_approval_request",
		"request_permissions", "request_user_input",
		"elicitation_request", "dynamic_tool_call_request":
		return Update{State: StateAwaiting}, true
	case "error", "stream_error":
		return Update{State: StateError}, true
	case "token_count":
		total, ctx, limit := codexTokens(rl.Payload)
		if total > 0 || ctx > 0 || limit > 0 {
			return Update{Tokens: total, ContextTokens: ctx, ContextLimit: limit}, true
		}
		return Update{}, false
	default:
		return Update{}, false
	}
}

// codexPlanFromResponseItem extracts Codex's `update_plan` task list from a
// response_item payload and returns it as a JSON array of {"content","status"}
// (Flock's PlanItem shape), or "" if this item isn't an update_plan call. Codex
// statuses map: in_progress/completed pass through; anything else → pending.
func codexPlanFromResponseItem(payload []byte) string {
	var ri struct {
		Type      string `json:"type"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	}
	if json.Unmarshal(payload, &ri) != nil || ri.Type != "function_call" || ri.Name != "update_plan" {
		return ""
	}
	var args struct {
		Plan []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"plan"`
	}
	if json.Unmarshal([]byte(ri.Arguments), &args) != nil {
		return ""
	}
	type item struct {
		Content string `json:"content"`
		Status  string `json:"status"`
	}
	out := make([]item, 0, len(args.Plan))
	for _, p := range args.Plan {
		if p.Step == "" {
			continue
		}
		st := "pending"
		if p.Status == "in_progress" || p.Status == "completed" {
			st = p.Status
		}
		out = append(out, item{Content: p.Step, Status: st})
	}
	if len(out) == 0 {
		return ""
	}
	b, err := json.Marshal(out)
	if err != nil {
		return ""
	}
	return string(b)
}

// codexTokens pulls, from a Codex `token_count` payload's `info`:
//   - total: the session's CUMULATIVE token usage (for cost) = total_token_usage.total_tokens
//   - contextTokens: the latest turn's prompt size = last_token_usage.input_tokens
//     (Codex's input_tokens ALREADY INCLUDES cached_input_tokens, so we do NOT add
//     cached — that would double-count; verified against real rollouts).
//   - contextLimit: info.model_context_window — Codex's own context window, so the
//     orchestrator can show an EXACT context-% instead of a table estimate.
// `info` can be null (rate-limit-only token_count events) → all zeros.
func codexTokens(payload []byte) (total int, contextTokens int, contextLimit int) {
	type usage struct {
		InputTokens           int `json:"input_tokens"`
		CachedInputTokens     int `json:"cached_input_tokens"`
		OutputTokens          int `json:"output_tokens"`
		ReasoningOutputTokens int `json:"reasoning_output_tokens"`
		TotalTokens           int `json:"total_tokens"`
	}
	var p struct {
		Info *struct {
			TotalTokenUsage    usage `json:"total_token_usage"`
			LastTokenUsage     usage `json:"last_token_usage"`
			ModelContextWindow int   `json:"model_context_window"`
		} `json:"info"`
	}
	if json.Unmarshal(payload, &p) != nil || p.Info == nil {
		return 0, 0, 0
	}
	t := p.Info.TotalTokenUsage
	total = t.TotalTokens
	if total == 0 {
		total = t.InputTokens + t.OutputTokens + t.ReasoningOutputTokens
	}
	// last_token_usage.input_tokens is the full prompt the model just saw (cached
	// included) = current context occupancy.
	contextTokens = p.Info.LastTokenUsage.InputTokens
	contextLimit = p.Info.ModelContextWindow
	return total, contextTokens, contextLimit
}
