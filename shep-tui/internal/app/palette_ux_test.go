package app

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	"github.com/billiondollarsolo/shep-tui/internal/store"
)

// paletteCaps is a local backend that can do everything the catalog offers.
func paletteCaps() backend.Caps {
	caps := testLocalCaps()
	caps.Cost = true
	return caps
}

func TestPaletteGroupsAndSettingsDiscoverable(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       paletteCaps(),
		Sessions: []domain.Session{
			{ID: "s1", Name: "One", Status: domain.StatusIdle},
		},
	})
	m.width, m.height = 100, 36
	m.st = store.New()
	_, _ = m.st.CreatePen("(default)", "p1", "Main", domain.PenLayoutCols)

	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyCtrlK})
	m = next.(Model)
	if m.stage != StagePalette {
		t.Fatalf("stage=%s", m.stage)
	}

	groups := map[string]bool{}
	var settingsIDs []string
	for _, it := range m.paletteItems {
		if it.Group == "" {
			t.Fatalf("item %s missing group", it.ID)
		}
		groups[it.Group] = true
		if it.Group == palGroupSettings {
			settingsIDs = append(settingsIDs, it.ID)
		}
	}
	for _, want := range []string{
		palGroupNavigate, palGroupAgents, palGroupPens,
		palGroupInspect, palGroupSettings, palGroupSessions,
	} {
		if !groups[want] {
			t.Fatalf("missing group %q in %v", want, groups)
		}
	}
	// Settings must include theme, help, quit — easy to find.
	need := map[string]bool{"action:theme": false, "action:help": false, "action:quit": false}
	for _, id := range settingsIDs {
		if _, ok := need[id]; ok {
			need[id] = true
		}
	}
	for id, ok := range need {
		if !ok {
			t.Fatalf("settings missing %s: %v", id, settingsIDs)
		}
	}

	// Filter "set" surfaces settings (theme/settings group).
	m.paletteQuery = "set"
	m.paletteCursor = 0
	m.rebuildPaletteItems()
	if len(m.paletteItems) == 0 {
		t.Fatal("filter set: no matches")
	}
	foundTheme := false
	for _, it := range m.paletteItems {
		if it.ID == "action:theme" {
			foundTheme = true
		}
		// Should not dump unrelated sessions when filtering settings-ish.
		if it.Kind == "session" && !strings.Contains(strings.ToLower(it.Label), "set") {
			// sessions only if they match "set" in name — our s1 "One" should be out
			t.Fatalf("unexpected non-settings hit for set filter: %+v", it)
		}
	}
	if !foundTheme {
		t.Fatalf("theme not in set filter: %+v", m.paletteItems)
	}

	// Render is bottom-docked and shows group headers + nav footer.
	view := m.View()
	for _, needle := range []string{"Command palette", "SETTINGS", "↑↓", "esc"} {
		if !strings.Contains(view, needle) {
			t.Fatalf("palette view missing %q\n%s", needle, view)
		}
	}
}

func TestPaletteTabJumpsGroups(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Caps: paletteCaps()})
	m.width, m.height = 80, 30
	m.rebuildPaletteItems()
	if len(m.paletteItems) < 4 {
		t.Fatalf("catalog too small: %d", len(m.paletteItems))
	}
	m.stage = StagePalette
	m.paletteCursor = 0
	firstGroup := m.paletteItems[0].Group
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyTab})
	m = next.(Model)
	if m.paletteItems[m.paletteCursor].Group == firstGroup && len(m.paletteItems) > 1 {
		// Only fail if there is a later group
		hasLater := false
		for _, it := range m.paletteItems {
			if it.Group != firstGroup {
				hasLater = true
				break
			}
		}
		if hasLater {
			t.Fatalf("tab should jump to next group, still %q at %d", firstGroup, m.paletteCursor)
		}
	}
}

func TestPaletteSelectHelp(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Caps: paletteCaps()})
	m.width, m.height = 80, 24
	m.rebuildPaletteItems()
	found := -1
	for i, it := range m.paletteItems {
		if it.ID == "action:help" {
			found = i
			break
		}
	}
	if found < 0 {
		t.Fatal("help action missing")
	}
	m.paletteCursor = found
	m.stage = StagePalette
	next, _ := m.runPaletteSelection()
	m = next.(Model)
	if m.stage != StageHelp {
		t.Fatalf("help overlay not opened from palette: stage=%s", m.stage)
	}
}

// The header is keys and the backend it is talking to, and nothing else: what an
// agent is doing belongs on the agent, in the table, where the user selected it.
func TestChromeHeaderIsKeysNotSessionData(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       paletteCaps(),
		Sessions: []domain.Session{
			{ID: "s1", Name: "Agent", Status: domain.StatusRunning, Telemetry: domain.Telemetry{Model: "opus"}},
		},
	})
	m.applySize(100, 30)
	head := renderHeader(m)
	if !strings.Contains(head, "<ctrl+k>") || !strings.Contains(head, "Command") {
		t.Fatalf("missing palette hint: %s", head)
	}
	for _, bad := range []string{"Working", "opus"} {
		if strings.Contains(head, bad) {
			t.Fatalf("the header carries session data (%q): %s", bad, head)
		}
	}
	// The bottom row is the toast's, and the toast is empty.
	if strings.TrimSpace(renderToastRow(m)) != "" {
		t.Fatalf("the bottom row is not empty: %q", renderToastRow(m))
	}
}

func TestPaletteWindowKeepsCursorVisible(t *testing.T) {
	start, end := visibleWindow(20, 15, 6)
	if start > 15 || end <= 15 {
		t.Fatalf("cursor 15 not in window [%d,%d)", start, end)
	}
	if end-start > 6 {
		t.Fatalf("window too large: %d", end-start)
	}
}

func TestPaletteEnterOnZeroMatchesIsNoOp(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Caps: paletteCaps()})
	m.width, m.height = 100, 36
	next, _ := m.openPalette()
	m = next.(Model)

	for _, r := range "zzzz" {
		next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = next.(Model)
	}
	if len(m.paletteItems) != 0 {
		t.Fatalf("expected no matches, got %d", len(m.paletteItems))
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.stage != StagePalette {
		t.Fatalf("enter on zero matches left the palette: stage=%s", m.stage)
	}
	if m.paletteQuery != "zzzz" {
		t.Fatalf("query lost: %q", m.paletteQuery)
	}
}

func TestPaletteCoversChromeActions(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       paletteCaps(),
		Sessions: []domain.Session{
			{ID: "s1", Name: "One", Status: domain.StatusIdle},
			{ID: "s2", Name: "Two", Status: domain.StatusIdle},
		},
	})
	m.width, m.height = 100, 36
	m.rebuildPaletteItems()

	byID := map[string]paletteItem{}
	for _, it := range m.paletteItems {
		byID[it.ID] = it
	}
	for _, want := range []string{
		"action:zen", "action:shell", "action:focusshell",
		"action:region:next", "action:region:prev",
		"action:pane:1", "action:pane:2",
	} {
		if _, ok := byID[want]; !ok {
			t.Fatalf("palette missing %s", want)
		}
	}
	// Chips come from the live keymap, not a hand-typed table.
	if got := byID["action:zen"].Hint; got != keybinds.FormatChord(m.km.Sequence(keybinds.ActionZen)) {
		t.Fatalf("zen chip = %q", got)
	}
	if got := byID["action:shell"].Hint; got != keybinds.FormatChord(m.km.Sequence(keybinds.ActionShellDrawer)) {
		t.Fatalf("shell chip = %q", got)
	}
}

func TestPaletteRunsZenAndPaneFocus(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       paletteCaps(),
		Sessions: []domain.Session{
			{ID: "s1", Name: "One", Status: domain.StatusIdle},
			{ID: "s2", Name: "Two", Status: domain.StatusIdle},
		},
	})
	m.width, m.height = 100, 36

	m = runPaletteItem(t, m, "action:zen")
	if m.stage != StageZen {
		t.Fatalf("stage = %s after palette zen", m.stage)
	}
	m = runPaletteItem(t, m, "action:pane:2")
	if m.focus != 1 || m.region != RegionMain {
		t.Fatalf("focus=%d region=%s after palette pane 2", m.focus, m.region)
	}
}

func runPaletteItem(t *testing.T, m Model, id string) Model {
	t.Helper()
	next, _ := m.openPalette()
	m = next.(Model)
	for i, it := range m.paletteItems {
		if it.ID == id {
			m.paletteCursor = i
			next, _ = m.runPaletteSelection()
			return next.(Model)
		}
	}
	t.Fatalf("palette has no %s", id)
	return m
}
