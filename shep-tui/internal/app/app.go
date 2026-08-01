// Package app is the root Bubble Tea model for shep-tui: an agents table over
// the whole terminal, and the agent terminal it drills into.
//
// # Keybinds
//
// Every chrome key comes from internal/keybinds: newModel derives Model.keys
// (single keys, matched with bubbles/key) and Model.km (the full map, which the
// chord engine resolves multi-key sequences against). Do not hardcode a key
// here — bind an Action, and help plus docs/KEYBINDS.md follow automatically.
// The shipped map is documented in docs/KEYBINDS.md.
//
// Input mode — keys go to Model.inputTarget's PtyStream.Write: the focused pane,
// or the shell drawer when the keyboard was handed to it from RegionShell.
//
//	ctrl+g then g       DETACH: return to chrome mode (PRODUCT.md §2 invariant 4)
//	ctrl+g then j       show/hide the shell drawer without leaving input mode
//	ctrl+g then ctrl+g  a literal BEL (the cancelled chord flushes to the agent)
//	all other keys      forwarded as raw bytes to the agent PTY
//
// Those chords are the only ones input mode intercepts; every other host key —
// including a bare ctrl+j, which is LF — belongs to the agent. Detach always
// works (PRODUCT.md §2 invariant 4 / §7.3): keybinds.Sanitize restores it if a
// rebind file drops it.
package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	"github.com/billiondollarsolo/shep-tui/internal/launch"
	"github.com/billiondollarsolo/shep-tui/internal/store"
	"github.com/billiondollarsolo/shep-tui/internal/ui/chat"
	"github.com/billiondollarsolo/shep-tui/internal/ui/compare"
	"github.com/billiondollarsolo/shep-tui/internal/ui/cost"
	"github.com/billiondollarsolo/shep-tui/internal/ui/files"
	"github.com/billiondollarsolo/shep-tui/internal/ui/gitpanel"
	"github.com/billiondollarsolo/shep-tui/internal/ui/handoff"
	"github.com/billiondollarsolo/shep-tui/internal/ui/motion"
	uipalette "github.com/billiondollarsolo/shep-tui/internal/ui/palette"
	"github.com/billiondollarsolo/shep-tui/internal/ui/panel"
	"github.com/billiondollarsolo/shep-tui/internal/ui/pen"
	"github.com/billiondollarsolo/shep-tui/internal/ui/splash"
	uitable "github.com/billiondollarsolo/shep-tui/internal/ui/table"
	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
	"github.com/billiondollarsolo/shep-tui/internal/vt"
)

// Mode is chrome (host keys) vs PTY input (agent keys + detach only).
type Mode int

const (
	ModeChrome Mode = iota
	ModeInput
)

func (m Mode) String() string {
	if m == ModeInput {
		return "input"
	}
	return "chrome"
}

// StageMode is the surface that fills the terminal. Home is the agents table;
// enter drills into one agent's terminal, and the pens grid is a surface of its
// own rather than the state the app starts in.
type StageMode int

const (
	StageTable   StageMode = iota // the agents table (home)
	StageTerm                     // one agent's terminal, full screen
	StagePen                      // the pens grid
	StagePalette                  // overlay
	StageRespond                  // overlay
	StageZen
	StagePanel    // generic text panel: git/chat/cost/compare/audit/files/handoff
	StageLaunch   // agent launch wizard
	StageHelp     // overlay
	StageSettings // config.toml, editable
	StageActions  // overlay: what can be done to the selected session
	StageRename   // overlay
	StageConfirm  // overlay: y/n before something irreversible
	StageFilter   // overlay: live filter over the table
	StageNodes    // the nodes table (the hosts agents run on)
	StageAddNode  // register a node (fleet)
)

func (s StageMode) String() string {
	switch s {
	case StageTerm:
		return "terminal"
	case StagePen:
		return "pens"
	case StagePalette:
		return "palette"
	case StageRespond:
		return "respond"
	case StageZen:
		return "zen"
	case StagePanel:
		return "panel"
	case StageLaunch:
		return "launch"
	case StageHelp:
		return "help"
	case StageSettings:
		return "settings"
	case StageActions:
		return "actions"
	case StageRename:
		return "rename"
	case StageConfirm:
		return "confirm"
	case StageFilter:
		return "filter"
	case StageNodes:
		return "nodes"
	case StageAddNode:
		return "add node"
	default:
		return "table"
	}
}

// floating reports whether the stage draws *over* the center body instead of
// being it: the body must keep rendering the surface the overlay was opened on.
func (s StageMode) floating() bool {
	return s == StagePalette || s == StageRespond || s == StageHelp ||
		s == StageActions || s == StageRename || s == StageConfirm || s == StageFilter
}

// terminalStage reports whether the stage is agent terminals: the surfaces where
// the keys act on a PTY rather than on a list.
func (s StageMode) terminalStage() bool {
	return s == StageTerm || s == StagePen || s == StageZen
}

// Region is what owns navigation focus: the surface, or the shell drawer.
type Region int

const (
	RegionMain Region = iota
	// RegionShell exists only while the shell drawer is open (visibleRegions).
	RegionShell
)

func (r Region) String() string {
	if r == RegionShell {
		return "shell"
	}
	return "main"
}

// inputTarget is the PTY that owns the keyboard in ModeInput. It is set by the
// keys that enter input mode and by nothing else: showing or hiding the shell
// drawer must never move the keyboard out from under what the user is typing.
type inputTarget int

const (
	targetPane inputTarget = iota
	targetShell
)

// keyMap holds the single-key chrome binds, derived from the keybinds registry.
// Chords (scroll-top, detach) are not here: they belong to the chord engine.
type keyMap struct {
	FocusNext    key.Binding
	FocusPrev    key.Binding
	Input        key.Binding
	Activate     key.Binding
	Quit         key.Binding
	Pane1        key.Binding
	Pane2        key.Binding
	Pane3        key.Binding
	Pane4        key.Binding
	Palette      key.Binding
	Launch       key.Binding
	Respond      key.Binding
	Actions      key.Binding
	Rename       key.Binding
	Kill         key.Binding
	Help         key.Binding
	Zen          key.Binding
	Pens         key.Binding
	Nodes        key.Binding
	Filter       key.Binding
	Shell        key.Binding
	FocusShell   key.Binding
	Esc          key.Binding
	Up           key.Binding
	Down         key.Binding
	RegionPrev   key.Binding
	RegionNext   key.Binding
	ScrollUp     key.Binding
	ScrollDown   key.Binding
	ScrollBottom key.Binding
	Retry        key.Binding
	Reconnect    key.Binding
}

// keyMapFields is the one place a chrome bind is tied to a registry action.
// Every field must appear here: buildKeyMap fills the map through it, and the
// parity test walks it to prove nothing is advertised that nothing dispatches.
func keyMapFields(k *keyMap) map[keybinds.Action]*key.Binding {
	return map[keybinds.Action]*key.Binding{
		keybinds.ActionFocusNext:   &k.FocusNext,
		keybinds.ActionFocusPrev:   &k.FocusPrev,
		keybinds.ActionEnterInput:  &k.Input,
		keybinds.ActionActivate:    &k.Activate,
		keybinds.ActionQuit:        &k.Quit,
		keybinds.ActionFocusPane1:  &k.Pane1,
		keybinds.ActionFocusPane2:  &k.Pane2,
		keybinds.ActionFocusPane3:  &k.Pane3,
		keybinds.ActionFocusPane4:  &k.Pane4,
		keybinds.ActionPalette:     &k.Palette,
		keybinds.ActionLaunch:      &k.Launch,
		keybinds.ActionRespond:     &k.Respond,
		keybinds.ActionActions:     &k.Actions,
		keybinds.ActionRename:      &k.Rename,
		keybinds.ActionKill:        &k.Kill,
		keybinds.ActionHelp:        &k.Help,
		keybinds.ActionZen:         &k.Zen,
		keybinds.ActionPens:        &k.Pens,
		keybinds.ActionNodes:       &k.Nodes,
		keybinds.ActionFilter:      &k.Filter,
		keybinds.ActionShellDrawer: &k.Shell,
		keybinds.ActionFocusShell:  &k.FocusShell,
		keybinds.ActionEsc:         &k.Esc,
		keybinds.ActionTreeUp:      &k.Up,
		keybinds.ActionTreeDown:    &k.Down,

		keybinds.ActionRegionPrev:   &k.RegionPrev,
		keybinds.ActionRegionNext:   &k.RegionNext,
		keybinds.ActionScrollUp:     &k.ScrollUp,
		keybinds.ActionScrollDown:   &k.ScrollDown,
		keybinds.ActionScrollBottom: &k.ScrollBottom,
		keybinds.ActionRetry:        &k.Retry,
		keybinds.ActionReconnect:    &k.Reconnect,
	}
}

func buildKeyMap(km keybinds.Map) keyMap {
	var k keyMap
	for action, dst := range keyMapFields(&k) {
		*dst = bindingFor(km, action)
	}
	return k
}

// bindingFor collects an action's single-key binds. Sequences longer than one
// key are left to the chord engine, so an action bound only to a chord (vim's
// ctrl+w w) yields a binding that key.Matches never fires on.
func bindingFor(km keybinds.Map, action keybinds.Action) key.Binding {
	seqs := km.Sequences(action)
	var single []string
	for _, seq := range seqs {
		if len(seq) == 1 {
			single = append(single, seq[0])
		}
	}
	help := key.WithHelp(keybinds.FormatSequences(seqs), keybinds.Description(action))
	if len(single) == 0 {
		// A binding with no keys reports Enabled() == false, and bubbles/help skips
		// it — which would hide every chord-only action (detach, g a) from the help
		// it is the source of truth for. Key it on the joined sequence: no single
		// tea.KeyMsg ever stringifies with a space, so key.Matches still never fires
		// and the chord engine stays the only dispatcher.
		for _, seq := range seqs {
			single = append(single, strings.Join(seq, " "))
		}
	}
	return key.NewBinding(key.WithKeys(single...), help)
}

// chordActions are the actions km binds to nothing but multi-key sequences.
// bindingFor drops those keys, so key.Matches never fires on them and the chord
// engine is their only dispatcher — which is exactly the set that silently dies
// if runAction has no arm for it.
func chordActions(km keybinds.Map) []keybinds.Action {
	var out []keybinds.Action
	for _, action := range keybinds.Actions() {
		seqs := km.Sequences(action)
		if len(seqs) == 0 {
			continue
		}
		chordOnly := true
		for _, seq := range seqs {
			if len(seq) == 1 {
				chordOnly = false
				break
			}
		}
		if chordOnly {
			out = append(out, action)
		}
	}
	return out
}

// detachActions are the chords that always take the keyboard back from an agent.
var detachActions = []keybinds.Action{keybinds.ActionDetachChord, keybinds.ActionDetachTmux}

// inputChordActions are the only chords PTY input mode may swallow: detach, and
// the shell drawer's chord alternate. Every other key — including a bare ctrl+j,
// which is LF — belongs to the agent.
var inputChordActions = append([]keybinds.Action{keybinds.ActionShellDrawer}, detachActions...)

// listKeys drives the palette's result list without consuming printable runes:
// bare-rune bindings are illegal in any handler that forwards keys to a focused
// textinput. They are local rather than registry actions because the registry
// binds tab / shift+tab to FocusNext / FocusPrev — which the palette does not
// dispatch — and a second action on the same key is a conflict Validate rejects.
// The palette's help renders these same bindings, so the two cannot drift.
var listKeys = struct{ Up, Down, GroupNext, GroupPrev key.Binding }{
	Up:        key.NewBinding(key.WithKeys("up", "ctrl+p"), key.WithHelp("↑", "up")),
	Down:      key.NewBinding(key.WithKeys("down", "ctrl+n"), key.WithHelp("↓", "down")),
	GroupNext: key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "next group")),
	GroupPrev: key.NewBinding(key.WithKeys("shift+tab"), key.WithHelp("shift+tab", "prev group")),
}

// Pane holds one pen slot: optional session attachment + VT (or raw fallback) display.
type Pane struct {
	SessionID string
	Title     string
	Status    domain.Status
	Stream    backend.PtyStream // nil if empty / unattached
	EmptyMsg  string
	// AttachErr is why this pane has no stream. It is separate from EmptyMsg
	// because a pane whose attach failed still has a SessionID, and renderPane
	// draws EmptyMsg only for the empty ones: a failure needs a body of its own
	// or it is stored where nothing renders it.
	AttachErr string
	Telemetry domain.Telemetry

	// Epoch is the pane's attachment generation. PTY messages carry the epoch
	// they were issued under; a message from an older generation refers to a
	// stream that has since been swapped out and must be dropped (pane index
	// alone is ambiguous — the parked listener of a closed stream would
	// otherwise close its replacement).
	Epoch int

	// scrollOff is how many lines back into scrollback the pane is scrolled.
	// 0 = live. Alt-screen programs get no history, so scrolling one is a no-op.
	scrollOff int

	// screen is the VT emulator for this pane.
	screen *vt.Screen
}

// paletteItem is one selectable row in the bottom command palette.
type paletteItem struct {
	ID     string // action id, "pen:<id>", or "session:<id>"
	Label  string
	Kind   string // "action" | "pen" | "session"
	Group  string // Navigate · Agents · Pens · Git · Inspect · Settings · Sessions
	Hint   string // optional keybind chip (e.g. "n", "?")
	Status domain.Status
}

// palette group order (empty-query catalog).
const (
	palGroupNavigate = "Navigate"
	palGroupAgents   = "Agents"
	palGroupPens     = "Pens"
	palGroupInspect  = "Inspect"
	palGroupSettings = "Settings"
	palGroupSessions = "Sessions"
)

// Model is the root model: header + the agents table, or the agent terminal the
// table drilled into.
type Model struct {
	be      backend.Backend
	version string
	profile string
	caps    backend.Caps

	// cfg is the live settings the paddock runs on. The settings surface is the
	// only thing that mutates it, and persistSettingsCmd the only thing that
	// writes it back to disk.
	cfg       *config.Config
	theme     theme.Theme
	themeName string

	// km is the keybind registry (preset + user keybinds.toml); keys is the
	// single-key view of it that chrome dispatch matches against.
	km   keybinds.Map
	keys keyMap

	// Session list (kept in sync with st for the table / attention / inbox).
	// The table is rebuilt by syncTable from the session list and pen membership.
	sessions []domain.Session
	st       *store.Store
	pensPath string // LoadPens/SavePens path; empty = no persistence
	// aliasPath is where the session display names live, beside the pens file.
	// aliases is the loaded map: sessionID → the name this client calls it.
	aliasPath string
	aliases   map[string]string

	// Active pen membership + layout.
	pen      domain.Pen
	panes    [domain.MaxPenSessions]Pane
	nPanes   int // 1..MaxPenSessions visible slots
	focus    int // focused pane index within nPanes
	epochSeq int // monotonic source of Pane.Epoch

	// Navigation
	region Region
	// table is the live agents list: a pointer, so its cursor survives Bubble
	// Tea's value-copy of Model. syncTable rebuilds it when sessions or pens
	// change — never from a render or a key handler.
	table          *uitable.Model
	filterInput    textinput.Model
	focusSessionID string // selected session (table / attention / palette)
	mode           Mode
	stage          StageMode
	stageStack     []StageMode // stages the open overlays were pushed over

	// Nodes: the hosts the agents run on, the node the table is scoped to, and
	// the fleet-only form that registers a new one.
	nodes      []domain.Node
	nodesTable *uitable.NodeModel
	// nodesSeq identifies the node list load the surface is waiting for, so the
	// answer to a list the user has already left behind is dropped.
	nodesSeq  int
	nodeScope string // node id the agents table is scoped to; "" = all nodes
	nodeForm  *huh.Form
	nodeVals  *nodeFormVals

	// Overlays
	paletteQuery  string
	paletteCursor int
	paletteItems  []paletteItem
	palInput      textinput.Model // bubbles filter input for palette

	// StagePanel content (git/chat/cost/compare/audit/files/handoff).
	panelKind string // for tests / structural claims
	// panelSeq identifies the load the open panel is waiting for, so the result
	// of a panel the user has already left behind is dropped instead of drawn.
	panelSeq int
	// panel is the scrolling window onto panelLines; filesBrowser is the live
	// navigation model behind the files panel (Move/Enter/Up across renders).
	panel        panel.Model
	filesBrowser *files.Browser
	// handoffSeed is the bootstrap the open handoff panel built; launchSeed is the
	// one a launch in flight will type into the agent it opens, and seedBySession
	// holds it from the spawn until the session's PTY is attached.
	handoffSeed    string
	handoffCwd     string
	launchSeed     string
	seedBySession  map[string]string
	settingsCursor int
	respondDraft   string
	respondTarget  string          // session the open respond bar writes to
	respondInput   textinput.Model // bubbles respond bar

	// Session actions (the selected row's verbs) and the two that need a second
	// surface of their own: a name to type, and a yes before a kill.
	actionsTarget string
	renameTarget  string
	renameInput   textinput.Model
	confirmPrompt string
	killTarget    string // session the pending confirm would close

	// Chord state: keys typed so far toward a multi-key bind. pendingSeq is
	// bumped on every arm/clear so the timeout of an abandoned chord is ignored.
	pending    []tea.KeyMsg
	pendingSeq int

	// Connectivity / chrome messages.
	//
	// watchSeq is the status-watch generation: a backend that has been replaced
	// (profile switch, reconnect) may still have a subscription in flight, and
	// its updates describe sessions on a machine the app is no longer talking to.
	// watchCancel tears that subscription down.
	statusCh     <-chan backend.StatusUpdate
	watchSeq     int
	watchCancel  context.CancelFunc
	reconnecting bool
	// retryN counts the re-dials the current outage has cost; backendDead is the
	// give-up state, where the banner stops animating and says what to press.
	retryN      int
	backendDead bool
	toast       toast // ephemeral, leveled statusline message
	err         error
	fatal       bool
	quitting    bool

	// Shell drawer: secondary PTY in project cwd — NOT counted as a pen agent.
	// Toggle with ctrl+j (ctrl+g j from input mode). Stream survives hide until quit.
	shellOpen   bool
	shellID     string
	shellStream backend.PtyStream
	shellScreen *vt.Screen

	// inputTarget is which PTY ModeInput writes to.
	inputTarget inputTarget

	// settingsDirty records that the settings surface changed something, so the
	// exit path persists it even if the async save never ran; settingsEdits is
	// which settings those were.
	settingsDirty bool
	settingsEdits settingsEdits

	// Splash screen shown once on startup (any key continues; q quits).
	showSplash bool

	helpModel help.Model

	// Launch wizard (E1): the huh form is the one representation.
	launchForm *huh.Form
	launchVals *launchFormVals

	// Charm motion: Needs-you blink + Starting spinner. blinkSeq is the blink
	// generation, so a tick from a stopped loop cannot start a second one.
	blinkOn       bool
	blinkSeq      int
	reducedMotion bool
	spin          spinner.Model

	width  int
	height int
	// resizeSeq keys the debounced PTY resize: only the last WindowSizeMsg of a
	// drag gets to issue control frames to every attached stream.
	resizeSeq int
}

// defaultPenID is the pen every session lands in until the user makes another one.
const defaultPenID = "default"

// shellDrawerID is the stable agentd session id for the secondary shell drawer.
const shellDrawerID = "shep-tui-shell-drawer"
const shellDrawerMinH = 6
const shellDrawerMaxH = 12

// Options configures Run.
type Options struct {
	Backend backend.Backend
	Version string
	// Sessions is the full session list for the table (not truncated).
	// First min(len, MaxPenSessions) are attached to pen panes on start unless
	// PensPath loads a persisted pen membership that overrides pane assignment.
	Sessions []domain.Session
	Profile  string
	Caps     backend.Caps
	// PensPath is where pen membership/layout is LoadPens on start and SavePens on quit.
	// Empty skips persistence.
	PensPath string
	// Keys is the resolved keybind map (preset + user overrides). Nil = Default.
	Keys keybinds.Map
	// Cfg is the loaded settings (theme, scrollback, layout, motion, mouse).
	// Nil = config.Default(), so tests get the shipped defaults.
	Cfg *config.Config
	// SkipSplash skips the startup splash (tests / headless automation).
	SkipSplash bool
	// ForceSplash shows splash even without a Backend (unit tests).
	ForceSplash bool
}

// Run starts the paddock Bubble Tea program.
// On exit (quit, interrupt, or error) PTY streams are closed before the backend.
func Run(opts Options) error {
	m := newModel(opts)
	popts := append([]tea.ProgramOption{tea.WithAltScreen()}, mouseProgramOpts(m.mouseEnabled())...)
	p := tea.NewProgram(m, popts...)
	final, err := p.Run()
	// Always close PTY attachments — quit key also closes, but Tea may exit
	// via ctrl+c / kill without that path, and double-close is safe (nil streams).
	fm, ok := final.(Model)
	if !ok {
		fm = m
	}
	fm.closeStreamsAndDrain()
	fm.savePensIfConfigured()
	fm.saveSettingsIfDirty()
	// A profile switch replaces the backend, so close the one the model ended on.
	if fm.be != nil {
		_ = fm.be.Close()
	} else if opts.Backend != nil {
		_ = opts.Backend.Close()
	}
	return err
}

// flushActivePenMembership syncs pane SessionIDs into m.pen and the store.
// Required before switch/create/save so launch/assign membership is not lost (E2).
func (m *Model) flushActivePenMembership() {
	if m.st == nil {
		return
	}
	// Every slot, not only the ones on the stage: a pen whose members are folded
	// behind a single pane is still a pen with those members in it.
	ids := make([]string, 0, domain.MaxPenSessions)
	for i := 0; i < domain.MaxPenSessions; i++ {
		if m.panes[i].SessionID != "" {
			ids = append(ids, m.panes[i].SessionID)
		}
	}
	m.pen.SessionIDs = ids
	if m.pen.ID == "" {
		return
	}
	if m.pen.ProjectID == "" {
		m.pen.ProjectID = "(default)"
	}
	if m.pen.Name == "" {
		m.pen.Name = m.pen.ID
	}
	m.st.SetPen(m.pen.ProjectID, m.pen)
}

func (m *Model) savePensIfConfigured() {
	if m.pensPath == "" || m.st == nil {
		return
	}
	if m.pen.ID == "" {
		m.pen.ID = "default"
	}
	if m.pen.Name == "" {
		m.pen.Name = "default"
	}
	if m.pen.ProjectID == "" {
		m.pen.ProjectID = "(default)"
	}
	m.flushActivePenMembership()
	if err := m.st.SavePens(m.pensPath); err != nil {
		fmt.Fprintf(os.Stderr, "shep-tui: save pens: %v\n", err)
	}
}

// RunFatal shows a one-shot error screen (agentd missing, dial failure) then exits cleanly.
func RunFatal(message string) error {
	km := keybinds.Default()
	m := Model{
		fatal: true,
		err:   fmt.Errorf("%s", message),
		theme: theme.Named(theme.NameAuto),
		km:    km,
		keys:  buildKeyMap(km),
	}
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err := p.Run()
	return err
}

func newModel(opts Options) Model {
	km := opts.Keys
	if km == nil {
		km = keybinds.Default()
	}
	km.Sanitize()
	cfg := opts.Cfg
	if cfg == nil {
		cfg = config.Default()
	}
	m := Model{
		km:      km,
		keys:    buildKeyMap(km),
		be:      opts.Backend,
		version: opts.Version,
		profile: opts.Profile,
		caps:    opts.Caps,
		cfg:     cfg,
		mode:    ModeChrome,
		stage:   StageTable,
		region:  RegionMain,
		nPanes:  1,
		focus:   0,
		// Splash on real TUI entry (Backend set). Tests skip unless ForceSplash.
		// SkipSplash always wins when set.
		showSplash: !opts.SkipSplash && (opts.ForceSplash || opts.Backend != nil),
	}
	m.themeName = cfg.UI.Theme
	m.theme = theme.Named(m.themeName)
	m.reducedMotion = motion.ReducedMotion(cfg.UI.ReducedMotion)
	m.initCharmWidgets()
	if m.profile == "" && opts.Caps.Mode != "" {
		m.profile = opts.Caps.Mode
	}
	if m.profile == "" {
		m.profile = cfg.ActiveName()
	}

	// Seed session list + store from options (full list for the table).
	m.sessions = append([]domain.Session(nil), opts.Sessions...)
	m.st = store.New()
	m.st.SeedSessions(m.sessions)
	m.pensPath = opts.PensPath
	m.aliases = map[string]string{}
	if opts.PensPath != "" {
		if err := m.st.LoadPens(opts.PensPath); err != nil {
			// A corrupt pens.json must not silently drop every pen.
			m.notifyErrf("pens: %v", err)
		}
		m.aliasPath = filepath.Join(filepath.Dir(opts.PensPath), aliasFileName)
		if err := m.st.LoadAliases(m.aliasPath); err != nil {
			m.notifyErrf("names: %v", err)
		}
		m.aliases = m.st.Aliases()
	}

	// Build pen from persisted membership when available; else first N sessions (up to 4).
	penIDs := seedPenSessionIDs(opts.Sessions, m.st)
	n := len(penIDs)
	if n > domain.MaxPenSessions {
		n = domain.MaxPenSessions
		penIDs = penIDs[:n]
	}
	// The pen keeps every member, but the stage opens on one of them: a grid of
	// agents nobody asked for is a grid the user has to close before working.
	m.nPanes = 1
	layout := configuredLayout(cfg, max(n, 1))
	if ap := m.st.ActivePen("(default)"); ap.ID != "" && ap.Layout != "" {
		layout = ap.Layout
		m.pen = ap
	} else {
		m.pen = domain.Pen{
			ID:        defaultPenID,
			ProjectID: "(default)",
			Name:      "default",
			Layout:    layout,
		}
	}
	m.pen.SessionIDs = append([]string(nil), penIDs...)
	m.pen.Layout = layout
	m.st.SetPen(m.pen.ProjectID, m.pen)

	sb := m.scrollback()
	for i := 0; i < domain.MaxPenSessions; i++ {
		m.panes[i] = Pane{
			Title:    fmt.Sprintf("pane %d", i+1),
			Status:   domain.StatusDisconnected,
			EmptyMsg: "no session — empty pen",
			screen:   vt.New(40, 12, sb),
		}
	}

	byID := make(map[string]domain.Session, len(opts.Sessions))
	for _, s := range opts.Sessions {
		byID[s.ID] = s
	}
	for i := 0; i < len(penIDs) && i < domain.MaxPenSessions; i++ {
		s, ok := byID[penIDs[i]]
		if !ok {
			s = domain.Session{ID: penIDs[i], Name: penIDs[i], Status: domain.StatusDisconnected}
		}
		m.panes[i].SessionID = s.ID
		m.panes[i].Title = m.paneTitle(s)
		m.panes[i].Telemetry = s.Telemetry
		if s.Status != "" {
			m.panes[i].Status = s.Status
		} else {
			m.panes[i].Status = domain.StatusIdle
		}
		m.nextEpoch(i)
		if i == 0 {
			m.focusSessionID = s.ID
		}
	}
	m.syncTable()
	return m
}

// nextEpoch opens a new attachment generation for a pane. Call it whenever the
// pane's stream is about to be replaced or dropped, so messages still in flight
// from the previous stream can be told apart from the new one's.
func (m *Model) nextEpoch(pane int) int {
	m.epochSeq++
	m.panes[pane].Epoch = m.epochSeq
	return m.epochSeq
}

// seedPenSessionIDs picks up to MaxPenSessions IDs for initial pen attachment.
// Prefers persisted active pen membership that still exists in sessions; else first N.
func seedPenSessionIDs(sessions []domain.Session, st *store.Store) []string {
	known := make(map[string]struct{}, len(sessions))
	order := make([]string, 0, len(sessions))
	for _, s := range sessions {
		if s.ID == "" {
			continue
		}
		if _, ok := known[s.ID]; ok {
			continue
		}
		known[s.ID] = struct{}{}
		order = append(order, s.ID)
	}
	if st != nil {
		ap := st.ActivePen("(default)")
		if len(ap.SessionIDs) > 0 {
			var kept []string
			for _, id := range ap.SessionIDs {
				if _, ok := known[id]; ok {
					kept = append(kept, id)
				}
				if len(kept) >= domain.MaxPenSessions {
					break
				}
			}
			if len(kept) > 0 {
				return kept
			}
		}
	}
	if len(order) > domain.MaxPenSessions {
		return order[:domain.MaxPenSessions]
	}
	return order
}

// SeedOptions is the pure seed path used by runTUI and tests (no I/O).
// Full Sessions are kept for the table; pen pane count is min(len, MaxPenSessions).
func SeedOptions(sessions []domain.Session, profile string, caps backend.Caps, pensPath string) Options {
	return Options{
		Sessions: append([]domain.Session(nil), sessions...),
		Profile:  profile,
		Caps:     caps,
		PensPath: pensPath,
	}
}

// PenPaneCount returns how many pen panes newModel will open for sessions.
func PenPaneCount(sessions []domain.Session) int {
	n := len(sessions)
	if n > domain.MaxPenSessions {
		return domain.MaxPenSessions
	}
	if n < 1 {
		return 1
	}
	return n
}

// scrollback is the configured history depth, falling back to the vt default
// when unset. The pane screens and the shell drawer's screen share it: a drawer
// pinned to its own hardcoded depth is a config field that is only half read.
func (m Model) scrollback() int {
	if m.cfg != nil && m.cfg.UI.Scrollback > 0 {
		return m.cfg.UI.Scrollback
	}
	return vt.DefaultScrollback
}

// configuredLayout is the layout a fresh pen opens with: the configured default
// when it names a real layout, else one derived from the pane count. A pen
// persisted in pens.json still wins over both — the user arranged that one.
func configuredLayout(cfg *config.Config, n int) domain.PenLayout {
	if cfg != nil {
		switch l := domain.PenLayout(cfg.UI.PenDefaultLayout); l {
		case domain.PenLayoutCols, domain.PenLayoutRows, domain.PenLayoutGrid2x2, domain.PenLayoutMainStack:
			return l
		}
	}
	return defaultLayoutForN(n)
}

func defaultLayoutForN(n int) domain.PenLayout {
	switch {
	case n >= 3:
		return domain.PenLayoutGrid2x2
	case n == 2:
		return domain.PenLayoutCols
	default:
		return domain.PenLayoutCols
	}
}

// --- messages ---

type ptyOutputMsg struct {
	pane  int
	epoch int
	data  []byte
}

type ptyClosedMsg struct {
	pane  int
	epoch int
}

// statusUpdateMsg is one status change from the watch of generation seq. The
// generation is what tells an update from the backend the app is on apart from
// one still arriving from a backend it has replaced.
type statusUpdateMsg struct {
	backend.StatusUpdate
	seq int
}

type statusChMsg struct {
	ch  <-chan backend.StatusUpdate
	seq int
}

type attachDoneMsg struct {
	pane   int
	epoch  int
	stream backend.PtyStream
	err    error
}

type spawnDoneMsg struct {
	session domain.Session
	err     error
}

// chordTimeoutMsg expires a half-typed chord. seq identifies the arm it belongs
// to, so the timer of an already-resolved chord is ignored.
type chordTimeoutMsg struct {
	seq int
}

// resizeSettleMsg fires once a resize drag has stopped. seq identifies the size
// it belongs to, so only the last WindowSizeMsg reaches the PTYs.
type resizeSettleMsg struct {
	seq int
}

// ptyWriteQueue is the depth of a stream's async write queue: deep enough for a
// paste, shallow enough that a dead peer is reported instead of buffering.
const ptyWriteQueue = 256

// startWatchMsg subscribes the status watch from inside Update. The watch
// generation lives on the model, and Init runs on a copy Bubble Tea discards, so
// a subscription opened there would carry a seq the model never learned.
type startWatchMsg struct{}

// Init attaches PTY streams and starts listeners + Charm motion ticks.
func (m Model) Init() tea.Cmd {
	var cmds []tea.Cmd
	// A toast raised during newModel (a corrupt pens.json) predates the first
	// Update, so the seq diff in the Update wrapper never sees it and no expiry is
	// ever armed for it.
	if expire := m.toastExpiryCmd(0); expire != nil {
		cmds = append(cmds, expire)
	}
	// Always start blink/spinner ticks in interactive TUI (even without backend in tests).
	if !m.fatal {
		cmds = append(cmds, m.charmTickCmds())
	}
	if m.fatal || m.be == nil {
		return tea.Batch(cmds...)
	}
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == "" {
			continue
		}
		cmds = append(cmds, m.attachPaneCmd(i, m.panes[i].Epoch, m.panes[i].SessionID))
	}
	cmds = append(cmds, func() tea.Msg { return startWatchMsg{} })
	return tea.Batch(cmds...)
}

// ptyCoalesceMax caps how much output one ptyOutputMsg may carry. A chatty agent
// produces far more chunks than the UI can repaint; one Update per chunk is what
// backs the PTY's channel up until it drops bytes.
const ptyCoalesceMax = 64 << 10

func listenPty(pane, epoch int, ch <-chan []byte) tea.Cmd {
	return func() tea.Msg {
		data, ok := <-ch
		if !ok {
			return ptyClosedMsg{pane: pane, epoch: epoch}
		}
		buf := append(make([]byte, 0, len(data)), data...)
		// Drain whatever else is already queued into the same message. A close
		// mid-drain ends it: the next listen reads the closed channel and reports.
	drain:
		for len(buf) < ptyCoalesceMax {
			select {
			case more, ok := <-ch:
				if !ok {
					break drain
				}
				buf = append(buf, more...)
			default:
				break drain
			}
		}
		return ptyOutputMsg{pane: pane, epoch: epoch, data: buf}
	}
}

func listenShellPty(ch <-chan []byte) tea.Cmd {
	return func() tea.Msg {
		data, ok := <-ch
		if !ok {
			return shellOutputMsg{data: nil}
		}
		cp := make([]byte, len(data))
		copy(cp, data)
		return shellOutputMsg{data: cp}
	}
}

// renderShellDrawer draws the secondary shell PTY strip (not a pen slot).
func renderShellDrawer(m Model, w, h int) string {
	th := m.th()
	if h < 3 {
		h = 3
	}
	if w < 10 {
		w = 10
	}
	border := th.Border
	if m.shellHasKeyboard() || (m.region == RegionShell && m.mode == ModeChrome) {
		border = th.BorderFocus
	}
	title := "shell drawer"
	if m.shellID != "" {
		title += " · " + domain.ShortID(m.shellID)
	}
	if m.shellStream == nil {
		title += " · attaching…"
	} else if m.shellHasKeyboard() {
		title += " · INPUT"
	}
	// VT content
	body := ""
	if m.shellScreen != nil {
		body = m.shellScreen.TrimmedString()
		if body == "" {
			body = m.shellScreen.String()
		}
	}
	if body == "" {
		body = th.Muted.Render("(secondary shell — not counted as a pen agent)")
	}
	// Clip to height-2 for border.
	innerH := max(h-2, 1)
	lines := strings.Split(body, "\n")
	if len(lines) > innerH {
		lines = lines[len(lines)-innerH:]
	}
	content := title + "\n" + strings.Join(lines, "\n")
	return border.Width(w - 2).Height(h - 2).Render(content)
}

// listenStatus waits for the next update on the watch of generation seq. An
// empty SessionID is a status about nothing, never a hangup: the hangup is
// statusWatchClosedMsg, and reading one as the other is what left the app
// animating a reconnect that was never attempted.
func listenStatus(ch <-chan backend.StatusUpdate, seq int) tea.Cmd {
	if ch == nil {
		return nil
	}
	return func() tea.Msg {
		u, ok := <-ch
		if !ok {
			return statusWatchClosedMsg{seq: seq}
		}
		return statusUpdateMsg{StatusUpdate: u, seq: seq}
	}
}

// Update handles Tea messages. It wraps update so that a toast raised anywhere
// in the model gets its expiry timer without every handler having to return one.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	seq := m.toast.seq
	next, cmd := m.update(msg)
	nm, ok := next.(Model)
	if !ok {
		return next, cmd
	}
	if expire := nm.toastExpiryCmd(seq); expire != nil {
		cmd = tea.Batch(cmd, expire)
	}
	return nm, cmd
}

func (m Model) update(msg tea.Msg) (tea.Model, tea.Cmd) {
	// Splash gate: any key continues (q quits). Mouse/resize still handled.
	if m.showSplash && !m.fatal {
		switch msg := msg.(type) {
		case tea.WindowSizeMsg:
			cmd := m.applySize(msg.Width, msg.Height)
			m.clampRegion()
			return m, cmd
		case tea.KeyMsg:
			if key.Matches(msg, m.keys.Quit) {
				return m.quit()
			}
			m.showSplash = false
			// Init may have started already; ensure resize after splash.
			m.resizeStreams()
			return m, nil
		default:
			// Ignore other messages until splash dismissed (except we still
			// want attach cmds from Init to run — they queue as msgs).
			// Process attach/status under the hood so paddock is ready.
		}
	}

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		cmd := m.applySize(msg.Width, msg.Height)
		m.clampRegion()
		return m, cmd

	case blinkTickMsg:
		if msg.seq != m.blinkSeq {
			// A tick from a loop that has been superseded: exactly one chain runs
			// per generation, and this one is not it.
			return m, nil
		}
		if !m.blinkActive() {
			// Attention cleared while the tick was in flight: park the glyph lit.
			m.blinkOn = true
			return m, nil
		}
		m.blinkOn = !m.blinkOn
		return m, blinkTick(m.blinkSeq)

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		// Keep spinner alive only while needed; blink tick restarts it if needed.
		if m.needsSpinner() {
			return m, cmd
		}
		return m, nil

	case startWatchMsg:
		return m, m.watchStatusCmd()

	case statusChMsg:
		if msg.seq != m.watchSeq {
			return m, nil
		}
		before := m.motionState()
		m.statusCh = msg.ch
		m.reconnecting = false
		m.backendDead = false
		m.retryN = 0
		return m.armMotion(before, listenStatus(m.statusCh, msg.seq))

	case statusWatchClosedMsg:
		if msg.seq != m.watchSeq {
			// The watch that ended belongs to a backend the app has already
			// replaced: let its chain die instead of re-arming it on the new one.
			return m, nil
		}
		return m.watchClosed()

	case reconnectTickMsg:
		if msg.n != m.retryN || m.backendDead {
			return m, nil
		}
		return m, m.reconnectCmd()

	case reconnectDoneMsg:
		return m.reconnectDone(msg)

	case toastExpiredMsg:
		if msg.seq == m.toast.seq {
			m.toast.text = ""
		}
		return m, nil

	case panelLoadedMsg:
		if msg.seq != m.panelSeq || m.bodyStage() != StagePanel || m.panelKind != msg.kind {
			// The panel the load was for is gone; its content belongs to nobody.
			return m, nil
		}
		if msg.kind == "files" {
			m.filesBrowser = msg.browser
		}
		m.setPanelLines(msg.lines)
		return m, nil

	case attachDoneMsg:
		if msg.pane < 0 || msg.pane >= domain.MaxPenSessions || msg.epoch != m.panes[msg.pane].Epoch {
			// The pane moved on while the attach was in flight — the stream we
			// were handed belongs to nobody. It is raw (Async wraps it only once
			// adopted), so its Close goes off the Update goroutine.
			return m, closeStreamCmd(msg.stream)
		}
		before := m.motionState()
		if msg.err != nil {
			m.panes[msg.pane].AttachErr = msg.err.Error()
			m.panes[msg.pane].Status = domain.StatusError
			m.notifyErrf("attach %s: %v", domain.ShortID(m.panes[msg.pane].SessionID), msg.err)
			return m.armMotion(before, nil)
		}
		stream := backend.Async(msg.stream, ptyWriteQueue)
		m.panes[msg.pane].Stream = stream
		m.panes[msg.pane].AttachErr = ""
		m.resizeStreams()
		m.writeSeed(msg.pane, stream)
		return m.armMotion(before, listenPty(msg.pane, msg.epoch, stream.Output()))

	case nodesLoadedMsg:
		return m.nodesLoaded(msg)

	case nodeCreatedMsg:
		return m.nodeCreated(msg)

	case gitCommitMsg:
		if msg.err != nil {
			m.notifyErr(msg.err.Error())
		} else {
			m.notifyOK(msg.ok)
		}
		return m, nil

	case killDoneMsg:
		if msg.err != nil {
			m.notifyErrf("kill %s: %v", msg.name, msg.err)
			return m, nil
		}
		return m.sessionKilled(msg)

	case exportDoneMsg:
		if msg.err != nil {
			m.notifyErrf("export: %v", msg.err)
		} else {
			m.notifyOK("exported " + msg.path)
		}
		return m, nil

	case aliasesSavedMsg:
		if msg.err != nil {
			m.notifyErrf("names: %v", msg.err)
		}
		return m, nil

	case spawnDoneMsg:
		before := m.motionState()
		if msg.err != nil {
			m.launchSeed = ""
			m.notifyErrf("spawn/launch: %v", msg.err)
			return m, nil
		}
		if m.launchSeed != "" {
			if m.seedBySession == nil {
				m.seedBySession = make(map[string]string)
			}
			m.seedBySession[msg.session.ID] = m.launchSeed
			m.launchSeed = ""
		}
		m.sessions = append(m.sessions, msg.session)
		if m.st != nil {
			m.st.SeedSessions(m.sessions)
		}
		m.syncTable()
		m.notifyOK(fmt.Sprintf("spawned shell %s", domain.ShortID(msg.session.ID)))
		// Place into first empty pane if any; else the agent that was just launched
		// takes the stage, and the one it replaced stays a keystroke away in the
		// table. Growing the pen into a grid nobody asked for is not a launch.
		for i := 0; i < m.nPanes; i++ {
			if m.panes[i].SessionID == "" {
				m.resetStage()
				m.stage = StageTerm
				m.region = RegionMain
				nm, cmd := m.assignSessionToPane(i, msg.session)
				return nm.armMotion(before, cmd)
			}
		}
		nm, cmd := m.focusSessionIntoPen(msg.session)
		return nm.(Model).armMotion(before, cmd)

	case ptyOutputMsg:
		if msg.pane < 0 || msg.pane >= domain.MaxPenSessions || msg.epoch != m.panes[msg.pane].Epoch {
			return m, nil
		}
		hist := 0
		if s := m.panes[msg.pane].screen; s != nil {
			hist = s.ScrollbackLen()
		}
		m.panes[msg.pane].feed(msg.data)
		// A pane parked in its history stays on the same lines while the live
		// rows scroll away underneath it.
		if s := m.panes[msg.pane].screen; s != nil && m.panes[msg.pane].scrollOff > 0 {
			m.panes[msg.pane].scrollOff = min(m.panes[msg.pane].scrollOff+s.ScrollbackLen()-hist, s.ScrollbackLen())
		}
		var cmd tea.Cmd
		if s := m.panes[msg.pane].Stream; s != nil {
			cmd = listenPty(msg.pane, msg.epoch, s.Output())
		}
		return m, cmd

	case ptyClosedMsg:
		if msg.pane < 0 || msg.pane >= domain.MaxPenSessions || msg.epoch != m.panes[msg.pane].Epoch {
			return m, nil
		}
		m.panes[msg.pane].Stream = nil
		m.panes[msg.pane].Status = domain.StatusDisconnected
		if m.mode == ModeInput && m.focus == msg.pane && m.inputTarget == targetPane {
			m.mode = ModeChrome
			m.clearChord()
		}
		// The pane keeps what the agent already wrote; it just has no PTY behind
		// it any more, and saying so is what makes the retry bind discoverable.
		m.notifyErr(fmt.Sprintf("%s detached · %s to retry", m.panes[msg.pane].Title, m.retryHint()))
		return m, nil

	case settingsSavedMsg:
		if msg.err != nil {
			m.notifyErrf("settings: %v", msg.err)
		}
		return m, nil

	case profileSwitchedMsg:
		if msg.err != nil {
			// The old backend was never touched: stay on it.
			m.notifyErrf("profile %s: %v", msg.profile, msg.err)
			return m, nil
		}
		return m.applyProfileSwitch(msg)

	case chordTimeoutMsg:
		return m.expireChord(msg.seq)

	case resizeSettleMsg:
		if msg.seq == m.resizeSeq {
			m.resizePtys()
		}
		return m, nil

	case shellDrawerMsg:
		if msg.err != nil {
			m.notifyErrf("shell drawer: %v", msg.err)
			// Keep drawer open UI so user sees error text in pane; no stream.
			return m, nil
		}
		m.shellID = msg.id
		m.shellStream = backend.Async(msg.stream, ptyWriteQueue)
		if m.shellScreen == nil {
			m.shellScreen = vt.New(80, shellDrawerMinH, m.scrollback())
		}
		m.resizeStreams()
		m.notifyOK("shell drawer attached · i to type · ctrl+g g detach")
		return m, listenShellPty(m.shellStream.Output())

	case shellOutputMsg:
		if m.shellScreen != nil && len(msg.data) > 0 {
			_, _ = m.shellScreen.Write(msg.data)
		}
		var cmd tea.Cmd
		if m.shellStream != nil {
			cmd = listenShellPty(m.shellStream.Output())
		}
		return m, cmd

	case statusUpdateMsg:
		if msg.seq != m.watchSeq {
			// A status from a backend the app has moved off: applying it would
			// put that machine's sessions in this profile's tree.
			return m, nil
		}
		before := m.motionState()
		if msg.SessionID == "" {
			// A status update about no session is nothing; the closed watch has
			// its own message.
			return m.armMotion(before, listenStatus(m.statusCh, msg.seq))
		}
		m.reconnecting = false
		// Update session list.
		found := false
		for i := range m.sessions {
			if m.sessions[i].ID == msg.SessionID {
				m.sessions[i].Status = msg.Status
				if msg.Telemetry != (domain.Telemetry{}) {
					m.sessions[i].Telemetry = msg.Telemetry
				}
				found = true
				break
			}
		}
		if !found {
			m.sessions = append(m.sessions, domain.Session{
				ID:        msg.SessionID,
				Status:    msg.Status,
				Telemetry: msg.Telemetry,
			})
		}
		if m.st != nil {
			m.st.SeedSessions(m.sessions)
			m.st.ApplyStatus(msg.StatusUpdate)
		}
		// Update panes.
		for i := range m.panes {
			if m.panes[i].SessionID == msg.SessionID {
				m.panes[i].Status = msg.Status
				if msg.Telemetry != (domain.Telemetry{}) {
					m.panes[i].Telemetry = msg.Telemetry
				}
			}
		}
		m.syncTable()
		return m.armMotion(before, listenStatus(m.statusCh, msg.seq))

	case tea.MouseMsg:
		return m.handleMouse(msg)

	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m.routeToActive(msg)
}

// routeToActive delivers every message the root does not handle itself to the
// focused sub-model. Without it huh/bubbles components never see the msgs their
// own commands produce (form submission, cursor blink) and go inert.
// tea.KeyMsg is consumed upstream by handleKey, so nothing double-dispatches.
func (m Model) routeToActive(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd
	switch m.stage {
	case StagePalette:
		m.palInput, cmd = m.palInput.Update(msg)
	case StageRespond:
		m.respondInput, cmd = m.respondInput.Update(msg)
	case StageFilter:
		m.filterInput, cmd = m.filterInput.Update(msg)
	}
	nm, fcmd, _ := m.advanceLaunchForm(msg)
	nm, ncmd, _ := nm.advanceNodeForm(msg)
	return nm, tea.Batch(cmd, fcmd, ncmd)
}

// pushStage opens s over the current stage. The stack — not the surface that
// opened it — decides where esc goes back to, so an overlay raised over zen, a
// panel or the attention list returns there instead of dumping the user in the
// paddock.
//
// Re-opening the surface you are already on (a panel command run from a panel)
// must not stack a duplicate: popStage would restore the identical stage and esc
// would appear dead.
//
// The full-slice append is load-bearing: Bubble Tea copies Model by value, and
// a shared backing array would let one copy's push overwrite another's return.
func (m *Model) pushStage(s StageMode) {
	if m.stage == s {
		return
	}
	m.stageStack = append(m.stageStack[:len(m.stageStack):len(m.stageStack)], m.stage)
	m.stage = s
}

// popStage closes the top overlay and restores the stage beneath it.
func (m *Model) popStage() {
	n := len(m.stageStack)
	if n == 0 {
		m.stage = StageTable
		return
	}
	m.stage = m.stageStack[n-1]
	m.stageStack = m.stageStack[:n-1]
}

// resetStage goes home to the table, abandoning any pending overlay returns.
func (m *Model) resetStage() {
	m.stage = StageTable
	m.stageStack = nil
}

// underStage is the surface the top overlay was raised over.
func (m Model) underStage() StageMode {
	if n := len(m.stageStack); n > 0 {
		return m.stageStack[n-1]
	}
	return StageTable
}

// bodyStage is the stage the center body renders: floating overlays are drawn
// on top of it, not instead of it.
func (m Model) bodyStage() StageMode {
	s := m.stage
	for i := len(m.stageStack) - 1; i >= 0 && s.floating(); i-- {
		s = m.stageStack[i]
	}
	if s.floating() {
		return StageTable
	}
	return s
}

// quit is the single exit path: PTY streams must be closed on every one of them.
func (m Model) quit() (tea.Model, tea.Cmd) {
	m.quitting = true
	m.closeStreamsAndDrain()
	return m, tea.Quit
}

// paneTitle reads like the session's table row, so the surface and the list agree
// — and two agents of the same type stay tellable apart.
func (m Model) paneTitle(s domain.Session) string {
	if id := domain.ShortID(s.ID); id != "" {
		return id + " " + m.sessionName(s)
	}
	return m.sessionName(s)
}

// sessionName is what this client calls the session: the name the user gave it,
// else the backend's.
func (m Model) sessionName(s domain.Session) string {
	if alias := m.aliases[s.ID]; alias != "" {
		return alias
	}
	return s.Label()
}

func (m Model) assignSessionToPane(pane int, s domain.Session) (Model, tea.Cmd) {
	m.panes[pane].SessionID = s.ID
	m.panes[pane].Title = m.paneTitle(s)
	m.panes[pane].Status = s.Status
	if m.panes[pane].Status == "" {
		m.panes[pane].Status = domain.StatusIdle
	}
	m.panes[pane].Telemetry = s.Telemetry
	// Track pen membership.
	inPen := false
	for _, id := range m.pen.SessionIDs {
		if id == s.ID {
			inPen = true
			break
		}
	}
	if !inPen {
		m.pen.SessionIDs = append(m.pen.SessionIDs, s.ID)
	}
	m.focusSessionID = s.ID
	m.focus = pane
	m.panes[pane].scrollOff = 0
	// AttachErr belongs to the session that was in the pane: a failure from the
	// last occupant may not be drawn over this one.
	m.panes[pane].AttachErr = ""
	m.resizeStreams()
	m.syncTable()
	if m.be == nil {
		return m, nil
	}
	return m, m.attachPaneCmd(pane, m.nextEpoch(pane), s.ID)
}

// attachPaneCmd opens a pane's PTY at the size the pane is actually drawn at.
// Every attach goes through here: three copies of this closure are how the 80×24
// attach size survived being fixed. The epoch is minted by the caller, which is
// the only one that can store it on the pane.
func (m Model) attachPaneCmd(pane, epoch int, sid string) tea.Cmd {
	if m.be == nil || sid == "" {
		return nil
	}
	be := m.be
	cols, rows := m.paneSize(pane)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		stream, err := be.OpenPty(ctx, sid, cols, rows)
		return attachDoneMsg{pane: pane, epoch: epoch, stream: stream, err: err}
	}
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.fatal {
		return m.quit()
	}
	if m.mode == ModeInput {
		return m.handleInputKey(msg)
	}
	// Overlay modes handle keys first.
	switch m.stage {
	case StagePalette:
		return m.handlePaletteKey(msg)
	case StageRespond:
		return m.handleRespondKey(msg)
	case StageLaunch:
		return m.handleLaunchKey(msg)
	case StagePanel:
		return m.handlePanelKey(msg)
	case StageHelp:
		return m.handleHelpKey(msg)
	case StageSettings:
		return m.handleSettingsKey(msg)
	case StageActions:
		return m.handleActionsKey(msg)
	case StageRename:
		return m.handleRenameKey(msg)
	case StageConfirm:
		return m.handleConfirmKey(msg)
	case StageFilter:
		return m.handleFilterKey(msg)
	case StageAddNode:
		return m.handleAddNodeKey(msg)
	}
	return m.handleChromeKey(msg)
}

// chordWindow is how long a half-typed chord stays armed. Without it a stray
// prefix key arms forever and eats the next unrelated keystroke.
const chordWindow = 800 * time.Millisecond

// resizeSettleWindow is how long a resize drag must be still before the PTYs
// are told about it. One control frame per pane per intermediate size is a
// storm on the fleet backend.
const resizeSettleWindow = 50 * time.Millisecond

// armChord records msg as a chord prefix and schedules its expiry.
func (m *Model) armChord(msg tea.KeyMsg) tea.Cmd {
	m.pending = append(m.pending[:len(m.pending):len(m.pending)], msg)
	m.pendingSeq++
	seq := m.pendingSeq
	return tea.Tick(chordWindow, func(time.Time) tea.Msg {
		return chordTimeoutMsg{seq: seq}
	})
}

// clearChord drops the pending prefix and invalidates its timeout.
func (m *Model) clearChord() {
	m.pending = nil
	m.pendingSeq++
}

// pendingChord renders the half-typed chord for the title bar ("g", "ctrl+w").
func (m Model) pendingChord() string {
	keys := make([]string, 0, len(m.pending))
	for _, k := range m.pending {
		keys = append(keys, k.String())
	}
	return keybinds.FormatChord(keys)
}

// chordKeys is the sequence typed so far, plus msg.
func (m Model) chordKeys(msg tea.KeyMsg) []string {
	out := make([]string, 0, len(m.pending)+1)
	for _, k := range m.pending {
		out = append(out, k.String())
	}
	return append(out, msg.String())
}

// expireChord cancels a chord the user stopped typing. In PTY input mode the
// buffered prefix was never a host key after all, so it goes to the agent —
// that is what makes a literal ctrl+g (BEL) reach a nested program.
func (m Model) expireChord(seq int) (tea.Model, tea.Cmd) {
	if seq != m.pendingSeq || len(m.pending) == 0 {
		return m, nil
	}
	flushed := m.pending
	m.clearChord()
	if m.mode == ModeInput {
		m.writeToPty(flushed...)
	}
	return m, nil
}

// feedChord runs msg through the chrome chord engine. handled reports that the
// key extended or completed a chord; when it is false any pending prefix has
// been dropped and the caller must dispatch msg as a plain key.
func (m Model) feedChord(msg tea.KeyMsg) (Model, tea.Cmd, bool) {
	seq := m.chordKeys(msg)
	if len(seq) > 1 {
		if action, ok := m.km.Resolve(seq); ok {
			m.clearChord()
			mm, cmd := m.runChordAction(action)
			return mm, cmd, true
		}
	}
	if m.km.IsPrefix(seq) {
		return m, m.armChord(msg), true
	}
	m.clearChord()
	return m, nil, false
}

func (m Model) runChordAction(action keybinds.Action) (Model, tea.Cmd) {
	if mm, cmd, ok := m.runAction(action); ok {
		return mm, cmd
	}
	// Chords bound to actions chrome does not serve (detach, which belongs to
	// input mode) are consumed rather than leaked back as plain keys.
	return m, nil
}

// runAction is the one dispatcher for chrome actions. Both the chord engine and
// the key.Matches chain route through it, so an action bound only to a chord —
// vim's ctrl+w w, tmux's ctrl+b : — reaches the same handler as its single-key
// alternate instead of landing in a switch that never had an arm for it.
// ok=false means chrome does not serve the action.
func (m Model) runAction(action keybinds.Action) (Model, tea.Cmd, bool) {
	model := func(mm tea.Model, cmd tea.Cmd) (Model, tea.Cmd, bool) {
		return mm.(Model), cmd, true
	}
	switch action {
	case keybinds.ActionQuit:
		return model(m.quit())
	case keybinds.ActionPalette:
		return model(m.openPalette())
	case keybinds.ActionLaunch:
		if m.bodyStage() == StageNodes {
			return model(m.openAddNode())
		}
		if !m.caps.Launch {
			return m, nil, false
		}
		return model(m.openLaunch())
	case keybinds.ActionHelp:
		return model(m.openHelp())
	case keybinds.ActionRespond:
		return model(m.openRespond())
	case keybinds.ActionActions:
		return model(m.openSessionActions())
	case keybinds.ActionRename:
		return m.runSelectedSessionAction("r")
	case keybinds.ActionKill:
		return m.runSelectedSessionAction("x")
	case keybinds.ActionZen:
		return model(m.toggleZen())
	case keybinds.ActionPens:
		return model(m.openPens())
	case keybinds.ActionNodes:
		return model(m.openNodes())
	case keybinds.ActionFilter:
		return model(m.openFilter())
	case keybinds.ActionShellDrawer:
		if !m.caps.ShellDrawer {
			return m, nil, false
		}
		return model(m.toggleShellDrawer())
	case keybinds.ActionFocusShell:
		if !m.caps.ShellDrawer {
			return m, nil, false
		}
		return model(m.focusShell())

	case keybinds.ActionEsc:
		// Every full-screen surface goes back to the table: it is home, and esc is
		// the one way back to it.
		switch m.stage {
		case StageZen:
			m.popStage()
			m.resizeStreams()
		case StageTerm, StagePen:
			m.resetStage()
			m.resizeStreams()
		case StageNodes:
			m.resetStage()
		case StageTable:
			// On the table, esc is the way back out of a node scope: the agents of
			// every node, which is where the app started.
			if m.nodeScope != "" {
				m.clearNodeScope()
			}
		}
		m.panes[m.focus].scrollOff = 0
		m.clearToast()
		return m, nil, true

	case keybinds.ActionFocusNext:
		if m.nPanes > 0 {
			m.focus = (m.focus + 1) % m.nPanes
			m.region = RegionMain
			m.syncFocusSessionFromPane()
		}
		return m, nil, true
	case keybinds.ActionFocusPrev:
		if m.nPanes > 0 {
			m.focus = (m.focus - 1 + m.nPanes) % m.nPanes
			m.region = RegionMain
			m.syncFocusSessionFromPane()
		}
		return m, nil, true

	case keybinds.ActionFocusPane1:
		return model(m.focusPane(0))
	case keybinds.ActionFocusPane2:
		return model(m.focusPane(1))
	case keybinds.ActionFocusPane3:
		return model(m.focusPane(2))
	case keybinds.ActionFocusPane4:
		return model(m.focusPane(3))

	case keybinds.ActionEnterInput:
		return model(m.enterInput())

	case keybinds.ActionActivate:
		// On the table, enter drills into the row; on the nodes table it scopes the
		// agents to the node; in a terminal it is the PTY's.
		if m.onNodes() {
			return model(m.scopeToSelectedNode())
		}
		if m.onTable() {
			return model(m.activateTableSelection())
		}
		return model(m.enterInput())

	case keybinds.ActionTreeUp:
		switch {
		case m.onNodes():
			m.moveNodesCursor(-1)
		case m.onTable():
			m.moveTableCursor(-1)
		case m.inGrid():
			return model(m.focusPaneDir(0, -1))
		default:
			m.scrollFocusedPane(1)
		}
		return m, nil, true
	case keybinds.ActionTreeDown:
		switch {
		case m.onNodes():
			m.moveNodesCursor(1)
		case m.onTable():
			m.moveTableCursor(1)
		case m.inGrid():
			return model(m.focusPaneDir(0, 1))
		default:
			m.scrollFocusedPane(-1)
		}
		return m, nil, true

	case keybinds.ActionScrollUp:
		m.scrollFocusedPane(m.paneScrollPage())
		return m, nil, true
	case keybinds.ActionScrollDown:
		m.scrollFocusedPane(-m.paneScrollPage())
		return m, nil, true
	case keybinds.ActionScrollBottom:
		m.panes[m.focus].scrollOff = 0
		return m, nil, true
	case keybinds.ActionScrollTop:
		if m.bodyStage() == StagePanel {
			m.panel.GotoTop()
			return m, nil, true
		}
		if s := m.panes[m.focus].screen; s != nil && !s.AltScreen() {
			m.panes[m.focus].scrollOff = s.ScrollbackLen()
		}
		return m, nil, true

	case keybinds.ActionRetry:
		return model(m.retryAttach())
	case keybinds.ActionReconnect:
		return model(m.reconnectNow())

	case keybinds.ActionRegionPrev:
		if m.inGrid() {
			return model(m.focusPaneDir(-1, 0))
		}
		m.cycleRegion(-1)
		return m, nil, true
	case keybinds.ActionRegionNext:
		if m.inGrid() {
			return model(m.focusPaneDir(1, 0))
		}
		m.cycleRegion(1)
		return m, nil, true
	}
	return m, nil, false
}

// matchAction is the action bound to msg, in registry order (never map order:
// two actions sharing a key would otherwise dispatch differently per press).
func (m Model) matchAction(msg tea.KeyMsg) (keybinds.Action, bool) {
	keys := m.keys
	fields := keyMapFields(&keys)
	for _, action := range keybinds.Actions() {
		if b, ok := fields[action]; ok && key.Matches(msg, *b) {
			return action, true
		}
	}
	return "", false
}

// handleGlobalKey handles the keys that must reach the user from every surface.
// chordOnly drops the bare-rune members of the set for surfaces where a
// textinput or form field owns printable keys; ok reports consumption.
func (m Model) handleGlobalKey(msg tea.KeyMsg, chordOnly bool) (tea.Model, tea.Cmd, bool) {
	if chordOnly && !isModifierKey(msg.String()) {
		return m, nil, false
	}
	switch {
	case key.Matches(msg, m.keys.Quit):
		mm, cmd := m.quit()
		return mm, cmd, true
	case key.Matches(msg, m.keys.Palette):
		mm, cmd := m.openPalette()
		return mm, cmd, true
	case key.Matches(msg, m.keys.Help):
		mm, cmd := m.openHelp()
		return mm, cmd, true
	case key.Matches(msg, m.keys.Shell):
		mm, cmd := m.toggleShellDrawer()
		return mm, cmd, true
	case key.Matches(msg, m.keys.Reconnect):
		// A lost backend is not the paddock's problem alone: it must be
		// recoverable from whatever surface the user was on when it died.
		mm, cmd := m.reconnectNow()
		return mm, cmd, true
	}
	return m, nil, false
}

// isModifierKey reports whether a surface with a focused textinput or huh field
// may take the key: printable runes are that field's, modifier chords are not.
func isModifierKey(key string) bool {
	return strings.HasPrefix(key, "ctrl+") || strings.HasPrefix(key, "alt+")
}

// handleHelpKey swallows every key it does not act on: the paddock is still
// mounted behind the overlay and must not be reconfigured by keys the user
// aimed at the help screen.
func (m Model) handleHelpKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Quit) && isModifierKey(msg.String()):
		// The quit chord quits from every surface; its bare-rune alternate is how
		// the user closes the overlay they are looking at.
		return m.quit()
	case key.Matches(msg, m.keys.Esc), key.Matches(msg, m.keys.Quit), key.Matches(msg, m.keys.Help):
		m.popStage()
		return m, nil
	}
	return m, nil
}

func (m Model) handlePanelKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if key.Matches(msg, m.keys.Esc) {
		m.popStage()
		return m, nil
	}
	// g g (scroll to top) is the only chord a panel serves.
	m, cmd, handled := m.feedChord(msg)
	if handled {
		return m, cmd
	}
	if m.panelKind == "files" && m.filesBrowser != nil {
		if nm, ok := m.handleFilesPanelKey(msg); ok {
			return nm, nil
		}
	}
	if m.panelKind == "handoff" && m.caps.Launch && key.Matches(msg, m.keys.Activate) {
		return m.launchFromHandoff()
	}
	switch {
	case key.Matches(msg, m.keys.Up):
		m.panel.LineUp(1)
		return m, nil
	case key.Matches(msg, m.keys.Down):
		m.panel.LineDown(1)
		return m, nil
	case key.Matches(msg, m.keys.ScrollUp):
		m.panel.HalfPageUp()
		return m, nil
	case key.Matches(msg, m.keys.ScrollDown):
		m.panel.HalfPageDown()
		return m, nil
	case key.Matches(msg, m.keys.ScrollBottom):
		m.panel.GotoBottom()
		return m, nil
	}
	if mm, cmd, ok := m.handleGlobalKey(msg, false); ok {
		return mm, cmd
	}
	return m, nil
}

// handleFilesPanelKey drives the persistent files.Browser behind the files
// panel: without it the browser is rebuilt per render and can never move.
func (m Model) handleFilesPanelKey(msg tea.KeyMsg) (Model, bool) {
	b := m.filesBrowser
	switch {
	case key.Matches(msg, m.keys.Up):
		b.Move(-1)
	case key.Matches(msg, m.keys.Down):
		b.Move(1)
	case key.Matches(msg, m.keys.Activate), key.Matches(msg, m.keys.RegionNext):
		if _, err := b.Enter(); err != nil {
			m.notifyErr("files: " + err.Error())
		}
	case key.Matches(msg, m.keys.RegionPrev):
		if _, err := b.Up(); err != nil {
			m.notifyErr("files: " + err.Error())
		}
	default:
		return m, false
	}
	m.setPanelLines(filesPanelLines(b))
	return m, true
}

// onTable reports that the keyboard is on the agents table: the surface where a
// row is selected rather than typed at.
func (m Model) onTable() bool {
	return m.bodyStage() == StageTable && m.region == RegionMain
}

func (m Model) handleChromeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// From the table, a letter is a verb of the row under the cursor: the actions
	// menu is the discoverable route to the same dispatch, and the keys are the
	// fast one. Only the actions this session actually has are claimed.
	if m.onTable() && len(m.pending) == 0 {
		if mm, cmd, ok := m.runSessionAction(msg.String()); ok {
			return mm, cmd
		}
	}
	m, cmd, handled := m.feedChord(msg)
	if handled {
		return m, cmd
	}
	if action, ok := m.matchAction(msg); ok {
		if mm, cmd, ok := m.runAction(action); ok {
			return mm, cmd
		}
	}
	return m, nil
}

// enterInput hands the keyboard to the PTY the focused region owns: the shell
// drawer from RegionShell, else the focused pane. An open drawer must not claim
// the keyboard from anywhere else — that is what made an agent untypable for as
// long as the drawer was up.
func (m Model) enterInput() (tea.Model, tea.Cmd) {
	if m.region == RegionShell && m.shellOpen {
		m.inputTarget = targetShell
		m.mode = ModeInput
		m.clearChord()
		if m.shellStream == nil {
			m.notify("shell drawer attaching…")
		}
		return m, nil
	}
	if m.panes[m.focus].Stream != nil {
		m.inputTarget = targetPane
		m.region = RegionMain
		if m.bodyStage() == StageTable {
			// Typing at an agent the table is drawn over is typing blind: the
			// keyboard and the screen go to the same place.
			m.resetStage()
			m.stage = StageTerm
			m.resizeStreams()
		}
		m.panes[m.focus].scrollOff = 0
		m.mode = ModeInput
		m.clearChord()
	}
	return m, nil
}

// openFilter narrows the table live (k9s /). esc clears it; enter keeps it.
func (m Model) openFilter() (tea.Model, tea.Cmd) {
	if m.stage == StageFilter {
		return m, nil
	}
	if m.bodyStage() != StageTable {
		m.resetStage()
	}
	m.pushStage(StageFilter)
	m.region = RegionMain
	if m.table != nil {
		m.filterInput.SetValue(m.table.Filter())
	}
	m.filterInput.CursorEnd()
	return m, tea.Batch(m.filterInput.Focus(), textinput.Blink)
}

func (m *Model) closeFilter() {
	m.filterInput.Blur()
	m.popStage()
}

func (m Model) handleFilterKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Esc):
		m.filterInput.SetValue("")
		m.applyFilter("")
		m.closeFilter()
		return m, nil
	case key.Matches(msg, m.keys.Activate):
		m.closeFilter()
		return m, nil
	}
	// The filter input owns printable runes; only the chords are global.
	if mm, cmd, ok := m.handleGlobalKey(msg, true); ok {
		return mm, cmd
	}
	var cmd tea.Cmd
	m.filterInput, cmd = m.filterInput.Update(msg)
	m.applyFilter(m.filterInput.Value())
	return m, cmd
}

// applyFilter narrows the table and keeps the selection in step with it.
func (m *Model) applyFilter(q string) {
	if m.table == nil {
		return
	}
	m.table.SetFilter(q)
	m.syncFocusFromTable()
}

// toggleZen swaps the surface for the focused pane alone, and back. It goes
// through the stage stack like every other surface: a direct assignment strands
// the entry of whatever zen was raised over, and esc then walks a stale stack.
// The panes change size, so the PTYs behind them must be told.
func (m Model) toggleZen() (tea.Model, tea.Cmd) {
	if m.stage == StageZen {
		m.popStage()
	} else {
		m.pushStage(StageZen)
	}
	m.region = RegionMain
	m.resizeStreams()
	return m, nil
}

// shellHasKeyboard reports that keystrokes are going to the drawer's PTY.
func (m Model) shellHasKeyboard() bool {
	return m.mode == ModeInput && m.inputTarget == targetShell
}

// focusShell puts the chrome cursor on the drawer, opening it first when it is
// hidden: the drawer is otherwise reachable only by cycling every other region.
func (m Model) focusShell() (tea.Model, tea.Cmd) {
	if m.shellOpen {
		m.region = RegionShell
		return m, nil
	}
	return m.showShellDrawer()
}

func (m Model) focusPane(i int) (tea.Model, tea.Cmd) {
	if i < 0 || i >= domain.MaxPenSessions {
		return m, nil
	}
	var cmd tea.Cmd
	if i >= m.nPanes {
		// The slot holds a pen member the stage is not showing: asking for it
		// unfolds the grid far enough to put it on screen.
		if m.panes[i].SessionID == "" {
			return m, nil
		}
		nm, c := m.setPaneCount(i + 1)
		m, cmd = nm.(Model), c
	}
	m.focus = i
	m.region = RegionMain
	m.syncFocusSessionFromPane()
	return m, cmd
}

// scrollFocusedPane walks the focused pane's window back through scrollback
// (delta > 0) or forward toward live output (delta < 0).
func (m *Model) scrollFocusedPane(delta int) {
	m.scrollPane(m.focus, delta)
}

// scrollPane scrolls one pane's window. Alt-screen programs keep no history, so
// scrolling one is a no-op rather than a jump into rows that were never theirs.
func (m *Model) scrollPane(i, delta int) {
	if i < 0 || i >= domain.MaxPenSessions {
		return
	}
	p := &m.panes[i]
	if p.screen == nil || p.screen.AltScreen() {
		return
	}
	off := p.scrollOff + delta
	if off < 0 {
		off = 0
	}
	if hist := p.screen.ScrollbackLen(); off > hist {
		off = hist
	}
	p.scrollOff = off
}

// paneScrollPage is half a screen of the focused pane.
func (m Model) paneScrollPage() int {
	rows := 12
	if s := m.panes[m.focus].screen; s != nil && s.Rows() > 0 {
		rows = s.Rows()
	}
	return max(rows/2, 1)
}

func (m *Model) syncFocusSessionFromPane() {
	if m.focus >= 0 && m.focus < m.nPanes && m.panes[m.focus].SessionID != "" {
		m.focusSessionID = m.panes[m.focus].SessionID
	}
}

func (m *Model) cycleRegion(delta int) {
	// Visible regions only.
	regs := m.visibleRegions()
	if len(regs) == 0 {
		return
	}
	idx := 0
	for i, r := range regs {
		if r == m.region {
			idx = i
			break
		}
	}
	idx = (idx + delta + len(regs)*8) % len(regs)
	m.region = regs[idx]
}

// clampRegion snaps focus back to the surface when the region it is on is gone
// (the shell drawer was hidden).
func (m *Model) clampRegion() {
	for _, r := range m.visibleRegions() {
		if r == m.region {
			return
		}
	}
	m.region = RegionMain
}

func (m Model) visibleRegions() []Region {
	r := []Region{RegionMain}
	if m.shellOpen {
		r = append(r, RegionShell)
	}
	return r
}

// tableSessions is the table's view of the session list: every session has the
// name this client calls it, and a project to carry in its own column.
func (m Model) tableSessions() []domain.Session {
	sessions := make([]domain.Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		if m.nodeScope != "" && s.NodeID != m.nodeScope {
			continue
		}
		if s.ProjectID == "" && s.Cwd != "" {
			s.ProjectID = s.Cwd
		}
		s.Name = m.sessionName(s)
		sessions = append(sessions, s)
	}
	return sessions
}

// penBadges maps sessionID → pen label for the table. The implicit default pen
// is not a badge: one that every row carries tells the user nothing and costs the
// name the width it was printed in.
func penBadge(p domain.Pen) string {
	if p.ID == "" || p.ID == defaultPenID {
		return ""
	}
	if p.Name != "" {
		return p.Name
	}
	return p.ID
}

func (m Model) penBadges() map[string]string {
	badges := map[string]string{}
	if m.st != nil {
		for _, p := range m.st.Pens() {
			if label := penBadge(p); label != "" {
				for _, sid := range p.SessionIDs {
					badges[sid] = label
				}
			}
		}
	}
	// Active pen membership always badges (even if not yet in st.Pens).
	if label := penBadge(m.pen); label != "" {
		for _, sid := range m.pen.SessionIDs {
			badges[sid] = label
		}
	}
	return badges
}

// syncTable refreshes the table from the session list and pen membership.
// Rebuild re-anchors the cursor on the same session, which is why the table may
// only be rebuilt here — building it from a render or a key handler throws the
// cursor away on every repaint.
func (m *Model) syncTable() {
	if m.table == nil {
		m.table = uitable.Build(m.tableSessions())
	} else {
		m.table.Rebuild(m.tableSessions())
	}
	m.table.SetPenBadges(m.penBadges())
}

func (m *Model) moveTableCursor(delta int) {
	if m.table == nil || m.table.Len() == 0 {
		return
	}
	m.table.Move(delta)
	m.syncFocusFromTable()
}

// setTableCursor parks the cursor on a row (a click, not a step).
func (m *Model) setTableCursor(i int) {
	if m.table == nil {
		return
	}
	m.table.SetCursor(i)
	m.syncFocusFromTable()
}

func (m *Model) syncFocusFromTable() {
	if sid := m.table.SelectedSessionID(); sid != "" {
		m.focusSessionID = sid
	}
}

// activateTableSelection drills into the selected agent: its terminal takes the
// whole window, and esc comes back to the table.
func (m Model) activateTableSelection() (tea.Model, tea.Cmd) {
	if m.table == nil {
		return m, nil
	}
	sid := m.table.SelectedSessionID()
	if sid == "" {
		return m, nil
	}
	return m.focusSessionIntoPen(m.sessionOrPlaceholder(sid))
}

// sessionOrPlaceholder looks a session up by id, synthesizing a stand-in when
// the list has not caught up with the backend yet.
func (m Model) sessionOrPlaceholder(id string) domain.Session {
	for _, s := range m.sessions {
		if s.ID == id {
			return s
		}
	}
	return domain.Session{ID: id, Name: id, Status: domain.StatusIdle}
}

// applyActivePen loads the store's active pen (or m.pen) into pane slots.
//
// Pen membership is a set but pane assignment is positional, so a session that
// stays in the pen can still land on a different pane. Every pane whose occupant
// changes therefore drops its stream — keeping it by membership alone left a
// live PTY on the old index while another session's title was written over it,
// and switchToPen (which re-attaches the panes with no stream) never repaired it.
func (m *Model) applyActivePen(p domain.Pen) {
	if p.ID == "" {
		return
	}
	m.pen = p
	n := len(p.SessionIDs)
	if n > domain.MaxPenSessions {
		n = domain.MaxPenSessions
	}
	if n < 1 {
		n = 1
	}
	m.nPanes = n
	if p.Layout != "" {
		m.pen.Layout = p.Layout
	} else {
		m.pen.Layout = defaultLayoutForN(n)
	}

	// The new occupant of every slot, by index (empty = no session).
	var sids [domain.MaxPenSessions]string
	for i := 0; i < n && i < len(p.SessionIDs); i++ {
		sids[i] = p.SessionIDs[i]
	}

	byID := map[string]domain.Session{}
	for _, s := range m.sessions {
		byID[s.ID] = s
	}
	for i := 0; i < domain.MaxPenSessions; i++ {
		if m.panes[i].SessionID != sids[i] {
			if m.panes[i].Stream != nil {
				_ = m.panes[i].Stream.Close()
				m.panes[i].Stream = nil
			}
			m.nextEpoch(i)
			m.panes[i].AttachErr = ""
			m.panes[i].scrollOff = 0
		}
		if sids[i] == "" {
			m.panes[i].SessionID = ""
			m.panes[i].Title = fmt.Sprintf("pane %d", i+1)
			m.panes[i].Status = domain.StatusDisconnected
			m.panes[i].EmptyMsg = m.emptyPaneMsg()
			continue
		}
		s, ok := byID[sids[i]]
		if !ok {
			s = domain.Session{ID: sids[i], Name: sids[i], Status: domain.StatusDisconnected}
		}
		m.panes[i].SessionID = s.ID
		m.panes[i].Title = m.paneTitle(s)
		m.panes[i].Status = s.Status
		if s.Status == "" {
			m.panes[i].Status = domain.StatusIdle
		}
		m.panes[i].Telemetry = s.Telemetry
	}
	if sids[0] != "" {
		m.focusSessionID = sids[0]
	}
	m.focus = 0
	m.resetStage()
	m.stage = StagePen
	m.region = RegionMain
	m.syncTable()
}

// switchToPen makes penID active and loads it into panes.
// Flushes the current pen's pane membership into the store first so switch-away
// then switch-back does not drop sessions only held on panes after launch/assign.
func (m Model) switchToPen(penID string) (tea.Model, tea.Cmd) {
	if m.st == nil {
		m.notifyErr("no pen store")
		return m, nil
	}
	m.flushActivePenMembership()
	p, ok := m.st.Pen(penID)
	if !ok {
		m.notifyErr("pen not found")
		return m, nil
	}
	_ = m.st.SwitchActivePen("(default)", penID)
	m.applyActivePen(p)
	m.notify("pen: " + p.Name)
	if m.pensPath != "" {
		if err := m.st.SavePens(m.pensPath); err != nil {
			m.notifyErrf("pens: %v", err)
		}
	}
	// re-attach PTYs for pen sessions
	var cmds []tea.Cmd
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == "" || m.panes[i].Stream != nil || m.be == nil {
			continue
		}
		cmds = append(cmds, m.attachPaneCmd(i, m.nextEpoch(i), m.panes[i].SessionID))
	}
	return m, tea.Batch(cmds...)
}

func (m Model) openPalette() (tea.Model, tea.Cmd) {
	if m.stage == StagePalette {
		// The palette key over an open palette is a no-op, not a re-open: it may
		// not throw away the filter the user has already typed.
		return m, nil
	}
	m.pushStage(StagePalette)
	m.paletteQuery = ""
	m.paletteCursor = 0
	m.palInput.SetValue("")
	focus := m.palInput.Focus()
	m.rebuildPaletteItems()
	return m, tea.Batch(focus, textinput.Blink)
}

func (m Model) openHelp() (tea.Model, tea.Cmd) {
	if m.stage == StageHelp {
		return m, nil
	}
	m.pushStage(StageHelp)
	return m, nil
}

func (m Model) openLaunch() (tea.Model, tea.Cmd) {
	cwd, _ := os.Getwd()
	return m.openLaunchIn(cwd)
}

func (m Model) openLaunchIn(cwd string) (tea.Model, tea.Cmd) {
	// Charm Huh form (select agent · cwd · confirm).
	form, vals := newLaunchForm(cwd, m.theme)
	m.launchForm = form
	m.launchVals = vals
	m.pushStage(StageLaunch)
	m.region = RegionMain
	return m, m.launchForm.Init()
}

func (m Model) cmdNewPen() (tea.Model, tea.Cmd) {
	if m.st == nil {
		m.st = store.New()
	}
	// Persist current pen membership before creating a new empty pen.
	m.flushActivePenMembership()
	name := fmt.Sprintf("Pen %d", len(m.st.Pens())+1)
	p, err := m.st.CreatePen("(default)", "", name, domain.PenLayoutCols)
	if err != nil {
		m.notifyErr(err.Error())
		return m, nil
	}
	m.applyActivePen(p)
	m.notifyOK("created pen " + p.Name + " · switch via palette")
	if m.pensPath != "" {
		if err := m.st.SavePens(m.pensPath); err != nil {
			m.notifyErrf("pens: %v", err)
		}
	}
	return m, nil
}

// closeLaunch tears the wizard down and returns to the surface it was opened
// over.
func (m *Model) closeLaunch() {
	m.launchForm = nil
	m.launchVals = nil
	m.popStage()
}

// advanceLaunchForm feeds msg to the huh launch form and applies its terminal
// states. huh only reaches StateCompleted while handling messages produced by
// its own commands, so this must run for every message, not just key presses.
// ok reports whether a form was open to receive msg.
func (m Model) advanceLaunchForm(msg tea.Msg) (Model, tea.Cmd, bool) {
	if m.launchForm == nil {
		return m, nil, false
	}
	form, cmd := m.launchForm.Update(msg)
	if f, ok := form.(*huh.Form); ok {
		m.launchForm = f
	}
	switch m.launchForm.State {
	case huh.StateCompleted:
		vals := m.launchVals
		m.closeLaunch()
		if vals == nil || !vals.ok {
			m.launchSeed = ""
			m.notify("launch cancelled")
			return m, nil, true
		}
		agent, err := launch.ParseAgent(vals.agent)
		if err != nil {
			m.launchSeed = ""
			m.notifyErr(err.Error())
			return m, nil, true
		}
		return m, m.cmdLaunchAgent(launch.Spec{Agent: agent, Cwd: vals.cwd}), true
	case huh.StateAborted:
		m.closeLaunch()
		m.launchSeed = ""
		m.notify("launch cancelled")
		return m, nil, true
	}
	return m, cmd, true
}

func (m Model) handleLaunchKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.launchForm == nil {
		m.popStage()
		return m, nil
	}
	if key.Matches(msg, m.keys.Esc) {
		m.closeLaunch()
		return m, nil
	}
	// A huh field owns every printable rune, so only the chords are global.
	if mm, cmd, ok := m.handleGlobalKey(msg, true); ok {
		return mm, cmd
	}
	nm, cmd, _ := m.advanceLaunchForm(msg)
	return nm, cmd
}

func (m Model) cmdGitCommit() tea.Cmd {
	s, ok := m.focusedSession()
	cwd := ""
	if ok {
		cwd = s.Cwd
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		msg := fmt.Sprintf("shep-tui commit %s", time.Now().Format("15:04:05"))
		if err := gitpanel.CommitLoop(ctx, gitpanel.LocalGit{}, cwd, msg); err != nil {
			return gitCommitMsg{err: err}
		}
		return gitCommitMsg{ok: "committed in " + cwd}
	}
}

// gitCommitMsg is a chrome status update after commit.
type gitCommitMsg struct {
	err error
	ok  string
}

func (m Model) cmdLaunchAgent(spec launch.Spec) tea.Cmd {
	if m.be == nil {
		return func() tea.Msg {
			return spawnDoneMsg{err: fmt.Errorf("no backend")}
		}
	}
	res, err := launch.Build(spec)
	if err != nil {
		return func() tea.Msg { return spawnDoneMsg{err: err} }
	}
	be := m.be
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := be.LaunchAgent(ctx, res.ID, res.Kind, res.Cwd, res.Command, res.Cols, res.Rows); err != nil {
			return spawnDoneMsg{err: err}
		}
		at := domain.AgentType(string(spec.Agent))
		if at == "" {
			at = domain.AgentGeneric
		}
		return spawnDoneMsg{session: domain.Session{
			ID:        res.ID,
			Name:      res.ID,
			AgentType: at,
			Cwd:       res.Cwd,
			Status:    domain.StatusStarting,
		}}
	}
}

// resolveRespondTarget is the session the respond bar writes to: the selected
// session, and only when it is live in a pane. A selection that is not attached
// resolves to nothing — retargeting the reply at the focused pane's agent would
// send the user's answer to a different agent than the one they picked.
//
// The focused-pane arm stays reachable because syncFocusSessionFromPane parks
// focusSessionID on the focused pane's session whenever pane focus moves.
func (m Model) resolveRespondTarget() string {
	if m.focusSessionID != "" {
		for i := 0; i < m.nPanes; i++ {
			if m.panes[i].SessionID == m.focusSessionID && m.panes[i].Stream != nil {
				return m.focusSessionID
			}
		}
		return ""
	}
	if m.focus >= 0 && m.focus < m.nPanes && m.panes[m.focus].Stream != nil {
		return m.panes[m.focus].SessionID
	}
	return ""
}

func (m Model) openRespond() (tea.Model, tea.Cmd) {
	target := m.resolveRespondTarget()
	if target == "" {
		id := m.focusSessionID
		if id == "" {
			id = "session"
		}
		m.notifyErr(fmt.Sprintf("respond: %s is not attached to a pane", domain.ShortID(id)))
		return m, nil
	}
	m.pushStage(StageRespond)
	m.region = RegionMain
	m.respondTarget = target
	m.respondDraft = ""
	m.respondInput.SetValue("")
	focus := m.respondInput.Focus()
	return m, tea.Batch(focus, textinput.Blink)
}

// buildPaletteCatalog returns the full ordered catalog for the command palette.
// Groups are stable so empty-query browsing is predictable (Navigate → Settings).
//
// The palette is global: what can be done *to an agent* lives on the agent, in
// the actions menu, where the list can say which of those things are possible.
func (m Model) buildPaletteCatalog() []uipalette.Command {
	cmds := []uipalette.Command{
		{ID: "action:table", Title: "Agents table", Group: palGroupNavigate},
		{ID: "action:pens", Title: "Pens · multi-pane grid", Group: palGroupNavigate},
		{ID: "action:nodes", Title: "Nodes · the hosts agents run on", Group: palGroupNavigate},
		{ID: "action:filter", Title: "Filter agents…", Group: palGroupNavigate},
		{ID: "action:actions", Title: "Session actions…", Group: palGroupNavigate},
		{ID: "action:zen", Title: "Zen · focus one pane", Group: palGroupNavigate},
	}
	if m.caps.ShellDrawer {
		cmds = append(cmds,
			uipalette.Command{ID: "action:shell", Title: "Shell drawer · toggle", Group: palGroupNavigate},
			uipalette.Command{ID: "action:focusshell", Title: "Shell drawer · focus", Group: palGroupNavigate},
		)
	}
	cmds = append(cmds,
		uipalette.Command{ID: "action:region:next", Title: "Region · next", Group: palGroupNavigate},
		uipalette.Command{ID: "action:region:prev", Title: "Region · previous", Group: palGroupNavigate},
	)
	if m.caps.Launch {
		cmds = append(cmds,
			uipalette.Command{ID: "action:launch", Title: "Launch agent…", Group: palGroupAgents},
			uipalette.Command{ID: "action:spawn", Title: "Spawn shell session", Group: palGroupAgents},
		)
	}
	cmds = append(cmds, uipalette.Command{ID: "action:newpen", Title: "New pen", Group: palGroupPens})
	if m.caps.Cost {
		cmds = append(cmds, uipalette.Command{ID: "action:cost", Title: "Cost table", Group: palGroupInspect})
	}
	cmds = append(cmds, uipalette.Command{ID: "action:compare", Title: "Run-N compare", Group: palGroupInspect})
	if m.caps.Audit {
		cmds = append(cmds, uipalette.Command{ID: "action:audit", Title: "Audit log", Group: palGroupInspect})
	}
	cmds = append(cmds, []uipalette.Command{
		{ID: "action:settings", Title: "Settings…", Group: palGroupSettings},
		{ID: "action:theme", Title: "Theme: cycle auto/dark/light", Group: palGroupSettings},
		{ID: "action:profile", Title: "Switch backend profile", Group: palGroupSettings},
		{ID: "action:layout:cols", Title: "Pen layout · columns", Group: palGroupPens},
		{ID: "action:layout:rows", Title: "Pen layout · rows", Group: palGroupPens},
		{ID: "action:layout:grid2x2", Title: "Pen layout · 2×2 grid", Group: palGroupPens},
		{ID: "action:layout:main+stack", Title: "Pen layout · main + stack", Group: palGroupPens},
		{ID: "action:pen:solo", Title: "Pen layout · single pane", Group: palGroupPens},
		{ID: "action:help", Title: "Help overlay", Group: palGroupSettings},
		{ID: "action:quit", Title: "Quit shep-tui", Group: palGroupSettings},
	}...)
	for i := 0; i < domain.MaxPenSessions; i++ {
		if i >= m.nPanes && m.panes[i].SessionID == "" {
			continue
		}
		title := fmt.Sprintf("Focus pane %d", i+1)
		if sid := m.panes[i].SessionID; sid != "" {
			title += " · " + m.panes[i].Title
		}
		cmds = append(cmds, uipalette.Command{
			ID:    fmt.Sprintf("action:pane:%d", i+1),
			Title: title,
			Group: palGroupNavigate,
		})
	}
	if m.nodeScope != "" {
		cmds = append(cmds, uipalette.Command{
			ID:    "action:nodes:all",
			Title: "Nodes · all (clear the " + m.nodeScopeName() + " scope)",
			Group: palGroupNavigate,
		})
	}
	if m.caps.MultiNode {
		cmds = append(cmds, uipalette.Command{
			ID:    "action:node:add",
			Title: "Add node…",
			Group: palGroupAgents,
		})
	}
	if m.st != nil {
		for _, p := range m.st.Pens() {
			name := p.Name
			if name == "" {
				name = p.ID
			}
			title := "Switch pen · " + name
			if p.ID == m.pen.ID {
				title += "  (active)"
			}
			cmds = append(cmds, uipalette.Command{
				ID:    "pen:" + p.ID,
				Title: title,
				Group: palGroupPens,
			})
		}
	}
	for _, s := range m.sessions {
		name := s.Name
		if name == "" {
			name = s.ID
		}
		cmds = append(cmds, uipalette.Command{
			ID:    "session:" + s.ID,
			Title: name + " · " + s.Status.Label(),
			Group: palGroupSessions,
		})
	}
	return cmds
}

// paletteHintActions ties a palette row to the action that runs it, so the chip
// beside it is the key the app dispatches today — a hand-typed chip is wrong by
// construction the moment someone rebinds anything.
var paletteHintActions = map[string]keybinds.Action{
	"action:table":       keybinds.ActionEsc,
	"action:pens":        keybinds.ActionPens,
	"action:nodes":       keybinds.ActionNodes,
	"action:filter":      keybinds.ActionFilter,
	"action:actions":     keybinds.ActionActions,
	"action:launch":      keybinds.ActionLaunch,
	"action:help":        keybinds.ActionHelp,
	"action:quit":        keybinds.ActionQuit,
	"action:zen":         keybinds.ActionZen,
	"action:shell":       keybinds.ActionShellDrawer,
	"action:focusshell":  keybinds.ActionFocusShell,
	"action:region:next": keybinds.ActionRegionNext,
	"action:region:prev": keybinds.ActionRegionPrev,
	"action:pane:1":      keybinds.ActionFocusPane1,
	"action:pane:2":      keybinds.ActionFocusPane2,
	"action:pane:3":      keybinds.ActionFocusPane3,
	"action:pane:4":      keybinds.ActionFocusPane4,
}

func (m Model) paletteHint(id string) string {
	action, ok := paletteHintActions[id]
	if !ok {
		return ""
	}
	return keybinds.FormatChord(m.binds().Sequence(action))
}

func (m *Model) rebuildPaletteItems() {
	cat := m.buildPaletteCatalog()
	p := uipalette.New()
	p.SetItems(cat)
	p.Cursor = m.paletteCursor
	p.Filter(m.paletteQuery)

	// Status lookup for session rows.
	byID := map[string]domain.Session{}
	for _, s := range m.sessions {
		byID[s.ID] = s
	}

	items := make([]paletteItem, 0, len(p.Filtered))
	for _, c := range p.Filtered {
		it := paletteItem{
			ID:    c.ID,
			Label: c.Title,
			Group: c.Group,
			Hint:  m.paletteHint(c.ID),
			Kind:  "action",
		}
		switch {
		case strings.HasPrefix(c.ID, "session:"):
			it.Kind = "session"
			sid := strings.TrimPrefix(c.ID, "session:")
			if s, ok := byID[sid]; ok {
				it.Status = s.Status
			}
		case strings.HasPrefix(c.ID, "pen:"):
			it.Kind = "pen"
		}
		items = append(items, it)
	}
	m.paletteItems = items
	m.paletteCursor = p.Cursor
	if m.paletteCursor >= len(m.paletteItems) {
		m.paletteCursor = max(0, len(m.paletteItems)-1)
	}
}

// paletteRow is one drawn line of the palette's result list: an item, or the
// group header that introduces it.
type paletteRow struct {
	item  int    // index into paletteItems; < 0 for a header
	group string // header text
}

// paletteMaxRows is how many result rows fit under the filter input.
func (m Model) paletteMaxRows() int {
	if m.height > 0 {
		// Leave room for title, body, search, footer.
		return min(12, max(6, m.height/3))
	}
	return 10
}

// paletteRows is the palette's result list as drawn, top to bottom. renderPalette
// and click hit-testing both read it, so a click can never land on a row the
// renderer put somewhere else.
func (m Model) paletteRows() []paletteRow {
	start, end := visibleWindow(len(m.paletteItems), m.paletteCursor, m.paletteMaxRows())
	rows := make([]paletteRow, 0, end-start)
	lastGroup := ""
	for i := start; i < end; i++ {
		if g := m.paletteItems[i].Group; g != "" && g != lastGroup {
			lastGroup = g
			rows = append(rows, paletteRow{item: -1, group: g})
		}
		rows = append(rows, paletteRow{item: i})
	}
	return rows
}

// closePalette dismisses the palette and returns to the surface it was opened
// over.
func (m *Model) closePalette() {
	m.paletteQuery = ""
	m.palInput.Blur()
	m.palInput.SetValue("")
	m.popStage()
}

func (m Model) handlePaletteKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Esc):
		m.closePalette()
		return m, nil
	case key.Matches(msg, listKeys.Up):
		if len(m.paletteItems) > 0 {
			m.paletteCursor = (m.paletteCursor - 1 + len(m.paletteItems)) % len(m.paletteItems)
		}
		return m, nil
	case key.Matches(msg, listKeys.Down):
		if len(m.paletteItems) > 0 {
			m.paletteCursor = (m.paletteCursor + 1) % len(m.paletteItems)
		}
		return m, nil
	case key.Matches(msg, listKeys.GroupNext):
		m.paletteCursor = nextPaletteGroupStart(m.paletteItems, m.paletteCursor)
		return m, nil
	case key.Matches(msg, listKeys.GroupPrev):
		m.paletteCursor = prevPaletteGroupStart(m.paletteItems, m.paletteCursor)
		return m, nil
	case key.Matches(msg, m.keys.Activate):
		return m.runPaletteSelection()
	}

	// The palette is an overlay like any other: the global chords (quit, help,
	// shell drawer, reconnect) must survive it — its own help advertises them,
	// and ctrl+r is what the reconnect banner tells the user to press. chordOnly,
	// so printable runes stay typable in the filter. Its own key is a no-op here
	// rather than a re-open, which openPalette already guards.
	if mm, cmd, ok := m.handleGlobalKey(msg, true); ok {
		return mm, cmd
	}

	// All other keys go to bubbles textinput (filter).
	var cmd tea.Cmd
	m.palInput, cmd = m.palInput.Update(msg)
	m.paletteQuery = m.palInput.Value()
	m.paletteCursor = 0
	m.rebuildPaletteItems()
	return m, cmd
}

// nextPaletteGroupStart moves cursor to the first item of the next distinct group.
func nextPaletteGroupStart(items []paletteItem, cursor int) int {
	if len(items) == 0 {
		return 0
	}
	if cursor < 0 || cursor >= len(items) {
		return 0
	}
	cur := items[cursor].Group
	for i := cursor + 1; i < len(items); i++ {
		if items[i].Group != cur {
			return i
		}
	}
	return 0 // wrap to first group
}

func prevPaletteGroupStart(items []paletteItem, cursor int) int {
	if len(items) == 0 {
		return 0
	}
	if cursor <= 0 {
		// last group's start
		g := items[len(items)-1].Group
		start := len(items) - 1
		for start > 0 && items[start-1].Group == g {
			start--
		}
		return start
	}
	cur := items[cursor].Group
	// walk back to start of current group, then previous group
	i := cursor
	for i > 0 && items[i-1].Group == cur {
		i--
	}
	if i == 0 {
		g := items[len(items)-1].Group
		start := len(items) - 1
		for start > 0 && items[start-1].Group == g {
			start--
		}
		return start
	}
	// start of previous group
	prevG := items[i-1].Group
	start := i - 1
	for start > 0 && items[start-1].Group == prevG {
		start--
	}
	return start
}

func (m Model) runPaletteSelection() (tea.Model, tea.Cmd) {
	if len(m.paletteItems) == 0 || m.paletteCursor < 0 || m.paletteCursor >= len(m.paletteItems) {
		// Enter on nothing is nothing: closing the palette here threw the user's
		// query away and dumped them on whatever was behind it.
		m.notify("no matches — refine the filter or esc to close")
		return m, nil
	}
	item := m.paletteItems[m.paletteCursor]
	m.closePalette()
	switch {
	case item.ID == "action:quit":
		return m.quit()
	case item.ID == "action:table":
		m.resetStage()
		m.region = RegionMain
		return m, nil
	case item.ID == "action:pens":
		return m.openPens()
	case item.ID == "action:nodes":
		return m.openNodes()
	case item.ID == "action:nodes:all":
		m.clearNodeScope()
		return m, nil
	case item.ID == "action:node:add":
		return m.openAddNode()
	case item.ID == "action:filter":
		return m.openFilter()
	case item.ID == "action:launch":
		return m.openLaunch()
	case item.ID == "action:newpen":
		return m.cmdNewPen()
	case item.ID == "action:zen":
		return m.toggleZen()
	case item.ID == "action:shell":
		return m.toggleShellDrawer()
	case item.ID == "action:focusshell":
		return m.focusShell()
	case item.ID == "action:region:next":
		m.cycleRegion(1)
		return m, nil
	case item.ID == "action:region:prev":
		m.cycleRegion(-1)
		return m, nil
	case strings.HasPrefix(item.ID, "action:pane:"):
		n, err := strconv.Atoi(strings.TrimPrefix(item.ID, "action:pane:"))
		if err != nil {
			return m, nil
		}
		return m.focusPane(n - 1)
	case item.ID == "action:spawn":
		return m, m.cmdSpawnShell()
	case item.ID == "action:actions":
		return m.openSessionActions()
	case item.ID == "action:cost":
		return m.openPanel("cost", m.buildCostPanelLines())
	case item.ID == "action:compare":
		return m.openPanel("compare", m.buildComparePanelLines())
	case item.ID == "action:audit":
		return m.openPanelAsync("audit", auditPanelLoader(m.be))
	case item.ID == "action:theme":
		return m.cycleTheme()
	case item.ID == "action:settings":
		return m.openSettings()
	case item.ID == "action:profile":
		return m.openSettingsAt(settingRowProfile)
	case item.ID == "action:pen:solo":
		return m.setPaneCount(1)
	case strings.HasPrefix(item.ID, "action:layout:"):
		return m.setPenLayout(domain.PenLayout(strings.TrimPrefix(item.ID, "action:layout:")))
	case item.ID == "action:help":
		m.notify("help")
		return m.openHelp()
	case strings.HasPrefix(item.ID, "pen:"):
		return m.switchToPen(strings.TrimPrefix(item.ID, "pen:"))
	case strings.HasPrefix(item.ID, "session:"):
		sid := strings.TrimPrefix(item.ID, "session:")
		return m.focusSessionIntoPen(m.sessionOrPlaceholder(sid))
	}
	return m, nil
}

// focusSessionIntoPen is the one way a session becomes the drilled-into agent:
// the table, the palette and a fresh launch all land here, and the agent's
// terminal takes the whole window (k9s: enter on a row replaces the screen).
//
// The stage is set before the pane is assigned, because the PTY is opened at the
// size of the box it is about to be drawn in.
func (m Model) focusSessionIntoPen(s domain.Session) (tea.Model, tea.Cmd) {
	m.focusSessionID = s.ID
	m.resetStage()
	m.stage = StageTerm
	m.region = RegionMain
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == s.ID {
			m.focus = i
			m.resizeStreams()
			return m, nil
		}
	}
	// Replace focused pane.
	if m.panes[m.focus].Stream != nil {
		_ = m.panes[m.focus].Stream.Close()
		m.panes[m.focus].Stream = nil
		m.nextEpoch(m.focus)
	}
	return m.assignSessionToPane(m.focus, s)
}

// openPens shows the multi-pane grid: the pen the user arranged, with every
// member that has no PTY yet re-attached.
func (m Model) openPens() (tea.Model, tea.Cmd) {
	if m.bodyStage() == StagePen {
		m.resetStage()
		m.resizeStreams()
		return m, nil
	}
	m.resetStage()
	m.stage = StagePen
	m.region = RegionMain
	if n := len(m.pen.SessionIDs); n > 0 {
		m.nPanes = min(n, domain.MaxPenSessions)
	}
	m.resizeStreams()
	return m, m.attachPenPanesCmd()
}

// attachPenPanesCmd opens a PTY for every visible pen member that has none.
func (m *Model) attachPenPanesCmd() tea.Cmd {
	if m.be == nil {
		return nil
	}
	var cmds []tea.Cmd
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == "" || m.panes[i].Stream != nil {
			continue
		}
		cmds = append(cmds, m.attachPaneCmd(i, m.nextEpoch(i), m.panes[i].SessionID))
	}
	return tea.Batch(cmds...)
}

func (m Model) cmdSpawnShell() tea.Cmd {
	if m.be == nil {
		return func() tea.Msg {
			return spawnDoneMsg{err: fmt.Errorf("no backend")}
		}
	}
	be := m.be
	id := fmt.Sprintf("shell-%d", time.Now().UnixNano()%1_000_000)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := be.CreateShell(ctx, id, "", 80, 24)
		if err != nil {
			return spawnDoneMsg{err: err}
		}
		return spawnDoneMsg{session: domain.Session{
			ID:     id,
			Name:   id,
			Status: domain.StatusIdle,
		}}
	}
}

// closeRespond dismisses the respond bar and returns to the surface it was
// opened over.
func (m *Model) closeRespond() {
	m.respondDraft = ""
	m.respondTarget = ""
	m.respondInput.Blur()
	m.respondInput.SetValue("")
	m.popStage()
}

func (m Model) handleRespondKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch {
	case key.Matches(msg, m.keys.Esc):
		m.closeRespond()
		return m, nil
	case key.Matches(msg, m.keys.Activate):
		m.respondDraft = m.respondInput.Value()
		return m.sendRespond()
	}
	// The respond textinput owns printable runes; only the chords are global.
	if mm, cmd, ok := m.handleGlobalKey(msg, true); ok {
		return mm, cmd
	}
	var cmd tea.Cmd
	m.respondInput, cmd = m.respondInput.Update(msg)
	m.respondDraft = m.respondInput.Value()
	return m, cmd
}

func (m Model) sendRespond() (tea.Model, tea.Cmd) {
	text := m.respondDraft
	if text == "" {
		text = m.respondInput.Value()
	}
	target := m.respondTarget
	m.closeRespond()

	var stream backend.PtyStream
	for i := 0; i < m.nPanes; i++ {
		if target != "" && m.panes[i].SessionID == target && m.panes[i].Stream != nil {
			stream = m.panes[i].Stream
			break
		}
	}
	if stream == nil {
		m.notifyErr("respond: target detached")
		return m, nil
	}
	payload := text
	if !strings.HasSuffix(payload, "\n") && !strings.HasSuffix(payload, "\r") {
		payload += "\r"
	}
	_, err := stream.Write([]byte(payload))
	if err != nil {
		m.notifyErrf("respond: %v", err)
	} else {
		m.notifyOK("respond sent")
	}
	return m, nil
}

func (m Model) handleInputKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// Detach and the drawer chord are the only chords input mode may swallow
	// (PRODUCT.md §7.3): every other chrome prefix is a key the agent is
	// entitled to receive — including a bare ctrl+j, which is LF.
	seq := m.chordKeys(msg)
	if len(seq) > 1 {
		if action, ok := m.km.ResolveIn(seq, inputChordActions...); ok {
			m.clearChord()
			if action == keybinds.ActionShellDrawer {
				return m.toggleShellDrawer()
			}
			m.mode = ModeChrome
			m.inputTarget = targetPane
			return m, nil
		}
	}
	if m.km.PrefixOf(seq, inputChordActions...) {
		return m, m.armChord(msg)
	}

	// Chord cancelled: the prefix keys were never host keys, so they go to the
	// agent — this is how a literal ctrl+g (BEL) is sent.
	flushed := m.pending
	m.clearChord()

	if m.inputTarget == targetShell && m.shellStream == nil {
		// The drawer's attach is still in flight. Dropping the key is the only
		// honest option: the pane PTY is not what the user is typing at.
		m.notify("shell drawer attaching…")
		return m, nil
	}
	if m.inputStream() == nil {
		m.mode = ModeChrome
		return m, nil
	}
	m.writeToPty(append(flushed, msg)...)
	return m, nil
}

// inputStream is the PTY that owns the keyboard in ModeInput.
func (m Model) inputStream() backend.PtyStream {
	if m.inputTarget == targetShell {
		return m.shellStream
	}
	return m.panes[m.focus].Stream
}

// writeToPty forwards keys to the input target, reporting what it could not
// send: a key that maps to no bytes, or a stream that refused them.
func (m *Model) writeToPty(msgs ...tea.KeyMsg) {
	stream := m.inputStream()
	if stream == nil {
		return
	}
	var b []byte
	for _, msg := range msgs {
		bytes := keyToBytes(msg)
		if len(bytes) == 0 {
			m.notifyErr("unmapped key: " + msg.String())
			continue
		}
		b = append(b, bytes...)
	}
	if len(b) == 0 {
		return
	}
	if _, err := stream.Write(b); err != nil {
		m.notifyErrf("pty write: %v", err)
	}
}

// toggleShellDrawer shows/hides the secondary shell drawer (not a pen slot).
func (m Model) toggleShellDrawer() (tea.Model, tea.Cmd) {
	if m.shellOpen {
		return m.hideShellDrawer()
	}
	return m.showShellDrawer()
}

// showShellDrawer opens the drawer and attaches its PTY. A backend without
// Caps.ShellDrawer has no CreateShell, so there is no drawer to open and none is
// drawn. It never touches mode or inputTarget: from ModeInput the drawer appears
// while the sentence the user is typing keeps going to the agent.
func (m Model) showShellDrawer() (tea.Model, tea.Cmd) {
	if !m.caps.ShellDrawer {
		return m, nil
	}
	m.shellOpen = true
	m.notify("shell drawer open · i to type · ctrl+g g detach")
	if m.shellScreen == nil {
		m.shellScreen = vt.New(80, shellDrawerMinH, m.scrollback())
	}
	if m.mode == ModeChrome {
		m.region = RegionShell
	}
	m.resizeStreams()

	// Already attached.
	if m.shellStream != nil {
		return m, nil
	}
	if m.be == nil {
		m.notifyErr("shell drawer: no backend")
		return m, nil
	}
	return m, m.cmdOpenShellDrawer()
}

// hideShellDrawer hides the drawer, keeping its stream alive so re-opening is
// instant. The keyboard only moves when it was the drawer's: typing blind into
// a PTY that is no longer on screen is worse than a detach.
func (m Model) hideShellDrawer() (tea.Model, tea.Cmd) {
	m.shellOpen = false
	if m.shellHasKeyboard() {
		m.mode = ModeChrome
		m.inputTarget = targetPane
		m.clearChord()
	}
	m.clampRegion()
	m.notify("shell drawer closed")
	m.resizeStreams()
	return m, nil
}

func (m Model) cmdOpenShellDrawer() tea.Cmd {
	be := m.be
	if be == nil {
		return nil
	}
	id := shellDrawerID
	cols, rows := m.shellDrawerSize()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := be.CreateShell(ctx, id, "", cols, rows); err != nil {
			if !errors.Is(err, backend.ErrNotSupported) {
				// Re-create may fail if already exists — try attach anyway.
			} else {
				return shellDrawerMsg{err: err}
			}
		}
		stream, err := be.OpenPty(ctx, id, cols, rows)
		if err != nil {
			return shellDrawerMsg{err: err}
		}
		return shellDrawerMsg{id: id, stream: stream}
	}
}

func (m Model) shellDrawerSize() (cols, rows uint16) {
	w := m.width
	if w < 20 {
		w = 80
	}
	h := shellDrawerHeight(m.height)
	cols = uint16(max(w-4, 10))
	rows = uint16(max(h-2, 4))
	return cols, rows
}

func shellDrawerHeight(termH int) int {
	if termH <= 0 {
		return shellDrawerMinH
	}
	// ~1/3 of body, clamped.
	h := termH / 3
	if h < shellDrawerMinH {
		h = shellDrawerMinH
	}
	if h > shellDrawerMaxH {
		h = shellDrawerMaxH
	}
	if h >= termH-4 {
		h = max(termH/4, 4)
	}
	return h
}

type shellDrawerMsg struct {
	id     string
	stream backend.PtyStream
	err    error
}

type shellOutputMsg struct {
	data []byte
}

// escapeKeys are the keys whose byte form is an escape sequence rather than a
// character. Modified arrows/Home/End use the xterm CSI 1;<mod> form, where the
// modifier is 2=shift, 5=ctrl, 6=ctrl+shift (alt is the ESC prefix keyToBytes adds).
var escapeKeys = map[tea.KeyType]string{
	tea.KeyUp:         "\x1b[A",
	tea.KeyDown:       "\x1b[B",
	tea.KeyRight:      "\x1b[C",
	tea.KeyLeft:       "\x1b[D",
	tea.KeyHome:       "\x1b[H",
	tea.KeyEnd:        "\x1b[F",
	tea.KeyPgUp:       "\x1b[5~",
	tea.KeyPgDown:     "\x1b[6~",
	tea.KeyCtrlPgUp:   "\x1b[5;5~",
	tea.KeyCtrlPgDown: "\x1b[6;5~",
	tea.KeyDelete:     "\x1b[3~",
	tea.KeyInsert:     "\x1b[2~",
	tea.KeyShiftTab:   "\x1b[Z",

	tea.KeyShiftUp:        "\x1b[1;2A",
	tea.KeyShiftDown:      "\x1b[1;2B",
	tea.KeyShiftRight:     "\x1b[1;2C",
	tea.KeyShiftLeft:      "\x1b[1;2D",
	tea.KeyShiftHome:      "\x1b[1;2H",
	tea.KeyShiftEnd:       "\x1b[1;2F",
	tea.KeyCtrlUp:         "\x1b[1;5A",
	tea.KeyCtrlDown:       "\x1b[1;5B",
	tea.KeyCtrlRight:      "\x1b[1;5C",
	tea.KeyCtrlLeft:       "\x1b[1;5D",
	tea.KeyCtrlHome:       "\x1b[1;5H",
	tea.KeyCtrlEnd:        "\x1b[1;5F",
	tea.KeyCtrlShiftUp:    "\x1b[1;6A",
	tea.KeyCtrlShiftDown:  "\x1b[1;6B",
	tea.KeyCtrlShiftRight: "\x1b[1;6C",
	tea.KeyCtrlShiftLeft:  "\x1b[1;6D",
	tea.KeyCtrlShiftHome:  "\x1b[1;6H",
	tea.KeyCtrlShiftEnd:   "\x1b[1;6F",

	tea.KeyF1:  "\x1bOP",
	tea.KeyF2:  "\x1bOQ",
	tea.KeyF3:  "\x1bOR",
	tea.KeyF4:  "\x1bOS",
	tea.KeyF5:  "\x1b[15~",
	tea.KeyF6:  "\x1b[17~",
	tea.KeyF7:  "\x1b[18~",
	tea.KeyF8:  "\x1b[19~",
	tea.KeyF9:  "\x1b[20~",
	tea.KeyF10: "\x1b[21~",
	tea.KeyF11: "\x1b[23~",
	tea.KeyF12: "\x1b[24~",
}

// keyToBytes maps a Bubble Tea key message to the bytes a terminal would send.
// Alt is the ESC prefix over the unmodified key, so it composes with every key
// below instead of needing its own table. A key with no byte form returns nil,
// and the caller reports it — a key that silently vanishes is worse than one
// the agent ignores.
func keyToBytes(msg tea.KeyMsg) []byte {
	b := baseKeyBytes(msg)
	if len(b) == 0 {
		return nil
	}
	if msg.Alt {
		return append([]byte{0x1b}, b...)
	}
	return b
}

func baseKeyBytes(msg tea.KeyMsg) []byte {
	if seq, ok := escapeKeys[msg.Type]; ok {
		return []byte(seq)
	}
	switch msg.Type {
	case tea.KeyRunes:
		return []byte(string(msg.Runes))
	case tea.KeySpace:
		return []byte{' '}
	}
	// The C0 control keys are their own byte: bubbles types ctrl+@ (0x00, also
	// ctrl+space) through ctrl+_ (0x1f) — which covers enter, tab and esc — plus
	// backspace (0x7f) as the byte value itself.
	if (msg.Type >= 0 && msg.Type <= 0x1f) || msg.Type == 0x7f {
		return []byte{byte(msg.Type)}
	}
	return nil
}

// paletteInnerWidth and respondWidth are shared by applySize and the renderers,
// so a docked input can never be sized for a different box than it is drawn in.
func paletteInnerWidth(termW int) int {
	return max(termW-4, 20)
}

func respondWidth(termW int) int {
	return min(max(termW-4, 20), termW)
}

// applySize is the single place terminal geometry enters the model: widget
// widths, PTY sizes and the huh form's layout. Renderers must stay pure.
func (m *Model) applySize(w, h int) tea.Cmd {
	m.width = w
	m.height = h
	m.palInput.Width = max(paletteInnerWidth(w)-2, 12)
	m.respondInput.Width = max(respondWidth(w)-8, 12)
	m.helpModel.Width = max(w-10, 40)
	m.resizePanel()
	m.resizeScreens()
	return tea.Batch(m.sizeLaunchForm(w, h), m.sizeNodeForm(w, h), m.settleResizeCmd())
}

// sizeLaunchForm hands terminal size to huh, which lays out on WindowSizeMsg.
func (m *Model) sizeNodeForm(w, h int) tea.Cmd {
	if m.nodeForm == nil {
		return nil
	}
	form, cmd := m.nodeForm.Update(tea.WindowSizeMsg{Width: w, Height: h})
	if f, ok := form.(*huh.Form); ok {
		m.nodeForm = f
	}
	return cmd
}

func (m *Model) sizeLaunchForm(w, h int) tea.Cmd {
	if m.launchForm == nil {
		return nil
	}
	form, cmd := m.launchForm.Update(tea.WindowSizeMsg{Width: w, Height: h})
	if f, ok := form.(*huh.Form); ok {
		m.launchForm = f
	}
	return cmd
}

// paneRects maps pane index → the rect it is drawn in. Zen maps its single rect
// onto the focused pane. resizeStreams and attachPaneCmd both read it, so a
// PTY's size on attach can never disagree with the box it lands in.
func (m Model) paneRects() map[int]pen.Rect {
	if m.width < 4 || m.height < 4 {
		return nil
	}
	stageArea := pen.Rect{X: 0, Y: 0, W: max(m.width, 1), H: m.bodyHeight()}

	n := m.nPanes
	if n < 1 {
		n = 1
	}
	layout := m.pen.Layout
	if layout == "" {
		layout = defaultLayoutForN(n)
	}
	// The drilled-into agent and the zen pane are the same geometry: one pane, the
	// whole surface, and it is the focused one.
	solo := m.bodyStage() == StageZen || m.bodyStage() == StageTerm
	if solo {
		n = 1
		layout = domain.PenLayoutCols
	}
	rects := pen.Layout(layout, n, stageArea)
	if rects == nil {
		return nil
	}
	out := make(map[int]pen.Rect, n)
	for i := 0; i < n && i < domain.MaxPenSessions; i++ {
		pi := i
		if solo {
			pi = m.focus
		}
		out[pi] = rects[i]
	}
	return out
}

// paneBoxed reports whether a pane draws its own border. The drilled-into agent
// and the zen pane are boxed because the box is where their name is written; a
// lone pen pane is the whole surface, and a box around the only thing on screen
// separates it from nothing.
func (m Model) paneBoxed() bool {
	switch m.bodyStage() {
	case StageTerm, StageZen:
		return true
	}
	return m.nPanes > 1
}

// paneChrome is the cells a pane spends on its frame: the border and the padding
// either side of the body — the title is in the border — or, unboxed, the title
// row and that padding.
func (m Model) paneChrome() (w, h int) {
	if m.paneBoxed() {
		return 4, 2
	}
	return 2, 2
}

// paneSize is the PTY size for a pane: its rect minus the pane chrome. Falls back
// to 80×24 before the first WindowSizeMsg, when no geometry is known yet.
func (m Model) paneSize(i int) (cols, rows uint16) {
	r, ok := m.paneRects()[i]
	if !ok {
		return 80, 24
	}
	cw, ch := m.paneChrome()
	return uint16(max(r.W-cw, 1)), uint16(max(r.H-ch, 1))
}

// resizeStreams sizes the VT screens and the PTYs behind them, and re-lays the
// panel viewport: the drawer opening under it changes the body height as surely
// as a terminal resize does.
func (m *Model) resizeStreams() {
	m.resizePanel()
	m.resizeScreens()
	m.resizePtys()
}

// resizePanel re-lays the panel viewport onto the current stage geometry.
func (m *Model) resizePanel() {
	m.panel.SetSize(m.panelInnerSize())
}

// resizeScreens sizes the local VT emulators. Cheap, and rendering depends on
// it, so it is never debounced.
func (m *Model) resizeScreens() {
	if m.width < 4 || m.height < 4 {
		return
	}
	if m.shellOpen && m.shellScreen != nil {
		cols, rows := m.shellDrawerSize()
		m.shellScreen.Resize(int(cols), int(rows))
	}
	for i := range m.paneRects() {
		cols, rows := m.paneSize(i)
		if m.panes[i].screen != nil {
			m.panes[i].screen.Resize(int(cols), int(rows))
		}
	}
}

// resizePtys issues the control frames. On the fleet backend each one is a
// network round trip, which is why a resize drag settles before this runs.
func (m *Model) resizePtys() {
	if m.width < 4 || m.height < 4 {
		return
	}
	if m.shellOpen && m.shellStream != nil {
		cols, rows := m.shellDrawerSize()
		_ = m.shellStream.Resize(cols, rows)
	}
	for i := range m.paneRects() {
		if m.panes[i].Stream == nil {
			continue
		}
		cols, rows := m.paneSize(i)
		_ = m.panes[i].Stream.Resize(cols, rows)
	}
}

// settleResizeCmd debounces the PTY resize: the model's geometry is already
// current, so rendering stays responsive while the drag is in flight.
func (m *Model) settleResizeCmd() tea.Cmd {
	m.resizeSeq++
	seq := m.resizeSeq
	return tea.Tick(resizeSettleWindow, func(time.Time) tea.Msg {
		return resizeSettleMsg{seq: seq}
	})
}

// closeStreams detaches every PTY and hangs up the status watch. backend.Async's
// Close hands the drain to its writer goroutine and returns, so this is safe to
// call from Update; closeStreamsAndDrain is the exit path that waits.
func (m *Model) closeStreams() {
	for i := range m.panes {
		if m.panes[i].Stream != nil {
			_ = m.panes[i].Stream.Close()
			m.panes[i].Stream = nil
		}
	}
	if m.shellStream != nil {
		_ = m.shellStream.Close()
		m.shellStream = nil
	}
	m.shellOpen = false
	m.inputTarget = targetPane
	m.cancelWatch()
}

// streamDrainWindow bounds how long the quit path waits for the keys still
// queued behind a PTY to reach the agent. A peer that has stopped reading may
// not hold the terminal hostage on the way out.
const streamDrainWindow = 300 * time.Millisecond

// closeStreamsAndDrain is the exit path: the streams are closed, then given a
// bounded moment to flush, because the process is about to go away with them.
func (m *Model) closeStreamsAndDrain() {
	streams := make([]backend.PtyStream, 0, domain.MaxPenSessions+1)
	for i := range m.panes {
		if m.panes[i].Stream != nil {
			streams = append(streams, m.panes[i].Stream)
		}
	}
	if m.shellStream != nil {
		streams = append(streams, m.shellStream)
	}
	m.closeStreams()
	for _, s := range streams {
		backend.WaitClosed(s, streamDrainWindow)
	}
}

// closeStreamCmd hangs a stream up off the Update goroutine. A raw (un-wrapped)
// stream's Close is a control frame with a socket deadline behind it.
func closeStreamCmd(s backend.PtyStream) tea.Cmd {
	if s == nil {
		return nil
	}
	return func() tea.Msg {
		_ = s.Close()
		return nil
	}
}

// focusedSession returns the session for telemetry/statusline, if known.
func (m Model) focusedSession() (domain.Session, bool) {
	id := m.focusSessionID
	if id == "" && m.focus >= 0 && m.focus < m.nPanes {
		id = m.panes[m.focus].SessionID
	}
	if id == "" {
		return domain.Session{}, false
	}
	for _, s := range m.sessions {
		if s.ID == id {
			return s, true
		}
	}
	// Synthesize from pane.
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == id {
			return domain.Session{
				ID:        id,
				Name:      m.panes[i].Title,
				Status:    m.panes[i].Status,
				Telemetry: m.panes[i].Telemetry,
			}, true
		}
	}
	return domain.Session{}, false
}

// View renders the header, the surface under it, and any overlay over that.
func (m Model) View() string {
	if m.quitting {
		return ""
	}
	if m.fatal {
		return renderFatal(m.err, m.width, m.height)
	}

	// Default the geometry on the local copy, so every helper below (bodyHeight,
	// stageBodyHeight, the hit-test rects) reads the same size View draws at.
	if m.width <= 0 {
		m.width = 80
	}
	if m.height <= 0 {
		m.height = 24
	}
	w, h := m.width, m.height

	if m.showSplash {
		return splash.Render(splash.Content{
			Version: m.version,
			Profile: m.profile,
		}, m.theme, w, h)
	}

	title := renderHeader(m)
	status := renderToastRow(m)
	docked := m.dockReserve() > 0
	var parts []string
	parts = append(parts, title)
	if m.showBanner() {
		parts = append(parts, renderBanner(m))
	}

	drawerH := 0
	if m.shellOpen {
		drawerH = shellDrawerHeight(h)
	}
	// One geometry: the box the stage is drawn into is the one the panel viewport
	// and the mouse hit-tests are sized from. View computing it a second way is
	// how the panel came to render more rows than the terminal has.
	body := renderBody(m, w, m.stageBodyHeight())
	parts = append(parts, body)
	if m.shellOpen {
		parts = append(parts, renderShellDrawer(m, w, drawerH))
	}
	if !docked {
		parts = append(parts, status)
	}
	base := lipgloss.JoinVertical(lipgloss.Left, parts...)

	// Overlays
	switch m.stage {
	case StageHelp:
		return overlayCenter(base, renderHelp(m), w, h)
	case StageActions:
		return overlayCenter(base, renderActions(m), w, h)
	case StageConfirm:
		return overlayCenter(base, renderConfirm(m), w, h)
	case StagePalette:
		// Bottom-docked command palette — settings/groups easy to scan.
		return dockBottom(base, renderPalette(m, w), w, h)
	case StageRespond:
		return dockBottom(base, renderRespond(m), w, h)
	case StageRename:
		return dockBottom(base, renderRename(m), w, h)
	case StageFilter:
		return dockBottom(base, renderFilter(m), w, h)
	}
	return base
}

func renderFatal(err error, w, h int) string {
	msg := "shep-tui: cannot start"
	if err != nil {
		msg = err.Error()
	}
	th := theme.Named(theme.NameAuto)
	style := th.ErrorBox.Width(min(max(w-4, 20), 72))
	body := style.Render(msg + "\n\npress any key to quit · try: shep-tui doctor")
	if w > 0 && h > 0 {
		return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, body)
	}
	return body
}

// flockLogo is the header's right zone. Three rows, so it never costs the header
// a line the key/value block and the hotkeys were not already spending.
var flockLogo = []string{
	"█▀▀ █   █▀█ █▀▀ █ █",
	"█▀▀ █   █ █ █   ██▀",
	"▀   ▀▀▀ ▀▀▀ ▀▀▀ ▀ ▀",
}

// logoWidth is what the logo needs; below it the header spends the cells on the
// hotkeys instead.
const logoWidth = 19

// headerLeftWidth is the key/value block: label column plus value.
const headerLeftWidth = 30

// renderHeader draws the k9s-style header: who you are talking to on the left,
// the keys that work on the selection in the middle, the logo on the right. It
// is not bordered — the table under it is the only box on screen.
func renderHeader(m Model) string {
	th := m.th()
	w := max(m.width, 1)

	left := headerInfo(m)
	keys := headerHotkeyColumns(m, max(w-headerLeftWidth-logoWidth-2, 20))

	logo := []string{}
	if w >= headerLeftWidth+logoWidth+30 {
		for _, l := range flockLogo {
			logo = append(logo, th.Muted.Render(l))
		}
	}

	rows := max(len(left), max(len(keys), len(logo)))
	lines := make([]string, 0, rows)
	for i := 0; i < rows; i++ {
		line := lipgloss.NewStyle().Width(headerLeftWidth).Render(row(left, i))
		mid := row(keys, i)
		if len(logo) > 0 {
			midW := max(w-headerLeftWidth-logoWidth-1, 1)
			line += lipgloss.NewStyle().Width(midW).Render(truncate(mid, midW))
			line += lipgloss.PlaceHorizontal(logoWidth, lipgloss.Right, row(logo, i))
		} else {
			line += mid
		}
		lines = append(lines, truncate(line, w))
	}
	return strings.Join(lines, "\n")
}

func row(rows []string, i int) string {
	if i < len(rows) {
		return rows[i]
	}
	return ""
}

// headerInfo is the aligned Label: value block: the backend the app is talking
// to, and how many agents are on the other end of it.
func headerInfo(m Model) []string {
	th := m.th()
	profile := m.profile
	if profile == "" {
		profile = "local"
	}
	mode := m.caps.Mode
	if mode == "" {
		mode = "local"
	}
	backend := "agentd"
	if mode == "fleet" {
		backend = "fleet"
	}
	socket, node := "", "local"
	if m.cfg != nil {
		p := m.cfg.Active()
		if p.URL != "" {
			socket = p.URL
		} else {
			socket = p.AgentdSocket
		}
		if p.AgentdNodeID != "" {
			node = p.AgentdNodeID
		}
	}
	if socket == "" {
		socket = "(default)"
	}

	needs := 0
	for _, s := range m.sessions {
		if s.Status == domain.StatusAwaitingInput {
			needs++
		}
	}
	needsVal := th.Muted.Render("0")
	if needs > 0 {
		needsVal = m.statusGlyph(domain.StatusAwaitingInput) + " " +
			th.StatusStyle(domain.StatusAwaitingInput).Bold(true).Render(strconv.Itoa(needs))
	}

	// The mode the keyboard is in belongs here too: in input mode every key is
	// the agent's, and the way back out is the only chrome key left.
	state := th.Muted.Render("chrome")
	switch {
	case m.mode == ModeInput:
		state = lipgloss.NewStyle().Foreground(th.Idle).Bold(true).Render("input → agent")
	case len(m.pending) > 0:
		state = lipgloss.NewStyle().Foreground(th.Accent).Render(m.pendingChord() + "…")
	}

	kv := []struct{ k, v string }{
		{"Profile", profile},
		{"Backend", backend + " " + m.version},
		{"Socket", socket},
		{"Node", m.headerNodeValue(node)},
		{"Agents", strconv.Itoa(len(m.sessions))},
		{"Needs you", needsVal},
		{"Mode", state},
	}
	out := make([]string, 0, len(kv))
	for _, e := range kv {
		label := th.Muted.Render(fmt.Sprintf("%-11s", e.k+":"))
		out = append(out, truncate(label+e.v, headerLeftWidth))
	}
	return out
}

// hotkey is one advertised key: what to press, and what it does to the row the
// cursor is on.
type hotkey struct {
	Key  string
	Desc string
}

// sessionHotkeyLabels name the selected session's verbs the way the header says
// them. sessionActions decides *whether* a verb is offered — this only decides
// what it is called — so availability can never drift between the menu and the
// header.
var sessionHotkeyLabels = map[string]string{
	"enter": "Attach",
	"R":     "Respond",
	"r":     "Rename",
	"e":     "Export",
	"g":     "Git",
	"c":     "Commit",
	"f":     "Files",
	"m":     "Chat",
	"b":     "Handoff",
	"x":     "Kill",
}

// headerHotkeys is what the user can press *right now*. The session verbs come
// from sessionActions — the same context rules the actions menu is built from —
// and the chrome keys come from the registry, so a rebind moves both.
func (m Model) headerHotkeys() []hotkey {
	if m.mode == ModeInput {
		// Input mode dispatches two chords and nothing else: every other key is the
		// agent's, and advertising one would be advertising a dead bind.
		chords := []struct {
			action keybinds.Action
			desc   string
		}{{keybinds.ActionDetachChord, "Detach"}}
		if m.caps.ShellDrawer {
			chords = append(chords, struct {
				action keybinds.Action
				desc   string
			}{keybinds.ActionShellDrawer, "Shell"})
		}
		var out []hotkey
		for _, e := range chords {
			for _, seq := range m.binds().Sequences(e.action) {
				if len(seq) > 1 {
					out = append(out, hotkey{Key: keybinds.FormatChord(seq), Desc: e.desc})
					break
				}
			}
		}
		return out
	}
	if m.bodyStage() == StageNodes {
		return m.nodeHotkeys()
	}
	// Off the table the selection is already open, so Attach is not on offer and
	// the way back is: a header that advertises a key the surface does not
	// dispatch is the same lie the old footer told.
	drilled := m.bodyStage() != StageTable
	var out []hotkey
	if drilled {
		out = append(out, hotkey{Key: "esc", Desc: "Back"})
	}
	for _, a := range m.sessionActions() {
		if drilled && a.Key == "enter" {
			continue
		}
		label := sessionHotkeyLabels[a.Key]
		if label == "" {
			label = a.Label
		}
		out = append(out, hotkey{Key: a.Key, Desc: label})
	}

	chrome := []struct {
		action keybinds.Action
		desc   string
	}{}
	if _, ok := m.actionSession(); ok {
		chrome = append(chrome, struct {
			action keybinds.Action
			desc   string
		}{keybinds.ActionActions, "Actions"})
	}
	if !m.onTable() && m.panes[m.focus].Stream != nil {
		chrome = append(chrome, struct {
			action keybinds.Action
			desc   string
		}{keybinds.ActionEnterInput, "Input"})
	}
	// The chrome keys obey the same rule as the session verbs: a backend that
	// cannot launch does not advertise <n>, and one with no shell drawer does not
	// advertise the drawer.
	for _, e := range []struct {
		action keybinds.Action
		desc   string
		on     bool
	}{
		{keybinds.ActionLaunch, "Launch", m.caps.Launch},
		{keybinds.ActionPens, "Pens", true},
		{keybinds.ActionNodes, "Nodes", true},
		{keybinds.ActionFilter, "Filter", true},
		{keybinds.ActionShellDrawer, "Shell", m.caps.ShellDrawer},
		{keybinds.ActionPalette, "Command", true},
		{keybinds.ActionHelp, "Help", true},
		{keybinds.ActionQuit, "Quit", true},
	} {
		if !e.on {
			continue
		}
		chrome = append(chrome, struct {
			action keybinds.Action
			desc   string
		}{e.action, e.desc})
	}
	for _, e := range chrome {
		seq := m.binds().Sequence(e.action)
		if len(seq) == 0 {
			continue
		}
		out = append(out, hotkey{Key: keybinds.FormatChord(seq), Desc: e.desc})
	}
	return out
}

// headerHotkeyColumns lays the hotkeys out in two columns, k9s-style: <key> in
// the accent, the description beside it in the muted ink.
func headerHotkeyColumns(m Model, width int) []string {
	th := m.th()
	keys := m.headerHotkeys()
	if len(keys) == 0 {
		return nil
	}
	cols := 2
	if width < 44 {
		cols = 1
	}
	rows := (len(keys) + cols - 1) / cols
	colW := max(width/cols, 12)

	// Column-major, so reading down a column follows the order the keys were
	// listed in: the selection's verbs first, the app's keys after.
	out := make([]string, rows)
	for c := 0; c < cols; c++ {
		for r := 0; r < rows; r++ {
			i := c*rows + r
			if i >= len(keys) {
				continue
			}
			cell := lipgloss.NewStyle().Foreground(th.Accent).Bold(true).Render("<"+keys[i].Key+">") +
				" " + th.Muted.Render(keys[i].Desc)
			out[r] += lipgloss.NewStyle().Width(colW).Render(truncate(cell, colW))
		}
	}
	return out
}

// renderBanner draws the connectivity bar. It animates only while something is
// actually being retried; once the app has given up it says so and names the
// keys that get the user out, instead of spinning forever at a dead socket.
func renderBanner(m Model) string {
	th := m.th()
	msg := " " + m.spinnerFrame() + " reconnecting to backend… "
	bg := th.Awaiting
	if m.backendDead {
		msg = fmt.Sprintf(" backend lost — %s to retry · %s to quit ",
			m.reconnectHint(), keybinds.FormatSequences(m.binds().Sequences(keybinds.ActionQuit)))
		bg = th.Error
	}
	style := lipgloss.NewStyle().
		Foreground(th.InkPrimary).
		Background(bg).
		Bold(m.backendDead).
		Width(max(m.width, 1))
	return style.Render(truncate(msg, max(m.width, 1)))
}

func (m Model) spinnerFrame() string {
	if frame := strings.TrimSpace(m.spin.View()); frame != "" {
		return frame
	}
	return "…"
}

func renderBody(m Model, w, h int) string {
	return renderStage(m, w, h)
}

// th is the theme every renderer draws with. The OrDefault guard belongs here
// and nowhere else: a Model built by a test literal has the zero Theme, and
// sixteen copies of that check is a rule enforced by copy-paste.
func (m Model) th() theme.Theme {
	return m.theme.OrDefault()
}

// panelBox is the app's one rounded box: a bordered column of w×h cells whose
// ring says whether the surface owns the chrome cursor.
func panelBox(th theme.Theme, w, h int, focused bool) lipgloss.Style {
	border := th.BorderInk
	if focused {
		border = th.Accent
	}
	return borderedBox(w, h, border)
}

func borderedBox(w, h int, border lipgloss.TerminalColor) lipgloss.Style {
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(border).
		Width(max(w-2, 1)).
		Height(max(h-2, 1))
}

// renderList lays out a titled list that scrolls instead of truncating: the
// window follows the cursor and the hidden rows are counted, so a selection is
// never drawn off the bottom of a box.
func renderList(th theme.Theme, title string, lines []string, cursor, innerW, innerH int) string {
	rows := max(innerH-1, 1)
	body := listRows(th, lines, cursor, innerW, rows)
	return th.Title.Width(innerW).Render(truncate(title, innerW)) + "\n" + strings.Join(body, "\n")
}

// listRows draws exactly rows lines of a list: the window around the cursor,
// padded out, with the rows it hides counted rather than silently dropped.
func listRows(th theme.Theme, lines []string, cursor, innerW, rows int) []string {
	rows = max(rows, 1)
	start, end := listWindow(len(lines), cursor, rows)

	out := make([]string, 0, rows)
	if start > 0 {
		out = append(out, th.Muted.Render(truncate(fmt.Sprintf("↑ %d more", start), innerW)))
	}
	for i := start; i < end; i++ {
		out = append(out, truncate(lines[i], innerW))
	}
	if end < len(lines) {
		out = append(out, th.Muted.Render(truncate(fmt.Sprintf("↓ %d more", len(lines)-end), innerW)))
	}
	for len(out) < rows {
		out = append(out, "")
	}
	return out[:rows]
}

// listWindow is the [start,end) slice of a list drawn into rows lines. Hit-testing
// a click needs the same window the renderer used, so the two must never compute
// it separately.
func listWindow(n, cursor, rows int) (start, end int) {
	rows = max(rows, 1)
	start, end = visibleWindow(n, cursor, rows)
	// Overflow markers cost a row each; re-window against what is left.
	if hidden := overflowRows(start, end, n); hidden > 0 {
		start, end = visibleWindow(n, cursor, max(rows-hidden, 1))
		if h2 := overflowRows(start, end, n); h2 > hidden {
			start, end = visibleWindow(n, cursor, max(rows-h2, 1))
		}
	}
	return start, end
}

func overflowRows(start, end, n int) int {
	rows := 0
	if start > 0 {
		rows++
	}
	if end < n {
		rows++
	}
	return rows
}

// tableTitle is the table's title, drawn in its top border: Agents(local)[3].
func (m Model) tableTitle() string {
	n := 0
	if m.table != nil {
		n = m.table.Len()
	}
	scope := m.profile
	if scope == "" {
		scope = "local"
	}
	if m.nodeScope != "" {
		scope = m.nodeScopeName()
	}
	if m.table != nil && m.table.Filter() != "" {
		scope = "/" + m.table.Filter()
	}
	return fmt.Sprintf("Agents(%s)[%d]", scope, n)
}

// tableRows is how many agent rows fit in the box: the box, minus its border and
// the column heading.
func (m Model) tableRows(h int) int {
	return max(h-3, 1)
}

// renderTable draws the one surface the app opens on: every agent, one line
// each, in a box whose title says how many there are.
func renderTable(m Model, w, h int) string {
	innerW := max(w-4, 1)
	var body []string
	if m.table == nil || m.table.Len() == 0 {
		body = nil
	} else {
		body = m.tableLines(innerW, m.tableRows(h))
	}
	return renderGrid(m, w, h, m.tableTitle(), uitable.HeaderCols(m.tableColumns(innerW)), body, emptyTableMessage(m))
}

// renderGrid is the one bordered table on screen: a column heading, the rows the
// surface put under it, and the count in the border. Agents and nodes are the
// same box — only the columns differ.
func renderGrid(m Model, w, h int, title, head string, body []string, empty string) string {
	th := m.th()
	innerW := max(w-4, 1)
	if len(body) == 0 {
		body = []string{"", th.Muted.Render(truncate(empty, innerW))}
	}
	content := th.Title.Bold(true).Render(head) + "\n" + strings.Join(body, "\n")
	return titledBox(th, w, h, th.Accent, title, content)
}

// gridLines draws the visible window of a table body: each row as its styled
// cells, and the row under the cursor as one highlighted band.
func gridLines(th theme.Theme, styled [][]string, plain []string, cursor, innerW, rows int) []string {
	start, end := listWindow(len(plain), cursor, rows)
	out := make([]string, 0, rows)
	if start > 0 {
		out = append(out, th.Muted.Render(truncate(fmt.Sprintf("↑ %d more", start), innerW)))
	}
	for i := start; i < end; i++ {
		line := strings.Join(styled[i], "  ")
		if i == cursor {
			line = lipgloss.NewStyle().
				Foreground(th.InkPrimary).
				Background(th.Surface2).
				Bold(true).
				Width(innerW).
				Render(truncate(uitable.Pad(plain[i], innerW, false), innerW))
		}
		out = append(out, truncate(line, innerW))
	}
	if end < len(plain) {
		out = append(out, th.Muted.Render(truncate(fmt.Sprintf("↓ %d more", len(plain)-end), innerW)))
	}
	for len(out) < rows {
		out = append(out, "")
	}
	return out[:rows]
}

// emptyTableMessage says why the table is empty: nothing to show, or nothing
// left after the filter.
func emptyTableMessage(m Model) string {
	if m.table != nil && m.table.Filter() != "" {
		return "no agents match " + m.table.Filter() + " · esc clears the filter"
	}
	return emptyStateMessage(m)
}

// tableLines draws the visible window of agent rows. Color carries meaning: the
// status cell is the status' own, and the row that needs you is drawn in it.
func (m Model) tableColumns(innerW int) []uitable.Column {
	if !m.caps.Cost {
		return uitable.LayoutOmit(innerW, uitable.ColCost)
	}
	return uitable.Layout(innerW)
}

func (m Model) tableLines(innerW, rows int) []string {
	th := m.th()
	cols := m.tableColumns(innerW)
	all := m.table.Rows()

	styled := make([][]string, 0, len(all))
	plain := make([]string, 0, len(all))
	for _, r := range all {
		cells := make([]string, 0, len(cols))
		for _, c := range cols {
			cell := uitable.Pad(r.Cell(c.Col), c.Width, c.Right)
			switch {
			case c.Col == uitable.ColStatus:
				cell = th.StatusStyle(r.Status).Render(cell)
			case c.Col == uitable.ColName && r.NeedsYou:
				cell = th.StatusStyle(r.Status).Bold(true).Render(cell)
			case c.Col != uitable.ColName:
				cell = th.Muted.Render(cell)
			}
			cells = append(cells, cell)
		}
		styled = append(styled, cells)
		plain = append(plain, rowPlain(r, cols))
	}
	return gridLines(th, styled, plain, m.table.Cursor(), innerW, rows)
}

// rowPlain is the selected row's text with no per-cell color: the highlight is
// the selection, and a cell that keeps its own ink inside it is unreadable.
func rowPlain(r uitable.Row, cols []uitable.Column) string {
	cells := make([]string, 0, len(cols))
	for _, c := range cols {
		cells = append(cells, uitable.Pad(r.Cell(c.Col), c.Width, c.Right))
	}
	return strings.Join(cells, "  ")
}

// titledBox is the app's one bordered surface, with its title centered in the
// top border — k9s draws the count where the frame already is, instead of
// spending a row of the body on it.
func titledBox(th theme.Theme, w, h int, border lipgloss.TerminalColor, title, content string) string {
	inner := max(w-2, 1)
	t := truncate(title, max(inner-4, 1))
	tw := lipgloss.Width(t) + 2
	left := max((inner-tw)/2, 1)
	right := max(inner-tw-left, 1)
	edge := lipgloss.NewStyle().Foreground(border)
	top := edge.Render("╭"+strings.Repeat("─", left)) +
		" " + th.Title.Bold(true).Render(t) + " " +
		edge.Render(strings.Repeat("─", right)+"╮")

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder(), false, true, true, true).
		BorderForeground(border).
		Padding(0, 1).
		Width(max(w-2, 1)).
		Height(max(h-2, 1))
	return top + "\n" + box.Render(content)
}

func renderStage(m Model, w, h int) string {
	switch m.bodyStage() {
	case StagePanel:
		return renderPanel(m, w, h)
	case StageLaunch:
		return renderLaunch(m, w, h)
	case StageSettings:
		return renderSettings(m, w, h)
	case StageTerm:
		return renderTerm(m, w, h)
	case StageTable:
		return renderTable(m, w, h)
	case StageNodes:
		return renderNodes(m, w, h)
	case StageAddNode:
		return renderAddNode(m, w, h)
	}
	// Pen or Zen
	return renderPenStage(m, w, h)
}

// renderTerm is the drilled-into agent: its terminal, the whole window, with the
// agent named in the border — Claude(8ca97e).
func renderTerm(m Model, w, h int) string {
	return renderPane(m, m.focus, m.paneFocus(m.focus), w, h)
}

func renderLaunch(m Model, w, h int) string {
	th := m.th()
	box := panelBox(th, w, h, true).Padding(0, 1)
	title := th.Title.Render("Launch agent") + th.Muted.Render("  (Charm form · esc cancel)")
	body := th.Muted.Render("(no wizard)")
	if m.launchForm != nil {
		body = m.launchForm.View()
	}
	return box.Render(title + "\n" + body)
}

func renderHelp(m Model) string {
	th := m.th()
	km := m.km
	if km == nil {
		km = keybinds.Default()
	}
	// bubbles/help from the live keybind registry, scoped to the surface below.
	helpView := m.helpModel.View(paddockKeyMap{km: km, ctx: helpContextFor(m), width: m.helpModel.Width})
	var head strings.Builder
	head.WriteString(th.Title.Render("Help"))
	head.WriteString(th.Muted.Render("  ·  ? to close  ·  keys for this surface"))
	head.WriteString("\n\n")
	if seq := km.Sequence(keybinds.ActionDetachChord); len(seq) > 0 {
		head.WriteString(th.StatusStyle(domain.StatusAwaitingInput).Render("detach always works: ") +
			keybinds.FormatChord(seq) + "\n\n")
	}
	head.WriteString(th.Muted.Render("the table is home · enter drills into an agent · esc comes back") + "\n\n")
	head.WriteString(helpView)
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(th.Accent).
		Padding(1, 2).
		Background(th.Surface1)
	return box.Render(head.String())
}

func renderPanel(m Model, w, h int) string {
	th := m.th()
	// Size the viewport to the box it is going into. applySize keeps the model's
	// panel in step for the scroll keys, but the geometry can also move without a
	// resize (the reconnect banner takes a row), and a viewport taller than its
	// box pushes the statusline off the screen.
	p := m.panel
	p.SetSize(panelViewport(w, h))
	return panelBox(th, w, h, true).Render(p.View(th))
}

// panelViewport is the viewport area inside a w×h panel box: the box minus the
// border, the title row and the scroll indicator row.
func panelViewport(w, h int) (int, int) {
	return max(w-4, 10), max(h-4, 3)
}

// panelInnerSize is the viewport area of the panel as the stage draws it. It
// reads the shared stage geometry, so the banner and the shell drawer are
// accounted for exactly once.
func (m Model) panelInnerSize() (w, h int) {
	return panelViewport(max(m.width, 1), m.stageBodyHeight())
}

func (m Model) openPanel(kind string, lines []string) (tea.Model, tea.Cmd) {
	m.pushStage(StagePanel)
	m.panelKind = kind
	m.region = RegionMain
	w, h := m.panelInnerSize()
	m.panel = panel.New(kind, kind, lines, w, h)
	return m, nil
}

// panelContent is what a loader produces. The browser is the files panel's
// navigation model, built where the directory is read.
type panelContent struct {
	lines   []string
	browser *files.Browser
}

// panelLoader builds a panel's content off the Update goroutine. It must close
// over plain values (a cwd, a backend handle) and never over the Model.
type panelLoader func() panelContent

// panelLoadedMsg delivers a loader's result. seq identifies the load, so content
// for a panel the user has already closed is dropped instead of drawn.
type panelLoadedMsg struct {
	kind    string
	seq     int
	lines   []string
	browser *files.Browser
}

// openPanelAsync shows the panel immediately and fills it in when the loader
// lands. git shells out, audit is a network RPC and files hits the disk: running
// any of them inside Update freezes every pane, and the PTY channels behind them
// overflow and drop agent output while it is frozen.
func (m Model) openPanelAsync(kind string, load panelLoader) (tea.Model, tea.Cmd) {
	m.panelSeq++
	seq := m.panelSeq
	nm, _ := m.openPanel(kind, []string{"loading…"})
	return nm, func() tea.Msg {
		c := load()
		return panelLoadedMsg{kind: kind, seq: seq, lines: c.lines, browser: c.browser}
	}
}

// panelCwd is the directory the focused session's panels act on.
func (m Model) panelCwd() string {
	s, _ := m.focusedSession()
	return m.sessionCwd(s)
}

// setPanelLines refreshes the open panel's content in place (file browser
// navigation), keeping the scroll window valid.
func (m *Model) setPanelLines(lines []string) {
	m.panel.SetLines(lines)
}

// gitPanelLoader shells out to git status + git diff. Both are bounded: an
// unresponsive git may not hang the UI for as long as it feels like.
func gitPanelLoader(cwd string) panelLoader {
	return func() panelContent {
		return panelContent{lines: gitPanelLines(cwd)}
	}
}

func gitPanelLines(cwd string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	svc := gitpanel.LocalGit{}
	var p gitpanel.Panel
	_ = p.Load(ctx, svc, cwd)
	lines := []string{
		fmt.Sprintf("cwd: %s", cwd),
		fmt.Sprintf("branch: %s  dirty: %d  ahead: %d  behind: %d", p.Branch, p.Dirty, p.Ahead, p.Behind),
		"",
		"actions:  git commit from the session's actions (a)",
		"  stage+commit: flock uses LocalGit StageAll+Commit",
		"  PR (if gh installed): " + gitpanel.PRHint(cwd, ""),
	}
	if p.Err != "" {
		lines = append(lines, "error: "+p.Err)
	}
	lines = append(lines, p.DiffLines...)
	if len(p.DiffLines) == 0 && p.Err == "" {
		lines = append(lines, "(no diff)")
	}
	return lines
}

func (m Model) buildChatPanelLines() []string {
	// Capability-hide structured chat when empty; still show projection surface.
	p := chat.Panel{}
	s, ok := m.focusedSession()
	if ok {
		p.Append(chat.Event{Kind: "system", Text: "session " + s.ID + " · " + s.Status.Label(), At: time.Now()})
		if s.Telemetry.PlanJSON != "" {
			p.Append(chat.Event{Kind: "plan", Text: s.Telemetry.PlanJSON, At: time.Now()})
		}
		if s.Telemetry.Tool != "" {
			p.Append(chat.Event{Kind: "tool", Text: s.Telemetry.Tool, At: time.Now()})
		}
	} else {
		p.Append(chat.Event{Kind: "system", Text: "no focused session — chat projects agent events when available", At: time.Now()})
	}
	if !m.caps.Chat && !m.caps.StructuredChat {
		p.Append(chat.Event{Kind: "system", Text: "(structured chat events thin on this backend — terminal remains control surface)", At: time.Now()})
	}
	return p.Lines(40)
}

// filesPanelLoader opens the browser the files panel navigates with. The Browser
// it returns lives on the Model — a throwaway one can list a directory but never
// walk out of it.
func filesPanelLoader(cwd string) panelLoader {
	return func() panelContent {
		b := &files.Browser{}
		if err := b.ListDir(cwd); err != nil {
			return panelContent{lines: []string{"files: " + err.Error()}}
		}
		return panelContent{lines: filesPanelLines(b), browser: b}
	}
}

func filesPanelLines(b *files.Browser) []string {
	lines := []string{"path: " + b.Path, "↑/↓ move · enter/l open · h up · esc close"}
	for i, e := range b.Entries {
		mark := "  "
		if i == b.Cursor {
			mark = "▶ "
		}
		suffix := ""
		if e.IsDir {
			suffix = "/"
		}
		lines = append(lines, mark+e.Name+suffix)
	}
	return lines
}

func (m Model) buildCostPanelLines() []string {
	var t cost.Table
	t.FromSessions(m.sessions)
	lines := t.Lines()
	if len(lines) == 0 {
		return []string{"(no cost/token data yet)", fmt.Sprintf("total: $%.4f", t.Total())}
	}
	return append(lines, fmt.Sprintf("total: $%.4f", t.Total()))
}

func (m Model) buildComparePanelLines() []string {
	b := compare.Board{ShowCost: m.caps.Cost}
	for _, s := range m.sessions {
		run := compare.Run{
			SessionID: s.ID,
			Agent:     string(s.AgentType),
			Model:     s.Telemetry.Model,
			Status:    s.Status,
			Summary:   s.Name,
		}
		if m.caps.Cost && s.Telemetry.CostUSD != nil {
			run.CostUSD = *s.Telemetry.CostUSD
		}
		b.Add(run)
	}
	if len(b.Runs) == 0 {
		return []string{"Run-N compare: no sessions — launch agents then re-open"}
	}
	if m.caps.Cost {
		b.SortByCost()
	}
	return b.Lines()
}

// auditPanelLoader fetches the audit log from the backend handle it is given —
// the Model is never captured, because it is copied on every Update.
func auditPanelLoader(be backend.Backend) panelLoader {
	return func() panelContent {
		return panelContent{lines: auditPanelLines(be)}
	}
}

func auditPanelLines(be backend.Backend) []string {
	if be == nil {
		return []string{"audit: no backend"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	entries, err := be.ListAudit(ctx)
	if err != nil {
		if errors.Is(err, backend.ErrNotSupported) {
			return []string{"audit: not available on this backend (capability-hidden)", "fleet Caps.Audit when orchestrator exposes /api/audit"}
		}
		return []string{"audit error: " + err.Error()}
	}
	if len(entries) == 0 {
		return []string{"(no audit entries)"}
	}
	var lines []string
	for _, e := range entries {
		lines = append(lines, fmt.Sprintf("%s  %s  %s  %s", e.Time, e.Action, e.Actor, e.Detail))
	}
	return lines
}

// handoffBootstrap is the text a follow-on agent is started with: who it is
// taking over from, what the mission is, and what the outgoing agent last said.
// The transcript is the pane's own scrollback — the same lines export writes.
func (m Model) handoffBootstrap() (text, cwd string, ok bool) {
	s, ok := m.actionSession()
	if !ok {
		return "", "", false
	}
	from := string(s.AgentType)
	if from == "" {
		from = m.sessionName(s)
	}
	summary := fmt.Sprintf("Continue work from session %s (%s)", s.ID, s.Status.Label())
	lines := m.transcriptLines(s)
	if len(lines) > handoffTranscriptLines {
		lines = lines[len(lines)-handoffTranscriptLines:]
	}
	return handoff.BuildBootstrap(from, summary, lines, handoffMaxRunes), m.sessionCwd(s), true
}

// handoffTranscriptLines is how much of the outgoing agent's screen the bootstrap
// carries; handoffMaxRunes is the budget BuildBootstrap truncates it into.
const (
	handoffTranscriptLines = 80
	handoffMaxRunes        = 4000
)

func (m Model) buildHandoffPanelLines() []string {
	if m.handoffSeed == "" {
		return []string{"handoff: no session selected"}
	}
	var lines []string
	if m.caps.Launch {
		lines = append(lines, "enter · launch a new agent seeded with this bootstrap")
	}
	lines = append(lines, "esc   · close", "")
	return append(lines, strings.Split(m.handoffSeed, "\n")...)
}

// openHandoff builds the bootstrap for the selected session and shows it. The
// text is kept on the Model so enter can hand it to the launch path — a panel
// that could only be read would not be a handoff.
func (m Model) openHandoff() (tea.Model, tea.Cmd) {
	text, cwd, ok := m.handoffBootstrap()
	if !ok {
		m.notifyErr("handoff: no session selected")
		return m, nil
	}
	m.handoffSeed = text
	m.handoffCwd = cwd
	return m.openPanel("handoff", m.buildHandoffPanelLines())
}

// writeSeed types the handoff bootstrap into a session the moment its PTY is
// live. This is where the handoff stops being a text panel: the new agent reads
// the seed on its own input, exactly as if the user had pasted it.
func (m *Model) writeSeed(pane int, stream backend.PtyStream) {
	sid := m.panes[pane].SessionID
	seed := m.seedBySession[sid]
	if seed == "" || stream == nil {
		return
	}
	delete(m.seedBySession, sid)
	if _, err := stream.Write([]byte(seed)); err != nil {
		m.notifyErrf("handoff seed: %v", err)
		return
	}
	m.notifyOK("handoff seeded into " + domain.ShortID(sid))
}

// launchFromHandoff opens the launch form with the bootstrap held aside: the
// agent the user picks is typed the seed as soon as its PTY is attached.
func (m Model) launchFromHandoff() (tea.Model, tea.Cmd) {
	if m.handoffSeed == "" {
		return m, nil
	}
	m.launchSeed = m.handoffSeed
	m.popStage()
	return m.openLaunchIn(m.handoffCwd)
}

func renderPenStage(m Model, w, h int) string {
	th := m.th()

	// Empty flock state (no sessions at all).
	if len(m.sessions) == 0 && !anyPaneAttached(m) {
		msg := emptyStateMessage(m)
		box := panelBox(th, w, h, false).Align(lipgloss.Center, lipgloss.Center)
		return box.Render(th.Muted.Render(msg))
	}

	n := m.nPanes
	if n < 1 {
		n = 1
	}
	layout := m.pen.Layout
	if layout == "" {
		layout = defaultLayoutForN(n)
	}
	area := pen.Rect{X: 0, Y: 0, W: w, H: h}

	if m.bodyStage() == StageZen {
		return renderPane(m, m.focus, m.paneFocus(m.focus), w, h)
	}

	rects := pen.Layout(layout, n, area)
	if rects == nil {
		return renderPane(m, 0, m.paneFocus(0), w, h)
	}

	// Render each pane at its rect size; compose with lipgloss by rows.
	// For cols layout, join horizontal; for grid, build 2 rows.
	views := make([]string, n)
	for i := 0; i < n; i++ {
		views[i] = renderPane(m, i, m.paneFocus(i), rects[i].W, rects[i].H)
	}
	return composeRects(layout, n, rects, views)
}

// paneFocus is a pane's ring state. The dim ring is the honest one: from the
// tree or the rail, i / enter / tab / z / respond still act on m.focus, so that
// pane may not claim *no* focus.
type paneFocus int

const (
	paneUnfocused paneFocus = iota
	paneFocusDim
	paneFocusActive
)

func (m Model) paneFocus(i int) paneFocus {
	if m.focus != i {
		return paneUnfocused
	}
	if m.region == RegionMain {
		return paneFocusActive
	}
	return paneFocusDim
}

func anyPaneAttached(m Model) bool {
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID != "" {
			return true
		}
	}
	return false
}

// emptyPaneMsg is what an empty pane says. The launch key is named only where
// there is one to press.
func (m Model) emptyPaneMsg() string {
	if !m.caps.Launch {
		return "no session — empty pen"
	}
	return "no session — empty pen · " +
		keybinds.FormatChord(m.binds().Sequence(keybinds.ActionLaunch)) + " to launch"
}

// emptyStateMessage says what to do about an empty flock — and only what this
// backend can actually do. Fleet cannot create a session, so it is not told to
// press a key that would only apologise.
func emptyStateMessage(m Model) string {
	if !m.caps.Launch {
		return "no sessions — this backend cannot launch agents · start them on a node, or run shep-tui with a local profile"
	}
	launch := keybinds.FormatChord(m.binds().Sequence(keybinds.ActionLaunch))
	return "no sessions — press " + launch + " to launch agent · or: shep-tui sessions launch --agent claude"
}

// composeRects joins pane views according to layout geometry.
func composeRects(layout domain.PenLayout, n int, rects []pen.Rect, views []string) string {
	if len(views) == 0 {
		return ""
	}
	switch layout {
	case domain.PenLayoutRows:
		return lipgloss.JoinVertical(lipgloss.Left, views...)
	case domain.PenLayoutGrid2x2:
		switch n {
		case 1:
			return views[0]
		case 2:
			return joinHorizontalGap(rects, views)
		case 3:
			top := lipgloss.JoinHorizontal(lipgloss.Top, views[0], views[1])
			return lipgloss.JoinVertical(lipgloss.Left, top, views[2])
		case 4:
			top := lipgloss.JoinHorizontal(lipgloss.Top, views[0], views[1])
			bot := lipgloss.JoinHorizontal(lipgloss.Top, views[2], views[3])
			return lipgloss.JoinVertical(lipgloss.Left, top, bot)
		}
	case domain.PenLayoutMainStack:
		if n == 1 {
			return views[0]
		}
		// Approximate: main + stack joined based on whether stack is to the right.
		if len(rects) >= 2 && rects[1].X > rects[0].X {
			stack := views[1:]
			right := lipgloss.JoinVertical(lipgloss.Left, stack...)
			return lipgloss.JoinHorizontal(lipgloss.Top, views[0], right)
		}
		stack := views[1:]
		bot := lipgloss.JoinHorizontal(lipgloss.Top, stack...)
		return lipgloss.JoinVertical(lipgloss.Left, views[0], bot)
	default: // cols
		return joinHorizontalGap(rects, views)
	}
	return strings.Join(views, "")
}

func joinHorizontalGap(rects []pen.Rect, views []string) string {
	if len(views) == 0 {
		return ""
	}
	if len(views) == 1 {
		return views[0]
	}
	out := views[0]
	for i := 1; i < len(views); i++ {
		gap := 0
		if i < len(rects) && i-1 < len(rects) {
			prevRight := rects[i-1].X + rects[i-1].W
			if rects[i].X > prevRight {
				gap = rects[i].X - prevRight
			}
		}
		if gap > 0 {
			out = lipgloss.JoinHorizontal(lipgloss.Top, out, strings.Repeat(" ", gap), views[i])
		} else {
			out = lipgloss.JoinHorizontal(lipgloss.Top, out, views[i])
		}
	}
	return out
}

// renderPalette draws a clean bottom-docked command palette with group headers,
// fuzzy results, keybind chips, and a compact nav footer.
func renderPalette(m Model, termW int) string {
	th := m.th()
	w := max(termW, 40)
	if w > m.width && m.width > 0 {
		w = m.width
	}
	innerW := paletteInnerWidth(w)

	var b strings.Builder
	// Header
	head := th.Title.Render("Command palette")
	hint := th.Muted.Render("  bubbles filter · tab next group · launch · pens · settings")
	b.WriteString(truncate(head+hint, innerW) + "\n")

	// Bubbles textinput search line
	b.WriteString(m.palInput.View() + "\n")

	start, end := visibleWindow(len(m.paletteItems), m.paletteCursor, m.paletteMaxRows())

	if len(m.paletteItems) == 0 {
		b.WriteString(th.Muted.Render("  (no matches — try settings, launch, pen)") + "\n")
	}
	for _, r := range m.paletteRows() {
		if r.item < 0 {
			b.WriteString(th.Muted.Bold(true).Render("  "+strings.ToUpper(r.group)) + "\n")
			continue
		}
		i := r.item
		item := m.paletteItems[i]
		marker := "  "
		if i == m.paletteCursor {
			marker = "▶ "
		}
		label := item.Label
		if item.Kind == "session" {
			label = m.statusGlyph(item.Status) + " " + item.Label
		}
		// Right-align hint chip when room allows.
		row := marker + label
		if item.Hint != "" {
			chip := th.Muted.Render(item.Hint)
			// approximate: put hint after label with spacing
			pad := innerW - lipgloss.Width(row) - lipgloss.Width(item.Hint) - 1
			if pad < 1 {
				pad = 1
			}
			row = row + strings.Repeat(" ", pad) + chip
		}
		row = truncate(row, innerW)
		if i == m.paletteCursor {
			b.WriteString(lipgloss.NewStyle().
				Foreground(th.InkPrimary).
				Background(th.Surface2).
				Width(innerW).
				Render(row) + "\n")
		} else {
			b.WriteString(row + "\n")
		}
	}
	if start > 0 || end < len(m.paletteItems) {
		b.WriteString(th.Muted.Render(fmt.Sprintf("  … %d/%d", m.paletteCursor+1, len(m.paletteItems))) + "\n")
	}

	// Footer nav strip
	footer := "↑↓ move  tab group  enter run  esc close"
	if m.paletteQuery != "" {
		footer = "filter: " + m.paletteQuery + "  ·  " + footer
	}
	b.WriteString(th.Muted.Render(truncate(footer, innerW)))

	style := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(th.Accent).
		BorderTop(true).BorderBottom(true).BorderLeft(true).BorderRight(true).
		Padding(0, 1).
		Width(max(w-2, 20)).
		Background(th.Surface1)
	return style.Render(b.String())
}

// visibleWindow returns [start,end) indices so cursor stays visible in maxRows.
func visibleWindow(n, cursor, maxRows int) (start, end int) {
	if n <= 0 {
		return 0, 0
	}
	if maxRows < 1 {
		maxRows = 1
	}
	if n <= maxRows {
		return 0, n
	}
	if cursor < 0 {
		cursor = 0
	}
	if cursor >= n {
		cursor = n - 1
	}
	start = cursor - maxRows/2
	if start < 0 {
		start = 0
	}
	end = start + maxRows
	if end > n {
		end = n
		start = end - maxRows
		if start < 0 {
			start = 0
		}
	}
	return start, end
}

// renderFilter is the live table filter, docked under the table it narrows.
func renderFilter(m Model) string {
	th := m.th()
	w := respondWidth(m.width)
	n := 0
	if m.table != nil {
		n = m.table.Len()
	}
	body := th.Title.Render(fmt.Sprintf("Filter · %d agents", n)) + "\n" +
		m.filterInput.View() + "\n" +
		th.Muted.Render("enter keep · esc clear")
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(th.Accent).
		Padding(0, 1).
		Width(max(w-2, 10)).
		Background(th.Surface1).
		Render(body)
}

func renderRespond(m Model) string {
	th := m.th()
	w := respondWidth(m.width)
	head := "Respond"
	if m.respondTarget != "" {
		head += " → " + domain.ShortID(m.respondTarget)
	}
	body := th.Title.Render(head) + "\n" +
		m.respondInput.View() + "\n" +
		th.Muted.Render("bubbles input · enter send · esc cancel")
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(th.Awaiting).
		Padding(0, 1).
		Width(max(w-2, 10)).
		Background(th.Surface1).
		Render(body)
}

// renderToastRow is the last row: the ephemeral message, bottom-right, and
// nothing else. The keys live in the header, permanently — a strip of them down
// here would be a second place to look for the same thing.
func renderToastRow(m Model) string {
	th := m.th()
	w := max(m.width, 1)
	msg := m.toastView()
	if msg == "" {
		return th.Help.Width(w).Render("")
	}
	msg = truncate(msg, max(w-2, 1))
	pad := max(w-lipgloss.Width(msg)-1, 0)
	return th.Help.Width(w).Render(strings.Repeat(" ", pad) + msg)
}

func renderPane(m Model, idx int, focus paneFocus, w, h int) string {
	th := m.th()
	p := m.panes[idx]
	mode := m.mode
	focused := focus != paneUnfocused
	borderColor := th.BorderInk
	switch {
	case focus == paneFocusActive && mode == ModeInput:
		borderColor = th.Idle // input focus: calm green
	case focus == paneFocusActive:
		borderColor = th.Accent
	case focus == paneFocusDim:
		// Chrome focus lives elsewhere, but this pane still owns i / enter / z.
		borderColor = th.InkMuted
	}

	var title string
	if p.SessionID != "" {
		// Status glyph + affirmative label; Needs you blinks, Starting spins.
		statusBit := m.statusLabelBlink(p.Status)
		title = m.paneBoxTitle(idx) + " · " + statusBit
	} else {
		title = fmt.Sprintf("pane %d · empty", idx+1)
	}
	if p.scrollOff > 0 {
		title += fmt.Sprintf(" · SCROLL -%d", p.scrollOff)
	}
	if m.mode == ModeInput && focus == paneFocusActive && m.inputTarget == targetPane {
		title += " · INPUT"
	}

	cw, ch := m.paneChrome()
	innerW := max(w-cw, 1)
	innerH := max(h-ch, 1)

	var body string
	if p.SessionID == "" {
		msg := p.EmptyMsg
		if msg == "" {
			msg = "no session"
		}
		body = th.Muted.Width(innerW).Render(msg)
	} else if p.AttachErr != "" {
		// A pane that has a session but no stream shows why, ahead of the VT case:
		// its screen has never received a byte and would draw as empty.
		body = lipgloss.NewStyle().Width(innerW).Foreground(th.Error).Bold(true).Render("⚠ attach failed") + "\n" +
			th.Muted.Width(innerW).Render(truncate(p.AttachErr, innerW)) + "\n" +
			th.Muted.Width(innerW).Render("press "+m.retryHint()+" to retry")
	} else {
		body = renderVT(p.screen, innerW, innerH, p.scrollOff)
	}

	if !m.paneBoxed() {
		titleStyle := th.Title.Bold(focus == paneFocusActive).Width(innerW)
		marker := "  "
		if focused {
			marker = "▶ "
		}
		content := titleStyle.Render(truncate(marker+title, innerW)) + "\n" + body
		return lipgloss.NewStyle().Width(max(w, 1)).Height(max(h, 1)).Padding(0, 1).Render(content)
	}
	return titledBox(th, w, h, borderColor, title, body)
}

// paneBoxTitle names the agent in the pane's border, k9s style: Claude(8ca97e).
func (m Model) paneBoxTitle(idx int) string {
	s := m.sessionOrPlaceholder(m.panes[idx].SessionID)
	name := m.sessionName(s)
	if id := domain.ShortID(s.ID); id != "" {
		return fmt.Sprintf("%s(%s)", name, id)
	}
	return name
}

// renderVT draws a window onto the pane's virtual buffer — scrollback followed
// by the live rows — offset lines back from the bottom. off == 0 is live.
func renderVT(s *vt.Screen, width, height, off int) string {
	if s == nil {
		return ""
	}
	rows := s.Rows()
	hist := s.ScrollbackLen()
	if s.AltScreen() {
		// Alt-screen programs feed no history; there is nothing above the live rows.
		hist, off = 0, 0
	}
	if off < 0 {
		off = 0
	}
	if off > hist {
		off = hist
	}
	total := hist + rows
	top := total - off - height
	lines := make([]string, 0, height)
	for y := 0; y < height; y++ {
		i := top + y
		var cells []vt.Cell
		switch {
		case i < 0 || i >= total:
			lines = append(lines, "")
			continue
		case i < hist:
			cells = s.ScrollbackCells(i)
		default:
			cells = s.RowCells(i - hist)
		}
		// Render from cells, not RowString: the string accessors drop the SGR
		// state, which is every color htop and Claude Code emit.
		lines = append(lines, renderCells(cells, width))
	}
	return strings.Join(lines, "\n")
}

func overlayCenter(base, overlay string, w, h int) string {
	if w <= 0 {
		w = 80
	}
	if h <= 0 {
		h = 24
	}
	_ = base
	return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, overlay,
		lipgloss.WithWhitespaceChars(" "),
	)
}

// dockBottom stacks overlay under a height-clipped base so the paddock stays
// visible above a bottom command bar (palette / respond).
func dockBottom(base, overlay string, w, h int) string {
	if w <= 0 {
		w = 80
	}
	if h <= 0 {
		h = 24
	}
	oh := lipgloss.Height(overlay)
	if oh <= 0 {
		return base
	}
	if oh >= h {
		return overlay
	}
	keep := h - oh
	// Clip base to leave room for the docked bar.
	lines := strings.Split(base, "\n")
	// lipgloss may use wider cells; approximate by line count.
	if len(lines) > keep {
		lines = lines[:keep]
	}
	top := strings.Join(lines, "\n")
	for lipgloss.Height(top) < keep {
		top += "\n"
	}
	// Ensure overlay spans terminal width cleanly.
	ov := lipgloss.NewStyle().Width(w).MaxWidth(w).Render(overlay)
	return lipgloss.JoinVertical(lipgloss.Left, top, ov)
}

// feed ingests PTY bytes into the pane's VT screen.
func (p *Pane) feed(data []byte) {
	if p.screen != nil {
		_, _ = p.screen.Write(data)
	}
}

// truncate must be ANSI-aware: styled strings (bubbles/help, status glyphs) carry
// escape sequences, and cutting one in half leaks the remainder as literal text —
// which then renders wider than the width it was cut to.
func truncate(s string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= width {
		return s
	}
	return ansi.Truncate(s, width, "…")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// inGrid reports whether the stage is showing more than one pane, which is the
// only place moving *between* panes means anything.
func (m Model) inGrid() bool {
	return m.bodyStage() == StagePen && m.nPanes > 1
}

// focusPaneDir moves the pane focus geometrically: to the pane whose centre lies
// nearest in the direction asked for. Reading it off the rects the layout
// actually produced means arrow keys work in every pen layout — cols, rows, 2x2,
// main+stack — without any of them having to describe their own adjacency.
func (m Model) focusPaneDir(dx, dy int) (tea.Model, tea.Cmd) {
	rects := m.paneRects()
	cur, ok := rects[m.focus]
	if !ok || len(rects) < 2 {
		return m, nil
	}
	cx, cy := cur.X+cur.W/2, cur.Y+cur.H/2

	best, bestScore := -1, 0
	for i, r := range rects {
		if i == m.focus || i >= m.nPanes {
			continue
		}
		ox, oy := r.X+r.W/2, r.Y+r.H/2
		// Only panes genuinely on the side asked for; a pane merely overlapping the
		// axis would let one press jump the cursor across the grid.
		along, across := ox-cx, oy-cy
		if dy != 0 {
			along, across = oy-cy, ox-cx
		}
		if dir := dx + dy; (dir > 0 && along <= 0) || (dir < 0 && along >= 0) {
			continue
		}
		if along < 0 {
			along = -along
		}
		if across < 0 {
			across = -across
		}
		// Prefer the closest in the direction of travel, then the best aligned.
		score := along + across*2
		if best < 0 || score < bestScore {
			best, bestScore = i, score
		}
	}
	if best < 0 {
		return m, nil
	}
	return m.focusPane(best)
}
