package authority

import "testing"

func TestChatModeIgnoresScreenBlocker(t *testing.T) {
	d := Merge(Input{
		Mode:           ModeChat,
		ScreenDetectOn: true,
		Transport:      Source{State: "running", FromTransport: true},
		Screen: Source{
			State:          "blocked",
			VisibleBlocker: true,
			FromScreen:     true,
		},
	})
	if d.State != "running" {
		t.Fatalf("chat mode must not apply screen blocker: %+v", d)
	}
	if d.Source != "transport" {
		t.Fatalf("source=%s", d.Source)
	}
}

func TestTerminalVisibleBlockerWinsOverIdleTranscript(t *testing.T) {
	d := Merge(Input{
		Mode:           ModeTerminal,
		ScreenDetectOn: true,
		Transcript:     Source{State: "idle", FromTranscript: true},
		Screen: Source{
			State:          "blocked",
			VisibleBlocker: true,
			FromScreen:     true,
		},
	})
	if d.State != "awaiting_input" {
		t.Fatalf("want awaiting_input, got %+v", d)
	}
	if d.Source != "screen" {
		t.Fatalf("source=%s", d.Source)
	}
}

func TestLifecycleAuthoritySkipsScreen(t *testing.T) {
	d := Merge(Input{
		Mode:           ModeTerminal,
		ScreenDetectOn: true,
		Lifecycle: Source{
			State:           "running",
			LifecycleActive: true,
			FromHooks:       true,
		},
		Screen: Source{
			State:          "blocked",
			VisibleBlocker: true,
			FromScreen:     true,
		},
	})
	if d.State != "running" || d.Source != "lifecycle" {
		t.Fatalf("lifecycle should win: %+v", d)
	}
}

func TestScreenDetectOffIgnoresScreen(t *testing.T) {
	d := Merge(Input{
		Mode:           ModeTerminal,
		ScreenDetectOn: false,
		Transcript:     Source{State: "idle", FromTranscript: true},
		Screen: Source{
			State:          "blocked",
			VisibleBlocker: true,
		},
	})
	if d.State != "idle" {
		t.Fatalf("screen off should use transcript: %+v", d)
	}
}

func TestSkipStateUpdate(t *testing.T) {
	d := Merge(Input{
		Mode:           ModeTerminal,
		ScreenDetectOn: true,
		Current:        "running",
		Screen: Source{
			State:           "idle",
			SkipStateUpdate: true,
		},
	})
	// skip should not force idle from screen; fall through to current
	if d.State != "running" && d.Source != "current" {
		// activity/default paths
		if d.State == "idle" && d.Source == "screen" {
			t.Fatalf("skip_state_update applied screen: %+v", d)
		}
	}
}

func TestIsChatMode(t *testing.T) {
	for _, m := range []string{"claude-stream", "codex-app-server", "acp", "chat"} {
		if !IsChatMode(m) {
			t.Errorf("%s should be chat", m)
		}
	}
	if IsChatMode("pty") || IsChatMode("") {
		t.Fatal("pty should be terminal")
	}
}

func TestMapBlockedWire(t *testing.T) {
	if screenToWire("blocked") != "awaiting_input" {
		t.Fatal(screenToWire("blocked"))
	}
	if screenToWire("working") != "running" {
		t.Fatal(screenToWire("working"))
	}
}
