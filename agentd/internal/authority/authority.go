// Package authority merges status sources per master improvement plan D4/D11.
package authority

import "strings"

// SessionMode distinguishes Terminal vs structured Chat transports.
type SessionMode string

const (
	ModeTerminal SessionMode = "terminal"
	ModeChat     SessionMode = "chat" // claude-stream, codex-app-server, acp
)

// Source is a partial status observation. Empty State means "no signal".
type Source struct {
	State string // wire status or screen idle/working/blocked
	// Screen-only flags
	VisibleBlocker  bool
	VisibleWorking  bool
	SkipStateUpdate bool
	// Authority markers
	LifecycleActive bool // full lifecycle hooks actively reporting
	FromScreen      bool
	FromTransport   bool // structured chat/ACP/stream
	FromTranscript  bool
	FromHooks       bool
	FromActivity    bool // PTY activity heuristic
}

// Input to the arbitrator.
type Input struct {
	Mode           SessionMode
	Current        string // current wire status
	Lifecycle      Source // hooks / full lifecycle
	Transport      Source // chat stream / ACP
	Screen         Source
	Transcript     Source
	Activity       Source
	ScreenDetectOn bool // feature flag (D10)
}

// Decision is the merged wire status.
type Decision struct {
	State  string
	Source string // which layer won
	Reason string
}

func screenToWire(s string) string {
	switch s {
	case "working":
		return "running"
	case "blocked":
		return "awaiting_input"
	case "idle":
		return "idle"
	case "unknown", "":
		return ""
	default:
		return s
	}
}

// Merge applies locked precedence.
//
// Chat mode (D11): transport owns status; screen is diagnostic-only.
// Terminal (D4): lifecycle (if active) > visible_blocker screen > transcript/hooks partial > PTY activity > idle fallback.
func Merge(in Input) Decision {
	mode := in.Mode
	if mode == "" {
		mode = ModeTerminal
	}

	if mode == ModeChat {
		if st := nonEmpty(in.Transport.State); st != "" {
			return Decision{State: st, Source: "transport", Reason: "chat_mode_transport_authority"}
		}
		if st := nonEmpty(in.Lifecycle.State); st != "" {
			return Decision{State: st, Source: "lifecycle", Reason: "chat_mode_lifecycle_fallback"}
		}
		if in.Current != "" {
			return Decision{State: in.Current, Source: "current", Reason: "chat_mode_hold"}
		}
		return Decision{State: "idle", Source: "default", Reason: "chat_mode_default_idle"}
	}

	// Terminal: full lifecycle authority skips screen
	if in.Lifecycle.LifecycleActive {
		if st := nonEmpty(in.Lifecycle.State); st != "" {
			return Decision{State: st, Source: "lifecycle", Reason: "lifecycle_authority_active"}
		}
	}

	if in.ScreenDetectOn && !in.Screen.SkipStateUpdate {
		wire := screenToWire(in.Screen.State)
		if in.Screen.VisibleBlocker || wire == "awaiting_input" {
			return Decision{State: "awaiting_input", Source: "screen", Reason: "visible_blocker_or_blocked"}
		}
		if !in.Lifecycle.LifecycleActive {
			if in.Screen.VisibleWorking || wire == "running" {
				return Decision{State: "running", Source: "screen", Reason: "visible_working"}
			}
		}
	}

	// Partial hooks / transcript
	if d := pickPartial(in.Lifecycle, "hooks"); d.State != "" {
		return d
	}
	if d := pickPartial(in.Transcript, "transcript"); d.State != "" {
		return d
	}

	// Screen idle after partials
	if in.ScreenDetectOn && !in.Screen.SkipStateUpdate && !in.Lifecycle.LifecycleActive {
		if wire := screenToWire(in.Screen.State); wire == "idle" {
			return Decision{State: "idle", Source: "screen", Reason: "screen_idle"}
		}
	}

	if in.Activity.FromActivity {
		if st := nonEmpty(in.Activity.State); st != "" {
			return Decision{State: st, Source: "activity", Reason: "pty_activity"}
		}
	}

	if in.Current != "" {
		return Decision{State: in.Current, Source: "current", Reason: "hold_current"}
	}
	return Decision{State: "idle", Source: "default", Reason: "idle_fallback"}
}

func pickPartial(s Source, src string) Decision {
	st := nonEmpty(s.State)
	if st == "" {
		return Decision{}
	}
	if s.FromHooks {
		src = "hooks"
	}
	if s.FromTranscript {
		src = "transcript"
	}
	return Decision{State: st, Source: src, Reason: "partial"}
}

func nonEmpty(s string) string {
	return strings.TrimSpace(s)
}

// IsChatMode reports whether a session Mode/transport string is structured Chat.
func IsChatMode(mode string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "chat", "claude-stream", "codex-app-server", "acp":
		return true
	default:
		return false
	}
}

// ModeFromSessionMode maps agentd open Mode field to SessionMode.
func ModeFromSessionMode(mode string) SessionMode {
	if IsChatMode(mode) {
		return ModeChat
	}
	return ModeTerminal
}
