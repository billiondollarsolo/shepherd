// Package agentresume builds native agent resume commands after agentd restart (H3.3).
// Does not claim PTY continuity — new process with conversation restore.
package agentresume

import "fmt"

// Ref is a persisted native session reference.
type Ref struct {
	AgentKind string // claude, codex, opencode, grok, cursor, …
	SessionID string // native id/path
	Cwd       string
}

// Command returns argv to resume, or nil if unsupported/incomplete.
func Command(r Ref) []string {
	if r.SessionID == "" || r.AgentKind == "" {
		return nil
	}
	switch r.AgentKind {
	case "claude":
		return []string{"claude", "--resume", r.SessionID}
	case "codex":
		return []string{"codex", "resume", r.SessionID}
	case "opencode":
		return []string{"opencode", "--session", r.SessionID}
	case "grok":
		return []string{"grok", "--resume", r.SessionID}
	case "cursor", "cursor-agent":
		return []string{"cursor-agent", "--resume", r.SessionID}
	case "agy", "antigravity":
		return []string{"agy", "--continue"}
	default:
		return nil
	}
}

// Describe is a human-readable summary for diagnostics.
func Describe(r Ref) string {
	cmd := Command(r)
	if cmd == nil {
		return fmt.Sprintf("unsupported resume for %s", r.AgentKind)
	}
	return fmt.Sprintf("%v (cwd=%s)", cmd, r.Cwd)
}
