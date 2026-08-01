// Settings surface: the in-TUI view of config.toml.
//
// Every row here reads and writes the live *config.Config the paddock was
// started with, and every change is persisted by persistSettingsCmd — a setting
// you can change but not keep is worse than no setting at all.
package app

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/backend/dial"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	"github.com/billiondollarsolo/shep-tui/internal/ui/motion"
	"github.com/billiondollarsolo/shep-tui/internal/ui/profiles"
	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
	"github.com/billiondollarsolo/shep-tui/internal/vt"
)

// settingRow is a row of the settings surface. Enter advances the row's value.
type settingRow int

const (
	settingRowTheme settingRow = iota
	settingRowProfile
	settingRowReducedMotion
	settingRowScrollback
	settingRowPenLayout
	settingRowKeybinds
	settingRowMouse
	settingRowCount
)

// scrollbackSteps are the values enter cycles through on the scrollback row.
var scrollbackSteps = []int{1000, 5000, 10000, 50000}

// penLayouts is the cycle order of the pen layout row (domain.PenLayout has no
// natural order of its own).
var penLayouts = []domain.PenLayout{
	domain.PenLayoutCols,
	domain.PenLayoutRows,
	domain.PenLayoutGrid2x2,
	domain.PenLayoutMainStack,
}

// keybindPresets is the cycle order of the keybind preset row.
var keybindPresets = []string{"default", "vim", "tmux"}

// settingsUI returns the settings the surface edits, never nil: a Model built
// by a test literal still renders and still answers keys.
func (m *Model) settingsUI() *config.Config {
	if m.cfg == nil {
		m.cfg = config.Default()
	}
	return m.cfg
}

func (m Model) openSettings() (tea.Model, tea.Cmd) {
	return m.openSettingsAt(settingRowTheme)
}

func (m Model) openSettingsAt(row settingRow) (tea.Model, tea.Cmd) {
	m.pushStage(StageSettings)
	m.settingsCursor = int(row)
	m.region = RegionMain
	return m, nil
}

func (m Model) handleSettingsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Esc):
		m.popStage()
		return m, nil
	case key.Matches(msg, m.keys.Up):
		m.settingsCursor = (m.settingsCursor - 1 + int(settingRowCount)) % int(settingRowCount)
		return m, nil
	case key.Matches(msg, m.keys.Down):
		m.settingsCursor = (m.settingsCursor + 1) % int(settingRowCount)
		return m, nil
	case key.Matches(msg, m.keys.Activate):
		return m.advanceSetting(settingRow(m.settingsCursor))
	}
	if mm, cmd, ok := m.handleGlobalKey(msg, false); ok {
		return mm, cmd
	}
	return m, nil
}

// advanceSetting applies the row's next value. Everything but the profile row
// takes effect immediately; a profile switch has to re-dial first.
func (m Model) advanceSetting(row settingRow) (tea.Model, tea.Cmd) {
	cfg := m.settingsUI()
	switch row {
	case settingRowTheme:
		return m.cycleTheme()

	case settingRowProfile:
		names := profiles.Names(cfg)
		if len(names) < 2 {
			m.notify("profile: no other profile configured")
			return m, nil
		}
		next := names[(indexOf(names, cfg.ActiveName())+1)%len(names)]
		m.notify("profile: dialing " + next + "…")
		return m, m.redialCmd(next)

	case settingRowReducedMotion:
		if name, on, pinned := motion.EnvPin(); pinned {
			// The env wins over config.toml, so a toggle here could neither take
			// effect now nor be honored next launch. Say so rather than persist a
			// value the app is not running on.
			m.notify(fmt.Sprintf("reduced motion: %s, pinned by %s — unset it to change this here", onOff(on), name))
			return m, nil
		}
		cfg.UI.ReducedMotion = !cfg.UI.ReducedMotion
		before := m.motionState()
		m.reducedMotion = motion.ReducedMotion(cfg.UI.ReducedMotion)
		m.settingsEdits.reducedMotion = true
		m.notify("reduced motion: " + onOff(cfg.UI.ReducedMotion))
		save := m.persistSettingsCmd()
		return m.armMotion(before, save)

	case settingRowScrollback:
		cfg.UI.Scrollback = nextScrollback(cfg.UI.Scrollback)
		m.applyScrollback(cfg.UI.Scrollback)
		m.settingsEdits.scrollback = true
		m.notify(fmt.Sprintf("scrollback: %d lines", cfg.UI.Scrollback))
		save := m.persistSettingsCmd()
		return m, save

	case settingRowPenLayout:
		cur := indexOf(penLayouts, m.pen.Layout)
		return m.setPenLayout(penLayouts[(cur+1)%len(penLayouts)])

	case settingRowKeybinds:
		cfg.Keybinds.Preset = keybindPresets[(indexOf(keybindPresets, cfg.Keybinds.Preset)+1)%len(keybindPresets)]
		m.km = keybinds.Preset(cfg.Keybinds.Preset)
		m.km.Sanitize()
		m.keys = buildKeyMap(m.km)
		m.clearChord()
		m.settingsEdits.keybinds = true
		m.notify("keybinds: " + cfg.Keybinds.Preset + " preset (keybinds.toml still applies over it at startup)")
		save := m.persistSettingsCmd()
		return m, save

	case settingRowMouse:
		cfg.UI.Mouse = !cfg.UI.Mouse
		m.settingsEdits.mouse = true
		m.notify("mouse: " + onOff(cfg.UI.Mouse))
		save := m.persistSettingsCmd()
		return m, save
	}
	return m, nil
}

// cycleTheme is the theme row and the palette's theme action: one path, so the
// widgets are restyled and the choice is persisted either way.
func (m Model) cycleTheme() (tea.Model, tea.Cmd) {
	cfg := m.settingsUI()
	cfg.UI.Theme = theme.Next(m.themeName)
	m.applyTheme(cfg.UI.Theme)
	m.settingsEdits.theme = true
	m.notify("theme: " + cfg.UI.Theme)
	save := m.persistSettingsCmd()
	return m, save
}

// setPenLayout re-lays the active pen (palette action:layout:* and the layout
// row). Choosing a layout is how the user asks for the grid, so it opens a slot
// for every session the pen holds — the stage otherwise stays on the one pane it
// started with and the layout has nothing to arrange.
func (m Model) setPenLayout(layout domain.PenLayout) (tea.Model, tea.Cmd) {
	m.pen.Layout = layout
	if m.st != nil && m.pen.ID != "" {
		if err := m.st.SetPenLayout(m.pen.ID, layout); err != nil {
			m.notifyErr("layout: " + err.Error())
			return m, nil
		}
	}
	nm, cmd := m.setPaneCount(len(m.pen.SessionIDs))
	m = nm.(Model)
	m.notify("pen layout: " + string(layout))
	return m, cmd
}

// setPaneCount opens n pen slots on the stage (1 = the focused agent alone) and
// attaches whatever the change brought into view.
func (m Model) setPaneCount(n int) (tea.Model, tea.Cmd) {
	m.nPanes = min(max(n, 1), domain.MaxPenSessions)
	if m.focus >= m.nPanes {
		m.focus = m.nPanes - 1
	}
	m.syncFocusSessionFromPane()
	m.resizeStreams()

	var cmds []tea.Cmd
	for i := 0; i < m.nPanes; i++ {
		if m.be == nil || m.panes[i].SessionID == "" || m.panes[i].Stream != nil {
			continue
		}
		cmds = append(cmds, m.attachPaneCmd(i, m.nextEpoch(i), m.panes[i].SessionID))
	}
	return m, tea.Batch(cmds...)
}

// applyScrollback re-caps the history of every pane. The VT screens keep the
// output they already hold; only the new limit changes.
func (m *Model) applyScrollback(n int) {
	if n <= 0 {
		n = vt.DefaultScrollback
	}
	for i := range m.panes {
		if s := m.panes[i].screen; s != nil {
			s.SetScrollback(n)
		}
	}
	if m.shellScreen != nil {
		m.shellScreen.SetScrollback(n)
	}
}

// settingsEdits records which settings the user changed in this session. The
// live *config.Config also carries the env layer (SHEP_TUI_PROFILE, FLOCK_URL)
// and the flag layer (--profile, --theme, --scrollback), and a one-off override
// must never become the persisted file value just because some unrelated row was
// toggled: only the fields marked here are written back.
type settingsEdits struct {
	theme         bool
	reducedMotion bool
	scrollback    bool
	keybinds      bool
	mouse         bool
	profile       bool
}

// persistSettingsCmd writes config.toml off the Update goroutine. It starts from
// LoadRaw so the env layer (FLOCK_URL, FLOCK_AGENTD_SECRET_FILE) is not baked into
// the user's file, and merges only the fields the surface actually edited.
func (m *Model) persistSettingsCmd() tea.Cmd {
	if m.cfg == nil {
		return nil
	}
	m.settingsDirty = true
	cfg := *m.cfg
	edits := m.settingsEdits
	return func() tea.Msg {
		return settingsSavedMsg{err: saveSettings(cfg, edits)}
	}
}

// saveSettings merges the settings the surface owns into the on-disk config.
// A field the user did not touch keeps whatever the file already said, even
// when the running config holds an env- or flag-derived value for it.
func saveSettings(from config.Config, edits settingsEdits) error {
	cfg, err := config.LoadRaw()
	if err != nil {
		return err
	}
	if edits.theme {
		cfg.UI.Theme = from.UI.Theme
	}
	if edits.reducedMotion {
		cfg.UI.ReducedMotion = from.UI.ReducedMotion
	}
	if edits.scrollback {
		cfg.UI.Scrollback = from.UI.Scrollback
	}
	if edits.mouse {
		cfg.UI.Mouse = from.UI.Mouse
	}
	if edits.keybinds {
		cfg.Keybinds = from.Keybinds
	}
	if edits.profile {
		// The file may not know the profile the env fabricated (FLOCK_URL can
		// synthesize one in memory); writing it would leave default_profile
		// pointing at a profile that is not there, and Validate would refuse to
		// start next launch.
		if _, ok := cfg.Profiles[from.DefaultProfile]; ok {
			cfg.DefaultProfile = from.DefaultProfile
		}
	}
	return config.Save(cfg)
}

// saveSettingsIfDirty is the exit path: tea.Quit can drop a persistSettingsCmd
// that has not run yet, and a setting that does not survive the quit that
// follows it may as well not exist.
func (m Model) saveSettingsIfDirty() {
	if !m.settingsDirty || m.cfg == nil {
		return
	}
	if err := saveSettings(*m.cfg, m.settingsEdits); err != nil {
		fmt.Fprintf(os.Stderr, "shep-tui: save settings: %v\n", err)
	}
}

// settingsSavedMsg reports the outcome of a config.toml write.
type settingsSavedMsg struct {
	err error
}

// profileSwitchedMsg carries the result of re-dialing another profile. On error
// the old backend is still live and stays the app's backend.
type profileSwitchedMsg struct {
	profile  string
	be       backend.Backend
	caps     backend.Caps
	sessions []domain.Session
	err      error
}

// dialCmd opens cfg's backend and lists its sessions off the Update goroutine,
// handing the outcome to done. The reconnect and profile-switch paths differ in
// the message they produce and in how they repopulate the panes — not in how
// they dial, and two copies of that is how one of them drifted.
func dialCmd(cfg *config.Config, done func(backend.Backend, backend.Caps, []domain.Session, error) tea.Msg) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		be, err := dial.Open(ctx, cfg)
		if err != nil {
			return done(nil, backend.Caps{}, nil, err)
		}
		lctx, lcancel := context.WithTimeout(context.Background(), 5*time.Second)
		sessions, err := be.ListSessions(lctx)
		lcancel()
		if err != nil {
			_ = be.Close()
			return done(nil, backend.Caps{}, nil, err)
		}
		return done(be, be.Capabilities(), sessions, nil)
	}
}

// redialCmd opens the named profile's backend off the Update goroutine.
func (m Model) redialCmd(name string) tea.Cmd {
	cfg := &config.Config{
		DefaultProfile: name,
		Profiles:       m.settingsUI().Profiles,
	}
	return dialCmd(cfg, func(be backend.Backend, caps backend.Caps, sessions []domain.Session, err error) tea.Msg {
		return profileSwitchedMsg{profile: name, be: be, caps: caps, sessions: sessions, err: err}
	})
}

// applyProfileSwitch adopts a backend dialed by redialCmd: the old streams point
// at the old machine, so they are dropped and the new profile's sessions are
// attached from scratch. The shell drawer is deliberately not carried over — it
// is a shell on the machine the user just left.
func (m Model) applyProfileSwitch(msg profileSwitchedMsg) (tea.Model, tea.Cmd) {
	old := m.be
	m.closeStreams()
	m.mode = ModeChrome

	if _, err := profiles.Switch(m.settingsUI(), msg.profile); err != nil {
		m.notifyErr(err.Error())
		return m, nil
	}
	m.settingsEdits.profile = true
	m.be = msg.be
	m.caps = msg.caps
	m.profile = msg.profile
	m.sessions = append([]domain.Session(nil), msg.sessions...)
	if m.st != nil {
		m.st.SeedSessions(m.sessions)
	}

	cmds := []tea.Cmd{closeBackendCmd(old), m.persistSettingsCmd()}
	seeded := PenPaneCount(m.sessions)
	m.nPanes = 1
	m.focus = 0
	m.pen.SessionIDs = nil
	for i := 0; i < domain.MaxPenSessions; i++ {
		m.panes[i].Stream = nil
		m.panes[i].SessionID = ""
		m.panes[i].Title = fmt.Sprintf("pane %d", i+1)
		m.panes[i].Status = domain.StatusDisconnected
		m.panes[i].AttachErr = ""
		m.panes[i].scrollOff = 0
		m.nextEpoch(i)
	}
	// The pen takes the new profile's sessions, but only the panes on the stage
	// get a PTY: the rest attach if and when the user opens the grid on them.
	for i := 0; i < seeded && i < len(m.sessions); i++ {
		var cmd tea.Cmd
		m, cmd = m.assignSessionToPane(i, m.sessions[i])
		if i < m.nPanes {
			cmds = append(cmds, cmd)
		}
	}
	m.syncTable()
	m.notifyOK(fmt.Sprintf("profile: %s (%d sessions)", msg.profile, len(m.sessions)))
	return m, tea.Batch(append(cmds, m.watchStatusCmd())...)
}

// watchStatusCmd is the single subscriber to a backend's status stream. A
// subscribe that fails enters the reconnect loop; it may never bare `return nil`,
// which would leave the app permanently unwatched.
//
// It opens a generation: the previous watch is cancelled, and everything the old
// one still delivers is stamped with a seq the handlers now drop. Without that,
// a replaced backend goes on pushing sessions that do not exist on the one the
// user is connected to into the tree.
func (m *Model) watchStatusCmd() tea.Cmd {
	be := m.be
	if be == nil {
		return nil
	}
	m.cancelWatch()
	m.watchSeq++
	seq := m.watchSeq
	ctx, cancel := context.WithCancel(context.Background())
	m.watchCancel = cancel
	return func() tea.Msg {
		ch, err := be.WatchStatus(ctx)
		if err != nil || ch == nil {
			return statusWatchClosedMsg{seq: seq}
		}
		return statusChMsg{ch: ch, seq: seq}
	}
}

// cancelWatch hangs up the live status subscription, if any.
func (m *Model) cancelWatch() {
	if m.watchCancel != nil {
		m.watchCancel()
		m.watchCancel = nil
	}
	m.statusCh = nil
}

// closeBackendCmd hangs up a replaced backend without blocking the UI on it.
func closeBackendCmd(be backend.Backend) tea.Cmd {
	if be == nil {
		return nil
	}
	return func() tea.Msg {
		_ = be.Close()
		return nil
	}
}

// settingsLines is the rendered surface: the editable rows, then a read-only
// doctor readout of what the app actually resolved.
func (m Model) settingsLines(cursor, innerW int) []string {
	th := m.th()
	cfg := m.cfg
	if cfg == nil {
		cfg = config.Default()
	}

	rows := [settingRowCount]struct{ label, value string }{
		settingRowTheme:         {"Theme", cfg.UI.Theme},
		settingRowProfile:       {"Profile", profileValue(cfg)},
		settingRowReducedMotion: {"Reduced motion", onOff(m.reducedMotion)},
		settingRowScrollback:    {"Scrollback", fmt.Sprintf("%d lines", cfg.UI.Scrollback)},
		settingRowPenLayout:     {"Pen layout", string(m.pen.Layout)},
		settingRowKeybinds:      {"Keybind preset", cfg.Keybinds.Preset},
		settingRowMouse:         {"Mouse", onOff(cfg.UI.Mouse)},
	}

	lines := make([]string, 0, int(settingRowCount)+8)
	for i, row := range rows {
		marker := "  "
		if i == cursor {
			marker = "▶ "
		}
		lines = append(lines, fmt.Sprintf("%s%-16s %s", marker, row.label, th.Title.Render(row.value)))
	}
	lines = append(lines, "", th.Muted.Render("enter changes the selected setting · saved to config.toml"), "")

	for _, l := range m.doctorLines() {
		lines = append(lines, th.Muted.Render(truncate(l, max(innerW-1, 1))))
	}
	return lines
}

// doctorLines is the non-interactive readout: what the app resolved, not what
// the file says.
func (m Model) doctorLines() []string {
	cfg := m.cfg
	if cfg == nil {
		cfg = config.Default()
	}
	active := cfg.Active()
	dir, err := config.Dir()
	if err != nil {
		dir = err.Error()
	}
	out := []string{
		"config dir:  " + dir,
		"backend:     " + string(active.Mode),
	}
	switch active.Mode {
	case config.ModeFleet:
		out = append(out, "url:         "+active.URL)
	default:
		out = append(out, "agentd sock: "+active.ResolvedSocket())
	}
	out = append(out, fmt.Sprintf("caps:        mode=%s multi_node=%v launch=%v git=%v cost=%v",
		m.caps.Mode, m.caps.MultiNode, m.caps.Launch, m.caps.Git, m.caps.Cost))
	for _, w := range cfg.Warnings {
		out = append(out, "warning:     "+w)
	}
	return out
}

func renderSettings(m Model, w, h int) string {
	th := m.th()
	box := panelBox(th, w, h, true)
	innerW := max(w-4, 1)
	innerH := max(h-4, 1)

	cursor := min(max(m.settingsCursor, 0), int(settingRowCount)-1)
	title := "Settings" + "  (enter change · esc back)"
	return box.Render(renderList(th, title, m.settingsLines(cursor, innerW), cursor, innerW, innerH))
}

func profileValue(cfg *config.Config) string {
	name := cfg.ActiveName()
	if name == "" {
		return cfg.DefaultProfile + " (not configured)"
	}
	return fmt.Sprintf("%s  (%d configured)", name, len(profiles.Names(cfg)))
}

func nextScrollback(cur int) int {
	for _, n := range scrollbackSteps {
		if n > cur {
			return n
		}
	}
	return scrollbackSteps[0]
}

func onOff(v bool) string {
	if v {
		return "on"
	}
	return "off"
}

func indexOf[T comparable](list []T, want T) int {
	for i, v := range list {
		if v == want {
			return i
		}
	}
	return -1
}
