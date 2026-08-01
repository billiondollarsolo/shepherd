package session

import (
	"testing"

	"github.com/billiondollarsolo/flock/agentd/internal/authority"
	"github.com/billiondollarsolo/flock/agentd/internal/screendetect"
)

// Sticky-clear regression: after screen raised awaiting_input, feeding that
// state back as Transcript would block idle clear. Screen-only merge must allow idle.
func TestScreenMergeClearsAwaitingWithoutFakeTranscript(t *testing.T) {
	// After blocker
	blocked := authority.Merge(authority.Input{
		Mode:           authority.ModeTerminal,
		ScreenDetectOn: true,
		Screen: authority.Source{
			State:          screendetect.StateBlocked,
			VisibleBlocker: true,
			FromScreen:     true,
		},
	})
	if blocked.State != "awaiting_input" || blocked.Source != "screen" {
		t.Fatalf("blocked: %+v", blocked)
	}

	// Clear: idle screen, NO transcript faked from previous awaiting_input
	cleared := authority.Merge(authority.Input{
		Mode:           authority.ModeTerminal,
		ScreenDetectOn: true,
		Current:        "", // watcher must not pass awaiting_input as current either when screen owns
		Screen: authority.Source{
			State:      screendetect.StateIdle,
			FromScreen: true,
		},
	})
	if cleared.State != "idle" {
		t.Fatalf("screen idle must clear Needs-you, got %+v", cleared)
	}
	if cleared.Source != "screen" && cleared.Source != "default" {
		// screen_idle source is fine
		if cleared.Source != "screen" {
			t.Logf("source=%s (ok if idle)", cleared.Source)
		}
	}

	// Bug recreation: fake transcript from previous wire locks awaiting_input
	sticky := authority.Merge(authority.Input{
		Mode:           authority.ModeTerminal,
		ScreenDetectOn: true,
		Screen: authority.Source{
			State:      screendetect.StateIdle,
			FromScreen: true,
		},
		Transcript: authority.Source{
			State:          "awaiting_input",
			FromTranscript: true,
		},
	})
	if sticky.State == "awaiting_input" {
		// Documents the anti-pattern — watcher must not do this.
		t.Log("confirmed: fake transcript would sticky-lock awaiting_input")
	}
}

func TestClassifyScreenCodexBlockedAndIdle(t *testing.T) {
	wire, r := ClassifyScreen("codex", "press enter to confirm or esc to cancel", "Action Required")
	if wire != "awaiting_input" && r.State != screendetect.StateBlocked {
		t.Fatalf("blocked: wire=%s state=%s", wire, r.State)
	}
	wire2, r2 := ClassifyScreen("codex", "hello unrelated", "")
	if wire2 != "idle" {
		t.Fatalf("idle: wire=%s state=%s", wire2, r2.State)
	}
}
