// Charm / Bubbles / Huh integration: text inputs, spinner, attention blink, help, launch form.
package app

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
	"github.com/billiondollarsolo/shep-tui/internal/launch"
	"github.com/billiondollarsolo/shep-tui/internal/ui/motion"
	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

// blinkTickMsg flips Needs-you glyph phase. seq is the blink generation it was
// scheduled under: a tick still in flight from a loop that has since stopped
// must not restart one, or attention flipping on and off inside a tick window
// leaves two loops repainting the screen forever.
type blinkTickMsg struct{ seq int }

// launchFormVals holds huh-bound launch fields (pointers required by huh).
type launchFormVals struct {
	agent string
	cwd   string
	ok    bool
}

// initCharmWidgets constructs the Bubbles textinputs, spinner and help model.
// Everything theme-dependent belongs in restyleCharmWidgets so a theme change can
// re-apply it: a color baked in here is a color light mode cannot repaint.
func (m *Model) initCharmWidgets() {
	m.blinkOn = true

	m.spin = spinner.New()
	m.spin.Spinner = spinner.Dot

	m.palInput = textinput.New()
	m.palInput.Placeholder = "filter: settings · launch · pen…"
	m.palInput.CharLimit = 120
	m.palInput.Prompt = "> "
	m.palInput.Width = 48

	m.respondInput = textinput.New()
	m.respondInput.Placeholder = "type reply · enter send · esc cancel"
	m.respondInput.CharLimit = 4000
	m.respondInput.Prompt = "› "
	m.respondInput.Width = 60

	m.filterInput = textinput.New()
	m.filterInput.Placeholder = "filter agents by name · agent · project"
	m.filterInput.CharLimit = 60
	m.filterInput.Prompt = "/ "
	m.filterInput.Width = 40

	m.renameInput = textinput.New()
	m.renameInput.Placeholder = "new name"
	m.renameInput.CharLimit = 60
	m.renameInput.Prompt = "› "
	m.renameInput.Width = 40

	m.helpModel = help.New()
	m.helpModel.ShowAll = true

	m.restyleCharmWidgets()
}

// restyleCharmWidgets paints the widgets that copy theme colors into their own
// styles. Idempotent — applyTheme runs it on every theme change.
func (m *Model) restyleCharmWidgets() {
	th := m.th()

	m.spin.Style = lipgloss.NewStyle().Foreground(th.Accent)

	m.palInput.PromptStyle = lipgloss.NewStyle().Foreground(th.Accent).Bold(true)
	m.palInput.TextStyle = lipgloss.NewStyle().Foreground(th.InkPrimary)
	m.palInput.Cursor.Style = lipgloss.NewStyle().Foreground(th.Accent)

	m.respondInput.PromptStyle = lipgloss.NewStyle().Foreground(th.Awaiting).Bold(true)
	m.renameInput.PromptStyle = lipgloss.NewStyle().Foreground(th.Accent).Bold(true)
	m.filterInput.PromptStyle = lipgloss.NewStyle().Foreground(th.Accent).Bold(true)

	m.helpModel.Styles.FullKey = lipgloss.NewStyle().Foreground(th.Accent).Bold(true)
	m.helpModel.Styles.FullDesc = lipgloss.NewStyle().Foreground(th.InkMuted)
	m.helpModel.Styles.FullSeparator = lipgloss.NewStyle().Foreground(th.InkMuted)
	m.helpModel.Styles.ShortKey = m.helpModel.Styles.FullKey
	m.helpModel.Styles.ShortDesc = m.helpModel.Styles.FullDesc
	m.helpModel.Styles.ShortSeparator = m.helpModel.Styles.FullSeparator
}

// applyTheme switches themes at runtime: the name is the identity (comparing a
// color value breaks the moment a third theme exists), and every widget that
// cached the old colors is repainted, including a launch form already on screen.
func (m *Model) applyTheme(name string) {
	m.themeName = name
	m.theme = theme.Named(name)
	m.restyleCharmWidgets()
	if m.launchForm != nil {
		m.launchForm = m.launchForm.WithTheme(theme.HuhTheme(m.theme))
	}
}

// charmTickCmds returns background ticks for blink + spinner. It arms the blink
// loop under the current generation, so Init cannot start a second one.
func (m Model) charmTickCmds() tea.Cmd {
	var cmds []tea.Cmd
	if m.blinkActive() {
		cmds = append(cmds, blinkTick(m.blinkSeq))
	}
	// Spinner always ticks when reconnecting or any Starting pane/session.
	if m.needsSpinner() {
		cmds = append(cmds, m.spin.Tick)
	}
	return tea.Batch(cmds...)
}

func blinkTick(seq int) tea.Cmd {
	return tea.Tick(motion.BlinkPeriod, func(time.Time) tea.Msg {
		return blinkTickMsg{seq: seq}
	})
}

// blinkActive gates the blink loop on there being something to blink: an
// always-on tick repaints (and rebuilds the whole tree) once a second at idle.
func (m Model) blinkActive() bool {
	return !m.reducedMotion && m.hasNeedsYou()
}

// motionState is the set of running animation loops. Handlers that can change
// it snapshot it before mutating and hand the snapshot to armMotion.
type motionState struct {
	blink   bool
	spinner bool
}

func (m Model) motionState() motionState {
	return motionState{blink: m.blinkActive(), spinner: m.needsSpinner()}
}

// armMotion starts the tick loops a state change just made necessary, batched
// with cmd. Loops already running are not re-armed, so ticks cannot stack.
func (m Model) armMotion(before motionState, cmd tea.Cmd) (tea.Model, tea.Cmd) {
	after := m.motionState()
	cmds := []tea.Cmd{cmd}
	if after.blink && !before.blink {
		m.blinkSeq++
		cmds = append(cmds, blinkTick(m.blinkSeq))
	}
	if !after.blink {
		// Nothing needs you: leave the glyph lit rather than frozen hollow. The
		// generation moves on so a tick still in flight cannot revive the loop
		// when attention returns before it lands.
		m.blinkSeq++
		m.blinkOn = true
	}
	if after.spinner && !before.spinner {
		cmds = append(cmds, m.spin.Tick)
	}
	return m, tea.Batch(cmds...)
}

func (m Model) needsSpinner() bool {
	if m.reconnecting {
		return true
	}
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].Status == domain.StatusStarting {
			return true
		}
	}
	for _, s := range m.sessions {
		if s.Status == domain.StatusStarting {
			return true
		}
	}
	return false
}

func (m Model) hasNeedsYou() bool {
	for _, s := range m.sessions {
		if s.Status == domain.StatusAwaitingInput {
			return true
		}
	}
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].Status == domain.StatusAwaitingInput {
			return true
		}
	}
	return false
}

// statusGlyph renders ●/○ with Needs-you blink and Starting spinner frames.
func (m Model) statusGlyph(st domain.Status) string {
	th := m.th()
	switch st {
	case domain.StatusAwaitingInput:
		if m.reducedMotion {
			return th.StatusStyle(st).Bold(true).Render("●")
		}
		if m.blinkOn {
			return th.StatusStyle(st).Bold(true).Render("●")
		}
		// Off phase: hollow ring so the pulse is visible without color-only.
		return th.StatusStyle(st).Render("○")
	case domain.StatusStarting:
		if m.reducedMotion {
			return th.StatusStyle(st).Render("●")
		}
		// Spinner frame (may include trailing space from Dot spinner).
		frame := strings.TrimSpace(m.spin.View())
		if frame == "" {
			frame = "●"
		}
		return th.StatusStyle(st).Render(frame)
	case domain.StatusError:
		// Error rings in web; keep solid bold glyph.
		return th.StatusStyle(st).Bold(true).Render("●")
	default:
		return th.StatusGlyph(st)
	}
}

// statusLabelBlink is "● Needs you" with blink-aware glyph.
func (m Model) statusLabelBlink(st domain.Status) string {
	th := m.th()
	return m.statusGlyph(st) + " " + th.StatusStyle(st).Render(st.Label())
}

func newLaunchForm(cwd string, th theme.Theme) (*huh.Form, *launchFormVals) {
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	v := &launchFormVals{agent: string(launch.AgentClaude), cwd: cwd, ok: true}
	opts := make([]huh.Option[string], 0, len(launch.KnownAgents))
	for _, a := range launch.KnownAgents {
		label := string(a)
		switch a {
		case launch.AgentClaude:
			label = "claude — Claude Code"
		case launch.AgentCodex:
			label = "codex — OpenAI Codex"
		case launch.AgentOpenCode:
			label = "opencode"
		case launch.AgentGemini:
			label = "gemini"
		case launch.AgentGrok:
			label = "grok"
		case launch.AgentShell:
			label = "shell — interactive $SHELL"
		}
		opts = append(opts, huh.NewOption(label, string(a)))
	}
	form := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Agent").
				Description("Standalone launch into the active pen").
				Options(opts...).
				Value(&v.agent),
			huh.NewInput().
				Title("Working directory").
				Description("Project cwd for the agent PTY").
				Value(&v.cwd).
				Validate(func(s string) error {
					if strings.TrimSpace(s) == "" {
						return fmt.Errorf("cwd required")
					}
					return nil
				}),
			huh.NewConfirm().
				Title("Launch agent?").
				Affirmative("Launch").
				Negative("Cancel").
				Value(&v.ok),
		),
	).
		WithTheme(theme.HuhTheme(th)).
		WithWidth(56).
		WithShowHelp(true).
		WithShowErrors(true)
	return form, v
}

// helpContext is the surface ? was pressed on. Help must describe the keys that
// work *here*, not a constant list the current surface never dispatches.
type helpContext int

const (
	helpPaddock helpContext = iota
	helpInput
	helpPalette
	helpPanel
	helpFilesPanel
	helpLaunch
	helpRespond
	helpSettings
	helpActions
	helpRename
	helpConfirm
	helpFilter
)

// helpContextFor mirrors handleKey's dispatch. When the help overlay itself is
// on top, the context is the surface it was raised over.
func helpContextFor(m Model) helpContext {
	if m.mode == ModeInput {
		return helpInput
	}
	stage := m.stage
	if stage == StageHelp {
		stage = m.underStage()
	}
	switch stage {
	case StagePalette:
		return helpPalette
	case StagePanel:
		if m.panelKind == "files" && m.filesBrowser != nil {
			return helpFilesPanel
		}
		return helpPanel
	case StageLaunch, StageAddNode:
		return helpLaunch
	case StageRespond:
		return helpRespond
	case StageSettings:
		return helpSettings
	case StageActions:
		return helpActions
	case StageRename:
		return helpRename
	case StageConfirm:
		return helpConfirm
	case StageFilter:
		return helpFilter
	}
	return helpPaddock
}

// chromeHelpActions is the paddock keymap in help/doc order. docs/KEYBINDS.md is
// generated from it, and the parity test asserts every entry has a handler.
func chromeHelpActions() []keybinds.Action {
	return []keybinds.Action{
		keybinds.ActionPalette,
		keybinds.ActionLaunch,
		keybinds.ActionHelp,
		keybinds.ActionQuit,
		keybinds.ActionEnterInput,
		keybinds.ActionDetachChord,
		keybinds.ActionActivate,
		keybinds.ActionEsc,
		keybinds.ActionFocusNext,
		keybinds.ActionFocusPrev,
		keybinds.ActionFocusPane1,
		keybinds.ActionFocusPane2,
		keybinds.ActionFocusPane3,
		keybinds.ActionFocusPane4,
		keybinds.ActionTreeUp,
		keybinds.ActionTreeDown,
		keybinds.ActionRegionPrev,
		keybinds.ActionRegionNext,
		keybinds.ActionScrollUp,
		keybinds.ActionScrollDown,
		keybinds.ActionScrollTop,
		keybinds.ActionScrollBottom,
		keybinds.ActionActions,
		keybinds.ActionRespond,
		keybinds.ActionRename,
		keybinds.ActionKill,
		keybinds.ActionZen,
		keybinds.ActionPens,
		keybinds.ActionNodes,
		keybinds.ActionFilter,
		keybinds.ActionShellDrawer,
		keybinds.ActionFocusShell,
		keybinds.ActionRetry,
		keybinds.ActionReconnect,
	}
}

// paddockKeyMap implements bubbles/help.KeyMap from the keybinds registry.
type paddockKeyMap struct {
	km    keybinds.Map
	ctx   helpContext
	width int // help viewport width; 0 falls back to a single column
}

func (k paddockKeyMap) ShortHelp() []key.Binding {
	all := k.bindings()
	return all[:min(6, len(all))]
}

func (k paddockKeyMap) FullHelp() [][]key.Binding {
	all := k.bindings()
	n := helpColumns(all, k.width)
	cols := make([][]key.Binding, n)
	// Column-major fill, so reading left-to-right, top-to-bottom preserves the
	// registry's help order.
	for i, b := range all {
		cols[i%n] = append(cols[i%n], b)
	}
	return cols
}

// helpColumns is how many columns fit in width. bubbles/help drops any column
// that overflows its Width — silently, with no ellipsis — so a keymap wider than
// the terminal would lose whole actions from the help it is the source of truth
// for. Sizing the column count to the width instead means nothing is ever cut.
func helpColumns(bindings []key.Binding, width int) int {
	if len(bindings) == 0 || width <= 0 {
		return 1
	}
	widest := 0
	for _, b := range bindings {
		h := b.Help()
		if w := lipgloss.Width(h.Key) + 1 + lipgloss.Width(h.Desc); w > widest {
			widest = w
		}
	}
	const sep = 4 // bubbles/help's inter-column gap
	cols := (width + sep) / (widest + sep)
	if cols < 1 {
		cols = 1
	}
	if cols > maxHelpColumns {
		cols = maxHelpColumns
	}
	return cols
}

const maxHelpColumns = 4

// bindings is what the current surface actually dispatches: registry actions
// plus, for the text-entry surfaces, their own local list navigation.
func (k paddockKeyMap) bindings() []key.Binding {
	km := k.km
	if km == nil {
		km = keybinds.Default()
	}
	full := func(actions ...keybinds.Action) []key.Binding {
		out := make([]key.Binding, 0, len(actions))
		for _, a := range actions {
			if len(km.Sequences(a)) == 0 {
				continue
			}
			out = append(out, bindingFor(km, a))
		}
		return out
	}
	// Surfaces with a focused textinput or huh field only see the chords.
	chords := func(actions ...keybinds.Action) []key.Binding {
		out := make([]key.Binding, 0, len(actions))
		for _, a := range actions {
			if b, ok := modifierBindingFor(km, a); ok {
				out = append(out, b)
			}
		}
		return out
	}

	// Input mode dispatches chords only: its single-key alternates are the
	// agent's keys, and advertising them would be advertising a dead bind.
	chordsOnly := func(actions ...keybinds.Action) []key.Binding {
		out := make([]key.Binding, 0, len(actions))
		for _, a := range actions {
			if b, ok := chordBindingFor(km, a); ok {
				out = append(out, b)
			}
		}
		return out
	}

	// labelled is an action's real keys under a description that fits this
	// surface: the file browser dispatches the region keys, but "next region" is
	// not what they do to a directory.
	labelled := func(action keybinds.Action, desc string) (key.Binding, bool) {
		seqs := km.Sequences(action)
		if len(seqs) == 0 {
			return key.Binding{}, false
		}
		b := bindingFor(km, action)
		b.SetHelp(keybinds.FormatSequences(seqs), desc)
		return b, true
	}

	switch k.ctx {
	case helpInput:
		return chordsOnly(keybinds.ActionDetachChord, keybinds.ActionShellDrawer)
	case helpPalette:
		return append([]key.Binding{
			listKeys.Up,
			listKeys.Down,
			listKeys.GroupNext,
		}, append(full(keybinds.ActionActivate, keybinds.ActionEsc),
			chords(keybinds.ActionQuit, keybinds.ActionShellDrawer, keybinds.ActionReconnect)...)...)
	case helpRespond, helpRename, helpFilter:
		return append(full(keybinds.ActionActivate, keybinds.ActionEsc),
			chords(keybinds.ActionQuit, keybinds.ActionPalette, keybinds.ActionShellDrawer,
				keybinds.ActionReconnect)...)
	case helpActions, helpConfirm:
		// The overlay lists its own verbs; what help adds is the way back out and
		// the chords that survive every surface.
		return append(full(keybinds.ActionEsc),
			chords(keybinds.ActionQuit, keybinds.ActionShellDrawer, keybinds.ActionReconnect)...)
	case helpLaunch:
		return append(full(keybinds.ActionEsc),
			chords(keybinds.ActionQuit, keybinds.ActionPalette, keybinds.ActionShellDrawer,
				keybinds.ActionReconnect)...)
	case helpSettings:
		return full(keybinds.ActionTreeUp, keybinds.ActionTreeDown, keybinds.ActionActivate,
			keybinds.ActionEsc, keybinds.ActionPalette, keybinds.ActionHelp,
			keybinds.ActionQuit, keybinds.ActionShellDrawer, keybinds.ActionReconnect)
	case helpFilesPanel:
		// handleFilesPanelKey dispatches the browser's keys ahead of the panel's
		// scrolling; help must name them or the browser is undiscoverable.
		out := make([]key.Binding, 0, 15)
		for _, b := range []struct {
			action keybinds.Action
			desc   string
		}{
			{keybinds.ActionTreeUp, "move up"},
			{keybinds.ActionTreeDown, "move down"},
			{keybinds.ActionActivate, "enter directory"},
			{keybinds.ActionRegionNext, "enter directory"},
			{keybinds.ActionRegionPrev, "up a directory"},
		} {
			if binding, ok := labelled(b.action, b.desc); ok {
				out = append(out, binding)
			}
		}
		return append(out, full(keybinds.ActionScrollUp, keybinds.ActionScrollDown,
			keybinds.ActionScrollTop, keybinds.ActionScrollBottom, keybinds.ActionEsc,
			keybinds.ActionPalette, keybinds.ActionHelp, keybinds.ActionQuit,
			keybinds.ActionShellDrawer, keybinds.ActionReconnect)...)
	case helpPanel:
		return full(keybinds.ActionTreeUp, keybinds.ActionTreeDown, keybinds.ActionScrollUp,
			keybinds.ActionScrollDown, keybinds.ActionScrollTop, keybinds.ActionScrollBottom,
			keybinds.ActionEsc, keybinds.ActionPalette, keybinds.ActionHelp,
			keybinds.ActionQuit, keybinds.ActionShellDrawer, keybinds.ActionReconnect)
	}
	return full(chromeHelpActions()...)
}

// chordBindingFor keeps only an action's multi-key sequences. The bindings it
// returns never match a key.Matches — chords are the chord engine's — so it is
// for help text only.
func chordBindingFor(km keybinds.Map, action keybinds.Action) (key.Binding, bool) {
	var keep [][]string
	for _, seq := range km.Sequences(action) {
		if len(seq) > 1 {
			keep = append(keep, seq)
		}
	}
	if len(keep) == 0 {
		return key.Binding{}, false
	}
	return key.NewBinding(
		key.WithHelp(keybinds.FormatSequences(keep), keybinds.Description(action)),
	), true
}

// modifierBindingFor keeps only an action's modifier chords, so a surface where
// q is a literal character does not advertise q as quit.
func modifierBindingFor(km keybinds.Map, action keybinds.Action) (key.Binding, bool) {
	var keep [][]string
	for _, seq := range km.Sequences(action) {
		if len(seq) == 1 && isModifierKey(seq[0]) {
			keep = append(keep, seq)
		}
	}
	if len(keep) == 0 {
		return key.Binding{}, false
	}
	single := make([]string, 0, len(keep))
	for _, seq := range keep {
		single = append(single, seq[0])
	}
	return key.NewBinding(
		key.WithKeys(single...),
		key.WithHelp(keybinds.FormatSequences(keep), keybinds.Description(action)),
	), true
}
