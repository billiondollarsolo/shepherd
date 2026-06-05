// Package status derives a coding agent's live status by tailing the transcript
// the agent ALREADY writes on the node — Codex rollout JSONL, Claude Code session
// JSONL, OpenCode storage. This is pure observation: we read files the agent
// writes anyway, touching nothing (no hooks, no config, no auth) — exactly the
// "leverage what's on the node" model. The daemon is the natural place for it
// (it's on the node with filesystem access) and streams the normalized status
// back to the orchestrator over the existing protocol.
//
// The normalized states match Flock's Status enum so they flow straight into the
// orchestrator's StatusMap → /ws/status → the paddock dots:
//
//	running        — a turn is in progress (model thinking / tool running)
//	awaiting_input — the agent is blocked on YOU (approval / question)
//	idle           — turn complete, waiting for your next message
//	error          — the turn errored
//
// (`starting`/`done` are owned by the session lifecycle, not the transcript.)
package status

import (
	"bufio"
	"context"
	"io"
	"os"
	"path/filepath"
	"time"
)

// Normalized status states (subset of Flock's Status enum the transcript can prove).
const (
	StateRunning   = "running"
	StateAwaiting  = "awaiting_input"
	StateIdle      = "idle"
	StateError     = "error"
)

// Update is a partial status change for a session. Empty/zero fields mean
// "unchanged" (tokens only ever increase, so 0 = no info this line; an empty
// State/Tool = leave as-is). The emitter merges partials into a running snapshot.
type Update struct {
	State  string // running|awaiting_input|idle|error, or "" = unchanged
	Tokens int    // cumulative tokens this session, or 0 = unchanged
	Tool   string // current tool/command (e.g. "Edit app.ts"), or "" = unchanged
	// T19 — richer telemetry. Model is the agent's model name (e.g.
	// "claude-opus-4-8"); "" = unchanged. ContextTokens is the most recent turn's
	// prompt size (input + cache tokens) = current context-window occupancy, which
	// the orchestrator turns into a context-% against the model's limit; 0 = unchanged.
	Model         string
	ContextTokens int
	// ContextLimit is the model's context window in tokens WHEN THE AGENT REPORTS IT
	// (Codex emits `model_context_window`); 0 = unknown → the orchestrator falls
	// back to its model-info table. Lets context-% be exact rather than estimated.
	ContextLimit int
	// Plan (T62) is the agent's current task list as a JSON array of
	// {"content","status"} (status ∈ pending|in_progress|completed); "" = unchanged.
	// Codex emits it via its `update_plan` tool (in the transcript); the orchestrator
	// turns a changed plan into the same `plan` artifact Claude's TodoWrite produces.
	Plan string
}

// DetectAgent maps a session's argv to the agent whose transcript we can tail, or
// "" if none (a plain shell / generic session has no transcript).
func DetectAgent(command []string) string {
	if len(command) == 0 {
		return ""
	}
	switch filepath.Base(command[0]) {
	case "claude":
		return "claude"
	case "codex":
		return "codex"
	// T21: OpenCode is intentionally NOT tailed here. Its on-disk store is a sea of
	// small JSON files (no JSONL), so the old heuristic was node-global mtime
	// activity — which CLOBBERED per-session status and couldn't express
	// awaiting_input/error. OpenCode now reports accurate PER-SESSION status via its
	// hook plugin (T1) → the orchestrator's OpenCode translator, exactly like
	// claude/codex hooks. So we return "" (no transcript watcher) and let hooks own it.
	default:
		return ""
	}
}

// Watch tails the agent's transcript for one session and calls emit on every
// state change (deduped) until ctx is cancelled. cwd is the session working dir
// (used to locate the right transcript); startedAt bounds the search to the file
// this session created. `claim` reserves a transcript path for THIS session so
// two sessions in the SAME cwd each tail a distinct file (returns false if
// another session already claimed it). Unknown agents are a no-op.
// configDir is the session's scoped agent-config dir (Flock hook injection), or
// "" — the transcript tailers must follow it because claude/codex write their
// transcripts under that scoped dir, not the default ~/.claude · ~/.codex.
func Watch(ctx context.Context, agent, cwd, configDir string, startedAt time.Time, claim func(string) bool, emit func(Update)) {
	switch agent {
	case "codex":
		watchCodex(ctx, cwd, configDir, startedAt, claim, emit)
	case "claude":
		watchClaude(ctx, cwd, configDir, startedAt, claim, emit)
	// "opencode" is handled via its hook plugin (T1/T21), not transcript tailing.
	}
}

// homeDir resolves the node user's home (where agents store their transcripts).
func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return os.Getenv("HOME")
}

// pollInterval is how often watchers poll for a new transcript file / new lines.
// Cheap (local fs) and well under human reaction time.
const pollInterval = 400 * time.Millisecond

// waitForFile polls until `find` returns a non-empty path or ctx is cancelled.
func waitForFile(ctx context.Context, find func() string) string {
	for {
		if p := find(); p != "" {
			return p
		}
		select {
		case <-ctx.Done():
			return ""
		case <-time.After(pollInterval):
		}
	}
}

// tailLines reads existing lines then follows appends (tail -f) until ctx is
// cancelled, calling onLine for each complete line. It re-reads from the current
// offset on EOF after a short sleep. Returns when ctx is done.
func tailLines(ctx context.Context, path string, onLine func([]byte)) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	reader := bufio.NewReader(f)
	var pending []byte
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			pending = append(pending, line...)
			if line[len(line)-1] == '\n' {
				onLine(pending[:len(pending)-1])
				pending = nil
			}
		}
		if err == io.EOF {
			select {
			case <-ctx.Done():
				return
			case <-time.After(pollInterval):
			}
			continue
		}
		if err != nil {
			return
		}
	}
}

// Emitter merges partial Updates into a running per-session snapshot and emits
// the FULL snapshot whenever any field changes (state, tokens, or tool); empty/
// zero partial fields are ignored (= unchanged). Exported so the activity-status
// watcher (session package) reuses the SAME dedup primitive as the transcript
// watchers instead of a parallel one.
type Emitter struct {
	state         string
	tokens        int
	tool          string
	model         string
	contextTokens int
	contextLimit  int
	plan          string
	emit          func(Update)
}

// NewEmitter builds an Emitter that calls emit with the full snapshot on change.
func NewEmitter(emit func(Update)) *Emitter { return &Emitter{emit: emit} }

// Push merges a partial Update and emits the full snapshot if anything changed.
func (e *Emitter) Push(u Update) {
	changed := false
	if u.State != "" && u.State != e.state {
		e.state = u.State
		changed = true
	}
	if u.Tokens > 0 && u.Tokens != e.tokens {
		e.tokens = u.Tokens
		changed = true
	}
	if u.Tool != "" && u.Tool != e.tool {
		e.tool = u.Tool
		changed = true
	}
	if u.Model != "" && u.Model != e.model {
		e.model = u.Model
		changed = true
	}
	// Context occupancy can rise OR fall (compaction), so any nonzero new value counts.
	if u.ContextTokens > 0 && u.ContextTokens != e.contextTokens {
		e.contextTokens = u.ContextTokens
		changed = true
	}
	if u.ContextLimit > 0 && u.ContextLimit != e.contextLimit {
		e.contextLimit = u.ContextLimit
		changed = true
	}
	if u.Plan != "" && u.Plan != e.plan {
		e.plan = u.Plan
		changed = true
	}
	if changed {
		e.emit(Update{
			State:         e.state,
			Tokens:        e.tokens,
			Tool:          e.tool,
			Model:         e.model,
			ContextTokens: e.contextTokens,
			ContextLimit:  e.contextLimit,
			Plan:          e.plan,
		})
	}
}
