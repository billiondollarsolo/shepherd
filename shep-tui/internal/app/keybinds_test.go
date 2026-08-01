package app

import (
	"os"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
)

const (
	docPath      = "../../docs/KEYBINDS.md"
	docBeginMark = "<!-- BEGIN GENERATED KEYBINDS -->"
	docEndMark   = "<!-- END GENERATED KEYBINDS -->"
)

// TestKeybindsDocInSync: the chrome table in docs/KEYBINDS.md is generated from
// the registry. A rebind that does not reach the docs is a lie to the user.
func TestKeybindsDocInSync(t *testing.T) {
	raw, err := os.ReadFile(docPath)
	if err != nil {
		t.Fatal(err)
	}
	doc := string(raw)
	start := strings.Index(doc, docBeginMark)
	end := strings.Index(doc, docEndMark)
	if start < 0 || end < start {
		t.Fatalf("%s is missing the generated keybind markers", docPath)
	}
	got := strings.TrimSpace(doc[start+len(docBeginMark) : end])
	want := strings.TrimSpace(keybinds.MarkdownTable(keybinds.Default(), chromeHelpActions()))
	if got != want {
		t.Fatalf("%s is stale. Replace the block between the markers with:\n\n%s", docPath, want)
	}
}

// TestKeyMapParity: help can only advertise binds the app dispatches, and every
// bind the app dispatches comes from the registry. Every shipped preset is
// walked: the vim and tmux presets bind pane focus and the palette to chords
// only, so a keyMap field alone proves nothing about whether they work.
func TestKeyMapParity(t *testing.T) {
	presets := map[string]keybinds.Map{
		"default": keybinds.Default(),
		"vim":     keybinds.Vim(),
		"tmux":    keybinds.Tmux(),
	}
	for name, km := range presets {
		t.Run(name, func(t *testing.T) {
			k := buildKeyMap(km)
			for action, binding := range keyMapFields(&k) {
				for _, key := range binding.Keys() {
					// A chord-only action is keyed on its joined sequence so help can
					// list it; it resolves through the chord engine, not Lookup.
					if seq := strings.Fields(key); len(seq) > 1 {
						got, ok := km.Resolve(seq)
						if !ok || got != action {
							t.Fatalf("%s: chord %q resolves to %q", action, key, got)
						}
						continue
					}
					got, ok := km.Resolve([]string{key})
					if !ok || got != action {
						t.Fatalf("%s: key %q resolves to %q — two handlers claim it", action, key, got)
					}
				}
			}
			// A chord-only action reaches no key.Matches: the engine is its only
			// dispatcher, and runChordAction is where it goes.
			for _, action := range chordActions(km) {
				seq := km.Sequence(action)
				got, ok := km.Resolve(seq)
				if !ok || got != action {
					t.Fatalf("%s: chord %v resolves to %q", action, seq, got)
				}
			}
			// Everything help lists must have a live dispatch path on some surface.
			m := newModel(Options{Version: "test", SkipSplash: true, Keys: km,
				Caps:     testLocalCaps(),
				Sessions: []domain.Session{{ID: "s1"}, {ID: "s2"}}})
			for _, action := range chromeHelpActions() {
				if !dispatchable(m, action) {
					t.Fatalf("help lists %s, which nothing dispatches under the %s preset",
						action, name)
				}
			}
		})
	}
}

// dispatchable reports that some handler serves action: chrome runs it, or input
// mode swallows it as a detach/drawer chord.
func dispatchable(m Model, action keybinds.Action) bool {
	if _, _, ok := m.runAction(action); ok {
		return true
	}
	for _, a := range inputChordActions {
		if a == action {
			return true
		}
	}
	return false
}

// A chord-bound action must reach the same handler its single-key alternate
// would: the vim and tmux presets are nothing but chords, and a chord engine
// with a hand-picked switch left them as dead keys that help still advertised.
func TestChordOnlyPresetsDispatch(t *testing.T) {
	sessions := []domain.Session{{ID: "s1"}, {ID: "s2"}}

	m := newModel(Options{Version: "test", SkipSplash: true, Keys: keybinds.Vim(), Sessions: sessions})
	m.nPanes = 2
	m = press(m, "ctrl+w")
	m = press(m, "w")
	if m.focus != 1 {
		t.Fatalf("vim ctrl+w w: focus = %d, want pane 2", m.focus)
	}
	m = press(m, "ctrl+w")
	m = press(m, "p")
	if m.focus != 0 {
		t.Fatalf("vim ctrl+w p: focus = %d, want pane 1", m.focus)
	}

	tm := newModel(Options{Version: "test", SkipSplash: true, Keys: keybinds.Tmux(), Sessions: sessions})
	tm.nPanes = 2
	tm = press(tm, "ctrl+b")
	tm = press(tm, "n")
	if tm.focus != 1 {
		t.Fatalf("tmux ctrl+b n: focus = %d, want pane 2", tm.focus)
	}
	tm = press(tm, "ctrl+b")
	tm = press(tm, ":")
	if tm.stage != StagePalette {
		t.Fatalf("tmux ctrl+b : did not open the palette: stage = %s", tm.stage)
	}
}

// The keymap is the registry's, not a second table: rebinding an action moves
// the key the app actually dispatches.
func TestRebindingMovesTheHandler(t *testing.T) {
	km := keybinds.Merge(keybinds.Default(), keybinds.Map{
		keybinds.ActionZen:         {{"v"}},
		keybinds.ActionShellDrawer: {{"m", "a"}},
	})
	// Chat is off: its verb is bare "m", which is the prefix this test rebinds
	// the drawer chord onto.
	caps := testLocalCaps()
	caps.Chat = false
	m := newModel(Options{Version: "test", SkipSplash: true, Keys: km,
		Caps:     caps,
		Sessions: []domain.Session{{ID: "s1"}}})

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'z'}})
	if next.(Model).stage == StageZen {
		t.Fatal("z still zens after being rebound to v")
	}
	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'v'}})
	if next.(Model).stage != StageZen {
		t.Fatalf("v did not zen: stage = %s", next.(Model).stage)
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'m'}})
	m2 := next.(Model)
	if len(m2.pending) != 1 {
		t.Fatalf("rebound chord did not arm: pending = %v", m2.pending)
	}
	next, _ = m2.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	if !next.(Model).shellOpen {
		t.Fatal("rebound shell drawer chord did not open the drawer")
	}
}

// Help must describe the surface the user is on, not a constant list.
func TestHelpIsPerSurface(t *testing.T) {
	m := overlayModel(t)
	nm, _ := m.openPalette()
	m = nm.(Model)
	nm, _ = m.openHelp()
	m = nm.(Model)
	if got := helpContextFor(m); got != helpPalette {
		t.Fatalf("help context over the palette = %v", got)
	}
	out := renderHelp(m)
	if strings.Contains(out, "zen") {
		t.Fatalf("palette help advertises zen, which the palette does not dispatch:\n%s", out)
	}
	if !strings.Contains(out, "next group") {
		t.Fatalf("palette help omits the palette's own keys:\n%s", out)
	}
}
