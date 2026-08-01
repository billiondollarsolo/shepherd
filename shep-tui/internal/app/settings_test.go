package app

import (
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

// settingsModel is a paddock whose config lives in a temp dir, so persistence
// can be asserted without touching the developer's real config.toml.
func settingsModel(t *testing.T, cfg *config.Config) Model {
	t.Helper()
	t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())
	t.Setenv("NO_COLOR", "")
	t.Setenv("SHEP_TUI_REDUCED_MOTION", "")
	t.Setenv("FLOCK_REDUCED_MOTION", "")
	t.Setenv("PREFERS_REDUCED_MOTION", "")
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       testLocalCaps(),
		Cfg:        cfg,
		Sessions: []domain.Session{
			{ID: "alpha", Name: "Alpha", Status: domain.StatusIdle},
			{ID: "beta", Name: "Beta", Status: domain.StatusIdle},
		},
	})
	m.width, m.height = 120, 40
	return m
}

// The [ui] block used to be decorative: every value here was ignored.
func TestConfigDrivesTheModel(t *testing.T) {
	cfg := config.Default()
	cfg.UI.Theme = "flock-light"
	cfg.UI.ReducedMotion = true
	cfg.UI.PenDefaultLayout = "rows"
	cfg.UI.Scrollback = 25

	m := settingsModel(t, cfg)

	if m.themeName != "flock-light" || m.theme.Name != theme.NameLight {
		t.Fatalf("theme = %q / %q, want flock-light", m.themeName, m.theme.Name)
	}
	if !m.reducedMotion {
		t.Fatal("reduced_motion = true must reach the model")
	}
	if m.pen.Layout != domain.PenLayoutRows {
		t.Fatalf("layout = %q, want rows", m.pen.Layout)
	}

	s := m.panes[0].screen
	for i := 0; i < 100; i++ {
		_, _ = s.Write([]byte("line\r\n"))
	}
	if got := s.ScrollbackLen(); got > 25 {
		t.Fatalf("scrollback len = %d, want ≤ configured 25", got)
	}
	if got := s.ScrollbackLen(); got == 0 {
		t.Fatal("scrollback captured nothing")
	}
}

// ui.scrollback owns the drawer's history too: a drawer pinned to its own depth
// silently loses output the config said to keep.
func TestScrollbackReachesTheShellDrawer(t *testing.T) {
	cfg := config.Default()
	cfg.UI.Scrollback = 50
	m := settingsModel(t, cfg)

	nm, _ := m.showShellDrawer()
	m = nm.(Model)
	for i := 0; i < 200; i++ {
		_, _ = m.shellScreen.Write([]byte("line\r\n"))
	}
	if got := m.shellScreen.ScrollbackLen(); got == 0 || got > 50 {
		t.Fatalf("drawer scrollback = %d, want ≤ the configured 50", got)
	}

	// And a live change from the Settings row reaches it.
	m.applyScrollback(5000)
	for i := 0; i < 200; i++ {
		_, _ = m.shellScreen.Write([]byte("line\r\n"))
	}
	if got := m.shellScreen.ScrollbackLen(); got <= 50 {
		t.Fatalf("drawer kept the old cap after a settings change: %d", got)
	}
}

func TestReducedMotionEnvOverridesConfig(t *testing.T) {
	cfg := config.Default()
	cfg.UI.ReducedMotion = true
	m := settingsModel(t, cfg)
	if !m.reducedMotion {
		t.Fatal("config reduced motion ignored")
	}

	t.Setenv("SHEP_TUI_REDUCED_MOTION", "0")
	m = newModel(Options{Version: "test", SkipSplash: true, Cfg: cfg})
	if m.reducedMotion {
		t.Fatal("SHEP_TUI_REDUCED_MOTION=0 must override the config value")
	}
}

func TestSettingsSurfaceCyclesThemeAndPersists(t *testing.T) {
	m := settingsModel(t, config.Default())

	nm, _ := m.openSettings()
	m = nm.(Model)
	if m.stage != StageSettings {
		t.Fatalf("stage = %s, want settings", m.stage)
	}

	// Enter on the theme row: auto → flock-dark, applied and saved.
	next, cmd := m.Update(keyMsg("enter"))
	m = next.(Model)
	if m.themeName != theme.NameDark || m.cfg.UI.Theme != theme.NameDark {
		t.Fatalf("theme after enter = %q / %q", m.themeName, m.cfg.UI.Theme)
	}
	if !m.settingsDirty {
		t.Fatal("theme change must mark settings dirty for the exit save")
	}
	if cmd == nil {
		t.Fatal("theme change must return a persist cmd")
	}
	saved := false
	_, seen := pump(t, m, cmd)
	for _, msg := range seen {
		s, ok := msg.(settingsSavedMsg)
		if !ok {
			continue
		}
		if s.err != nil {
			t.Fatalf("persist failed: %v", s.err)
		}
		saved = true
	}
	if !saved {
		t.Fatal("theme change did not write config.toml")
	}

	got, err := config.LoadRaw()
	if err != nil {
		t.Fatal(err)
	}
	if got.UI.Theme != theme.NameDark {
		t.Fatalf("config.toml theme = %q, want %q", got.UI.Theme, theme.NameDark)
	}
}

// The palette theme action and the settings row are one path: both must restyle
// the widgets that cached the old colors.
func TestThemeChangeRestylesWidgets(t *testing.T) {
	m := settingsModel(t, config.Default())
	before := m.palInput.PromptStyle.GetForeground()

	nm, _ := m.cycleTheme() // auto → flock-dark
	m = nm.(Model)
	nm, _ = m.cycleTheme() // flock-dark → flock-light
	m = nm.(Model)

	if m.themeName != theme.NameLight {
		t.Fatalf("theme = %q", m.themeName)
	}
	after := m.palInput.PromptStyle.GetForeground()
	if after == before {
		t.Fatal("palette input kept the old theme's ink after a theme change")
	}
	if after != theme.DefaultLight().Accent {
		t.Fatalf("palette prompt = %v, want the light accent", after)
	}
}

func TestSettingsRowsToggleConfig(t *testing.T) {
	m := settingsModel(t, config.Default())
	nm, _ := m.openSettingsAt(settingRowScrollback)
	m = nm.(Model)

	m = press(m, "enter")
	if m.cfg.UI.Scrollback != 50000 {
		t.Fatalf("scrollback = %d, want the next step up from 10000", m.cfg.UI.Scrollback)
	}

	nm, _ = m.openSettingsAt(settingRowMouse)
	m = nm.(Model)
	m = press(m, "enter")
	if m.cfg.UI.Mouse {
		t.Fatal("mouse row must toggle the config value")
	}

	nm, _ = m.openSettingsAt(settingRowKeybinds)
	m = nm.(Model)
	m = press(m, "enter")
	if m.cfg.Keybinds.Preset != "vim" {
		t.Fatalf("keybind preset = %q, want vim", m.cfg.Keybinds.Preset)
	}
	if seq := m.km.Sequence(keybinds.ActionFocusNext); len(seq) == 0 || seq[0] != "ctrl+w" {
		t.Fatalf("preset change must rebuild the live keymap: focus-next = %v", seq)
	}

	nm, _ = m.openSettingsAt(settingRowPenLayout)
	m = nm.(Model)
	m = press(m, "enter")
	if m.pen.Layout == domain.PenLayoutGrid2x2 {
		t.Fatalf("pen layout unchanged: %q", m.pen.Layout)
	}
	if p, ok := m.st.Pen(m.pen.ID); !ok || p.Layout != m.pen.Layout {
		t.Fatalf("layout not stored: %+v", p)
	}
}

func TestSettingsReachableFromPalette(t *testing.T) {
	m := settingsModel(t, config.Default())
	nm, _ := m.openPalette()
	m = nm.(Model)
	m.paletteQuery = "settings"
	m.rebuildPaletteItems()
	if len(m.paletteItems) == 0 {
		t.Fatal("palette has no settings entry")
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = next.(Model)
	if m.stage != StageSettings {
		t.Fatalf("stage = %s, want settings", m.stage)
	}
	if !strings.Contains(m.View(), "Settings") {
		t.Fatal("settings surface not rendered")
	}
	if !strings.Contains(m.View(), "config dir") {
		t.Fatal("settings surface must show the doctor readout")
	}
}

func TestPaletteSetsPenLayout(t *testing.T) {
	m := settingsModel(t, config.Default())
	nm, _ := m.setPenLayout(domain.PenLayoutMainStack)
	m = nm.(Model)
	if m.pen.Layout != domain.PenLayoutMainStack {
		t.Fatalf("layout = %q", m.pen.Layout)
	}
}

// The env and flag layers are per-invocation. Changing an unrelated setting must
// not bake them into the user's file: a --profile run that persisted
// default_profile leaves the app pointing at a profile that is not in the file,
// and refusing to start.
func TestSaveDoesNotPersistTheEnvOrFlagLayer(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)
	t.Setenv("SHEP_TUI_PROFILE", "")

	onDisk := config.Default()
	onDisk.DefaultProfile = "local"
	onDisk.UI.Theme = theme.NameAuto
	onDisk.UI.Scrollback = 10000
	if err := config.Save(onDisk); err != nil {
		t.Fatal(err)
	}

	// The running config as the env and the flags left it.
	t.Setenv("SHEP_TUI_PROFILE", "work")
	live, err := config.LoadRaw()
	if err != nil {
		t.Fatal(err)
	}
	live.Profiles["work"] = config.Profile{Mode: config.ModeLocal}
	live.DefaultProfile = "work"
	live.UI.Theme = theme.NameLight
	live.UI.Scrollback = 50000

	m := newModel(Options{Version: "test", SkipSplash: true, Cfg: live})
	nm, cmd := m.openSettingsAt(settingRowMouse)
	m = nm.(Model)
	next, cmd := m.Update(keyMsg("enter"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("the mouse row must persist")
	}
	if _, seen := pump(t, m, cmd); len(seen) == 0 {
		t.Fatal("no save ran")
	}

	got, err := config.LoadRaw()
	if err != nil {
		t.Fatal(err)
	}
	if got.UI.Mouse != m.cfg.UI.Mouse {
		t.Fatalf("the edited setting was not saved: mouse = %v", got.UI.Mouse)
	}
	if got.DefaultProfile != "local" {
		t.Fatalf("default_profile = %q — an env/flag profile was written to the file", got.DefaultProfile)
	}
	if got.UI.Theme != theme.NameAuto {
		t.Fatalf("theme = %q — the --theme layer was written to the file", got.UI.Theme)
	}
	if got.UI.Scrollback != 10000 {
		t.Fatalf("scrollback = %d — the --scrollback layer was written to the file", got.UI.Scrollback)
	}
}

// A deliberate change to a setting still persists, even while a flag overrides it.
func TestSavePersistsAnExplicitThemeChange(t *testing.T) {
	m := settingsModel(t, config.Default())
	nm, cmd := m.cycleTheme()
	m = nm.(Model)
	if _, seen := pump(t, m, cmd); len(seen) == 0 {
		t.Fatal("no save ran")
	}
	got, err := config.LoadRaw()
	if err != nil {
		t.Fatal(err)
	}
	if got.UI.Theme != m.cfg.UI.Theme {
		t.Fatalf("config.toml theme = %q, want the chosen %q", got.UI.Theme, m.cfg.UI.Theme)
	}
}

// The env pins reduced motion over config.toml, so the row can neither apply a
// toggle nor keep it. It says so instead of persisting a value the app is not
// running on.
func TestReducedMotionEnvPinRefusesToggle(t *testing.T) {
	t.Setenv("SHEP_TUI_CONFIG_DIR", t.TempDir())
	t.Setenv("SHEP_TUI_REDUCED_MOTION", "1")
	cfg := config.Default()
	cfg.UI.ReducedMotion = true

	m := newModel(Options{Version: "test", SkipSplash: true, Cfg: cfg})
	nm, cmd := m.advanceSetting(settingRowReducedMotion)
	m = nm.(Model)
	if !m.reducedMotion || !m.cfg.UI.ReducedMotion {
		t.Fatal("an env-pinned preference must not be toggled or persisted away")
	}
	if cmd != nil {
		t.Fatal("a refused toggle must not write config.toml")
	}
	if !strings.Contains(m.toast.text, "SHEP_TUI_REDUCED_MOTION") {
		t.Fatalf("the toast must name the var that pins it: %q", m.toast.text)
	}
}

// The table cursor belongs to the old profile's sessions; left past the end of
// the new list, enter on the table is a silent no-op.
func TestProfileSwitchClampsTableCursor(t *testing.T) {
	cfg := config.Default()
	cfg.Profiles["fleet"] = config.Profile{Mode: config.ModeLocal}
	m := settingsModel(t, cfg)
	m.be = &attachBackend{}
	m.region = RegionMain
	m.table.SetCursor(5)

	next, _ := m.Update(profileSwitchedMsg{
		profile: "fleet",
		be:      &attachBackend{},
		sessions: []domain.Session{
			{ID: "s1", Name: "one", Status: domain.StatusAwaitingInput},
			{ID: "s2", Name: "two", Status: domain.StatusAwaitingInput},
		},
	})
	m = next.(Model)
	if n := m.table.Len(); m.table.Cursor() >= n {
		t.Fatalf("table cursor = %d, out of range for a table of %d rows", m.table.Cursor(), n)
	}
	if m.table.SelectedSessionID() == "" {
		t.Fatal("the table cursor must land on a session of the new profile")
	}
}

// A failed re-dial must leave the app on the backend it already has.
func TestProfileSwitchFailureKeepsBackend(t *testing.T) {
	m := settingsModel(t, config.Default())
	be := &attachBackend{}
	m.be = be

	next, _ := m.Update(profileSwitchedMsg{profile: "fleet", err: errors.New("connection refused")})
	m = next.(Model)
	if m.be != backend.Backend(be) {
		t.Fatal("failed dial must not replace the backend")
	}
	if !strings.Contains(m.toast.text, "fleet") {
		t.Fatalf("statusMsg = %q, want the failed profile named", m.toast.text)
	}
}
