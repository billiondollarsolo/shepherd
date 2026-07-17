// Antigravity CLI (`agy`) status + chat from its per-conversation transcript
// JSONL. agy writes one brain directory per conversation:
//
//	~/.gemini/antigravity-cli/brain/<conv-id>/.system_generated/logs/transcript.jsonl
//
// Each line is a step:
//
//	{"step_index":N,"source":"USER_EXPLICIT|MODEL|SYSTEM","type":"USER_INPUT|PLANNER_RESPONSE|...","status":"...","content":<string|object>}
//
// We derive conversation messages + coarse state from who spoke last:
//
//	USER_EXPLICIT/USER_INPUT              → user  message + running (agent will work)
//	MODEL/PLANNER_RESPONSE (status DONE)  → assistant message + idle (your turn)
//	MODEL/PLANNER_RESPONSE (streaming)    → assistant message + running
//	SYSTEM (history/checkpoint)           → skip
//	status ERROR/FAILED                   → error
//
// Like claude/codex this is the CONVERSATION, not lifecycle events, so parsing is
// lenient and unknown shapes are ignored rather than fatal.
package status

import (
	"context"
	"encoding/json"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// antigravityBrainDir is where agy writes its per-conversation transcripts. agy is
// not config-dir-scoped the way claude/codex are (no CLAUDE_CONFIG_DIR analogue we
// inject), so we always read under the node user's home.
func antigravityBrainDir(home string) string {
	return filepath.Join(homeOr(home), ".gemini", "antigravity-cli", "brain")
}

type agyLine struct {
	StepIndex int             `json:"step_index"`
	Source    string          `json:"source"`
	Type      string          `json:"type"`
	Status    string          `json:"status"`
	Content   json.RawMessage `json:"content"`
}

func watchAntigravity(ctx context.Context, cwd, configDir, home string, startedAt time.Time, claim func(string) bool, emit func(Update), chat func(role, text string)) {
	dir := antigravityBrainDir(home)
	path := waitForFile(ctx, func() string { return findAntigravityTranscript(dir, startedAt, claim) })
	if path == "" {
		return
	}
	e := NewEmitter(emit)
	tailLines(ctx, path, func(b []byte) {
		if chat != nil {
			for _, m := range antigravityLineToChat(b) {
				chat(m.Role, m.Text)
			}
		}
		if u, ok := antigravityLineToUpdate(b); ok {
			e.Push(u)
		}
	})
}

// findAntigravityTranscript picks this session's transcript. agy's transcript lines
// carry no cwd, so (unlike claude) we can't match by content — we take the newest
// transcript.jsonl created at/after the session start that `claim` will reserve, so
// two agy sessions each tail a distinct conversation.
func findAntigravityTranscript(dir string, startedAt time.Time, claim func(string) bool) string {
	type cand struct {
		path string
		mod  time.Time
	}
	var cands []cand
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || filepath.Base(p) != "transcript.jsonl" {
			return nil
		}
		info, e := d.Info()
		if e != nil || info.ModTime().Before(startedAt.Add(-3*time.Second)) {
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

// antigravityLineToChat extracts the conversation message from one transcript step:
// a user prompt or an assistant planner response. Returns nil for system/history
// and other non-conversational steps.
func antigravityLineToChat(b []byte) []ChatMsg {
	var l agyLine
	if json.Unmarshal(b, &l) != nil {
		return nil
	}
	switch {
	case l.Source == "USER_EXPLICIT" && l.Type == "USER_INPUT":
		if txt := stripUserRequest(agyContentString(l.Content)); txt != "" {
			return []ChatMsg{{Role: "user", Text: txt}}
		}
	case l.Source == "MODEL" && l.Type == "PLANNER_RESPONSE":
		if txt := strings.TrimSpace(agyContentString(l.Content)); txt != "" {
			return []ChatMsg{{Role: "assistant", Text: txt}}
		}
	}
	return nil
}

func antigravityLineToUpdate(b []byte) (Update, bool) {
	var l agyLine
	if json.Unmarshal(b, &l) != nil {
		return Update{}, false
	}
	switch strings.ToUpper(l.Status) {
	case "ERROR", "FAILED":
		return Update{State: StateError}, true
	}
	switch {
	case l.Type == "USER_INPUT":
		return Update{State: StateRunning}, true
	case l.Source == "MODEL" && l.Type == "PLANNER_RESPONSE":
		if strings.EqualFold(l.Status, "DONE") || strings.EqualFold(l.Status, "COMPLETE") {
			return Update{State: StateIdle}, true
		}
		return Update{State: StateRunning}, true
	default:
		return Update{}, false
	}
}

// agyContentString normalizes a step's `content`, which is usually a plain string
// but may be an object carrying a `.text` field.
func agyContentString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		return obj.Text
	}
	return ""
}

// stripUserRequest unwraps agy's user prompt. User input is wrapped as
// `<USER_REQUEST>…</USER_REQUEST>` optionally followed by `<ADDITIONAL_METADATA>…`
// (and similar) tag blocks; we return the request body only.
func stripUserRequest(s string) string {
	if i := strings.Index(s, "<USER_REQUEST>"); i >= 0 {
		rest := s[i+len("<USER_REQUEST>"):]
		if j := strings.Index(rest, "</USER_REQUEST>"); j >= 0 {
			return strings.TrimSpace(rest[:j])
		}
		return strings.TrimSpace(rest)
	}
	// No wrapper — drop any trailing metadata tag blocks and trim.
	if i := strings.Index(s, "<ADDITIONAL_METADATA>"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}
