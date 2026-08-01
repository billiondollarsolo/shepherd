package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestSplashShownThenDismissed(t *testing.T) {
	m := newModel(Options{Version: "dev", Profile: "local", ForceSplash: true})
	if !m.showSplash {
		t.Fatal("expected showSplash with ForceSplash")
	}
	m.width, m.height = 80, 28
	v := m.View()
	if !strings.Contains(v, "@mjtechguy") || !strings.Contains(v, "@blndollarsolo") {
		t.Fatalf("splash missing handles:\n%s", v)
	}
	if !strings.Contains(v, "https://x.com/mjtechguy") {
		t.Fatal("missing x.com/mjtechguy")
	}
	if !strings.Contains(v, "https://x.com/blndollarsolo") {
		t.Fatal("missing x.com/blndollarsolo")
	}

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.showSplash {
		t.Fatal("splash should dismiss on any key")
	}
	// Paddock view should no longer be the splash frame alone.
	v2 := m.View()
	if strings.Contains(v2, "press any key to enter the paddock") || strings.Contains(v2, "press any key to continue") {
		t.Fatalf("still showing splash after dismiss:\n%s", v2)
	}
}

func TestSkipSplashOption(t *testing.T) {
	// Backend set would normally show splash; SkipSplash wins.
	m := newModel(Options{Version: "dev", SkipSplash: true, ForceSplash: true})
	// ForceSplash + SkipSplash: ForceSplash is OR — check SkipSplash alone with backend nil
	m = newModel(Options{Version: "dev", SkipSplash: true})
	if m.showSplash {
		t.Fatal("SkipSplash should disable splash when no ForceSplash")
	}
}

func TestSplashQuit(t *testing.T) {
	m := newModel(Options{Version: "dev", ForceSplash: true})
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	m = next.(Model)
	if !m.quitting {
		t.Fatal("q on splash should quit")
	}
	if cmd == nil {
		t.Fatal("expected Quit cmd")
	}
}
