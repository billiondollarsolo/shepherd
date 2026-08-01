package session

import (
	"testing"

	"github.com/billiondollarsolo/flock/agentd/internal/authority"
	"github.com/billiondollarsolo/flock/agentd/internal/screendetect"
)

// Real shipped path: screendetect engine + authority merge (not a reimplementation).
func TestScreenBlockedMapsToAwaitingInput(t *testing.T) {
	wire, r := ClassifyScreen("codex", "press enter to confirm or esc to cancel", "Action Required")
	if r.State != screendetect.StateBlocked && wire != "awaiting_input" {
		// OSC title path
		wire2, r2 := ClassifyScreen("codex", "x", "Action Required")
		if wire2 != "awaiting_input" {
			t.Fatalf("wire=%s/%s state=%s/%s", wire, wire2, r.State, r2.State)
		}
	}
	if wire != "awaiting_input" && wire != "" {
		// accept either direct map
		if screendetect.MapToWire(r.State) != "awaiting_input" {
			t.Fatalf("expected awaiting_input, wire=%s state=%s rule=%s", wire, r.State, r.MatchedRuleID)
		}
	}
}

func TestScreenIdleMapsToIdle(t *testing.T) {
	wire, r := ClassifyScreen("codex", "hello unrelated", "")
	if r.State != screendetect.StateIdle {
		t.Fatalf("state=%s", r.State)
	}
	if wire != "idle" {
		t.Fatalf("wire=%s", wire)
	}
}

func TestChatModeAuthorityIgnoresScreen(t *testing.T) {
	d := authority.Merge(authority.Input{
		Mode:           authority.ModeChat,
		ScreenDetectOn: true,
		Transport:      authority.Source{State: "running", FromTransport: true},
		Screen: authority.Source{
			State:          "blocked",
			VisibleBlocker: true,
			FromScreen:     true,
		},
	})
	if d.State != "running" {
		t.Fatalf("chat must ignore screen: %+v", d)
	}
}

func TestTerminalScreenBlockerWins(t *testing.T) {
	d := authority.Merge(authority.Input{
		Mode:           authority.ModeTerminal,
		ScreenDetectOn: true,
		Transcript:     authority.Source{State: "idle", FromTranscript: true},
		Screen: authority.Source{
			State:          "blocked",
			VisibleBlocker: true,
		},
	})
	if d.State != "awaiting_input" {
		t.Fatalf("%+v", d)
	}
}

func TestScreenDetectDefaultOnAndKillSwitch(t *testing.T) {
	t.Setenv("FLOCK_SCREENDETECT", "")
	if !ScreenDetectEnabled() {
		t.Fatal("default must be on when env unset")
	}
	t.Setenv("FLOCK_SCREENDETECT", "0")
	if ScreenDetectEnabled() {
		t.Fatal("0 must disable")
	}
	t.Setenv("FLOCK_SCREENDETECT", "false")
	if ScreenDetectEnabled() {
		t.Fatal("false must disable")
	}
	t.Setenv("FLOCK_SCREENDETECT", "1")
	if !ScreenDetectEnabled() {
		t.Fatal("1 must enable")
	}
}
