// Claude Code status from its session transcript JSONL
// (~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl). Each line is a
// conversation entry: {"type":"user"|"assistant"|...,"cwd":"...","message":{...}}.
// Claude's transcript is the CONVERSATION (not lifecycle events), so we derive
// state from who spoke last + the assistant's stop_reason:
//
//	assistant stop_reason "tool_use"            → running  (a tool is being run)
//	assistant stop_reason end_turn/stop/max     → idle     (your turn now)
//	assistant streaming (no stop_reason yet)    → running
//	user (prompt or tool_result)                → running  (agent will work)
//	error                                       → error
//
// (Permission prompts aren't in the transcript, so "awaiting_input" needs hooks;
// running/idle/error cover the bulk of "what's going on".) Parsing is lenient.
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

// claudeProjectsDir is where claude writes its transcripts. When Flock seeds a
// scoped CLAUDE_CONFIG_DIR (for hook injection), claude writes under
// <scoped>/projects — NOT ~/.claude/projects — so the tailer MUST follow the
// session's scoped dir or it never sees the transcript (→ no tokens/model/ctx%).
func claudeProjectsDir(configDir string) string {
	if configDir != "" {
		return filepath.Join(configDir, "projects")
	}
	return filepath.Join(homeDir(), ".claude", "projects")
}

type claudeLine struct {
	Type    string `json:"type"`
	Cwd     string `json:"cwd"`
	Message struct {
		Model      string  `json:"model"` // T19: e.g. "claude-opus-4-8"
		StopReason *string `json:"stop_reason"`
		Usage      struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

func watchClaude(ctx context.Context, cwd, configDir string, startedAt time.Time, claim func(string) bool, emit func(Update)) {
	dir := claudeProjectsDir(configDir)
	path := waitForFile(ctx, func() string { return findClaudeTranscript(dir, cwd, startedAt, claim) })
	if path == "" {
		return
	}
	e := NewEmitter(emit)
	total := 0 // Claude reports per-message usage; accumulate to a session total.
	tailLines(ctx, path, func(b []byte) {
		u, ok := claudeLineToUpdate(b)
		if !ok {
			return
		}
		if u.Tokens > 0 {
			total += u.Tokens
			u.Tokens = total
		}
		e.Push(u)
	})
}

// findClaudeTranscript finds this session's transcript by CONTENT (the `cwd`
// field in its entries) rather than trusting the slug encoding. Among matches
// written after start, it takes the newest that `claim` will reserve — so two
// sessions in the same cwd each tail their own transcript.
func findClaudeTranscript(dir, cwd string, startedAt time.Time, claim func(string) bool) string {
	type cand struct {
		path string
		mod  time.Time
	}
	var cands []cand
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".jsonl") {
			return nil
		}
		info, e := d.Info()
		if e != nil || info.ModTime().Before(startedAt.Add(-3*time.Second)) {
			return nil
		}
		if claudeFirstCwd(p) != cwd {
			return nil
		}
		cands = append(cands, cand{p, info.ModTime()})
		return nil
	})
	sort.Slice(cands, func(i, j int) bool { return cands[i].mod.After(cands[j].mod) }) // newest first
	for _, c := range cands {
		if claim(c.path) {
			return c.path
		}
	}
	return ""
}

// claudeFirstCwd returns the session's cwd from the transcript. It scans the first
// lines for the first entry that carries a cwd rather than trusting line 1: newer
// claude (2.1.x) PREPENDS metadata lines (`last-prompt`, `mode`, `permission-mode`)
// that have NO cwd, so reading only line 1 returned "" → the transcript never
// matched the session → no claude tokens/model/context% (the bug this fixes).
func claudeFirstCwd(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // assistant lines can be large
	for i := 0; i < 500 && sc.Scan(); i++ {
		var cl claudeLine
		if json.Unmarshal(sc.Bytes(), &cl) == nil && cl.Cwd != "" {
			return cl.Cwd
		}
	}
	return ""
}

func claudeLineToUpdate(b []byte) (Update, bool) {
	var cl claudeLine
	if json.Unmarshal(b, &cl) != nil {
		return Update{}, false
	}
	switch cl.Type {
	case "assistant": {
		u := cl.Message.Usage
		out := Update{
			Tokens: u.InputTokens + u.OutputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens,
			Tool:   claudeToolFromContent(cl.Message.Content),
			Model:  cl.Message.Model,
			// T19: context occupancy = the prompt the model just saw (input + both
			// cache tiers), excluding the output it generated.
			ContextTokens: u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens,
		}
		sr := ""
		if cl.Message.StopReason != nil {
			sr = *cl.Message.StopReason
		}
		switch sr {
		case "end_turn", "stop_sequence", "max_tokens":
			out.State = StateIdle
		default: // "tool_use", or streaming (no stop_reason yet)
			out.State = StateRunning
		}
		return out, true
	}
	case "user":
		return Update{State: StateRunning}, true
	case "error":
		return Update{State: StateError}, true
	default: // system, summary, etc. — no state change
		return Update{}, false
	}
}

// claudeToolFromContent returns a short label for the last tool_use block in an
// assistant message's content array, e.g. "Edit app.ts" or "Bash: npm test".
func claudeToolFromContent(raw json.RawMessage) string {
	var blocks []struct {
		Type  string         `json:"type"`
		Name  string         `json:"name"`
		Input map[string]any `json:"input"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	label := ""
	for _, b := range blocks {
		if b.Type != "tool_use" || b.Name == "" {
			continue
		}
		if p, ok := strVal(b.Input, "file_path", "path", "notebook_path"); ok {
			label = b.Name + " " + filepath.Base(p)
		} else if c, ok := strVal(b.Input, "command"); ok {
			label = b.Name + ": " + truncate(c, 48)
		} else if q, ok := strVal(b.Input, "pattern", "query", "url"); ok {
			label = b.Name + " " + truncate(q, 48)
		} else {
			label = b.Name
		}
	}
	return label
}

func strVal(m map[string]any, keys ...string) (string, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if s, ok2 := v.(string); ok2 && s != "" {
				return s, true
			}
		}
	}
	return "", false
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
