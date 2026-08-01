// Reconnection: when the backend goes away, the paddock says so once, retries on
// its own, and stops pretending when it has given up.
package app

import (
	"math/rand"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
)

// statusWatchClosedMsg reports that the status stream ended: the backend hung up,
// or WatchStatus could not subscribe in the first place. seq is the watch
// generation it belongs to (see Model.watchSeq).
type statusWatchClosedMsg struct{ seq int }

// reconnectTickMsg fires a backoff attempt. n is the retry it belongs to, so the
// timer of an attempt that has already been superseded (ctrl+r) is ignored.
type reconnectTickMsg struct{ n int }

// reconnectDoneMsg carries the outcome of one re-dial. On error the old backend
// is untouched and still the app's.
type reconnectDoneMsg struct {
	be       backend.Backend
	caps     backend.Caps
	sessions []domain.Session
	err      error
}

// Backoff: 500ms × 2ⁿ, capped, jittered. maxReconnectTries is where the app
// stops spinning a lie and tells the user the backend is gone.
const (
	reconnectBase     = 500 * time.Millisecond
	reconnectCap      = 15 * time.Second
	maxReconnectTries = 6
)

func reconnectDelay(n int) time.Duration {
	d := reconnectBase << min(n, 16)
	if d > reconnectCap || d <= 0 {
		d = reconnectCap
	}
	// Jitter ±20%: a fleet of paddocks must not re-dial a restarting agentd in
	// lockstep.
	jitter := time.Duration(rand.Int63n(int64(d/5)+1)) - d/10
	return d + jitter
}

// watchClosed enters the reconnect loop. It is the single place the app learns
// that the backend is unreachable.
func (m Model) watchClosed() (tea.Model, tea.Cmd) {
	before := m.motionState()
	m.statusCh = nil
	if m.be == nil || m.backendDead {
		// Nothing to reconnect to (tests / fatal screen).
		return m.armMotion(before, nil)
	}
	m.reconnecting = true
	if m.st != nil {
	}
	return m.armMotion(before, m.scheduleReconnect())
}

// scheduleReconnect arms the next backoff attempt, or gives up.
func (m *Model) scheduleReconnect() tea.Cmd {
	if m.retryN >= maxReconnectTries {
		m.reconnecting = false
		m.backendDead = true
		if m.st != nil {
		}
		m.notifyErr("backend lost · " + m.reconnectHint() + " to retry")
		return nil
	}
	m.retryN++
	n := m.retryN
	return tea.Tick(reconnectDelay(n-1), func(time.Time) tea.Msg {
		return reconnectTickMsg{n: n}
	})
}

// reconnectCmd re-dials the active profile off the Update goroutine. The status
// stream cannot be re-subscribed on a client whose transport is dead, so this
// opens a new one and the old backend is hung up once the new one is adopted.
func (m Model) reconnectCmd() tea.Cmd {
	return dialCmd(m.settingsUI(), func(be backend.Backend, caps backend.Caps, sessions []domain.Session, err error) tea.Msg {
		return reconnectDoneMsg{be: be, caps: caps, sessions: sessions, err: err}
	})
}

func (m Model) reconnectDone(msg reconnectDoneMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		before := m.motionState()
		m.notifyErrf("reconnect: %v", msg.err)
		return m.armMotion(before, m.scheduleReconnect())
	}
	return m.applyReconnect(msg)
}

// applyReconnect adopts the freshly dialed backend. Every stream the model still
// holds belongs to the old transport, so they are dropped and each pane's session
// is attached again — an attach that now fails is reported by renderPane.
func (m Model) applyReconnect(msg reconnectDoneMsg) (tea.Model, tea.Cmd) {
	before := m.motionState()
	old := m.be

	drawerWasOpen := m.shellOpen
	m.closeStreams()
	m.mode = ModeChrome
	for i := 0; i < domain.MaxPenSessions; i++ {
		m.nextEpoch(i)
	}

	m.be = msg.be
	m.caps = msg.caps
	m.retryN = 0
	m.reconnecting = false
	m.backendDead = false
	m.sessions = append([]domain.Session(nil), msg.sessions...)
	if m.st != nil {
		m.st.SeedSessions(m.sessions)
	}
	m.syncTable()

	cmds := []tea.Cmd{closeBackendCmd(old), m.watchStatusCmd()}
	cmds = append(cmds, m.reattachPanes()...)
	if drawerWasOpen {
		nm, cmd := m.showShellDrawer()
		m = nm.(Model)
		cmds = append(cmds, cmd)
	}
	m.notifyOK("reconnected")
	return m.armMotion(before, tea.Batch(cmds...))
}

// reattachPanes re-opens the PTY of every pane that has a session but no stream.
func (m *Model) reattachPanes() []tea.Cmd {
	var cmds []tea.Cmd
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == "" || m.panes[i].Stream != nil {
			continue
		}
		m.panes[i].AttachErr = ""
		cmds = append(cmds, m.attachPaneCmd(i, m.nextEpoch(i), m.panes[i].SessionID))
	}
	return cmds
}

// reconnectNow is the Reconnect bind: it restarts the backoff from zero, which is
// the only way out of backendDead.
func (m Model) reconnectNow() (tea.Model, tea.Cmd) {
	if m.be == nil && m.cfg == nil {
		m.notifyErr("reconnect: no backend configured")
		return m, nil
	}
	before := m.motionState()
	m.retryN = 0
	m.backendDead = false
	m.reconnecting = true
	if m.st != nil {
	}
	m.notify("reconnecting…")
	return m.armMotion(before, m.reconnectCmd())
}

// retryAttach is the Retry bind: re-open the focused pane's PTY after an attach
// failed (or after the agent's PTY closed under it).
func (m Model) retryAttach() (tea.Model, tea.Cmd) {
	sid := m.panes[m.focus].SessionID
	switch {
	case sid == "":
		return m, nil
	case m.be == nil:
		m.notifyErr("attach: no backend")
		return m, nil
	case m.panes[m.focus].Stream != nil:
		m.notify(m.panes[m.focus].Title + " is already attached")
		return m, nil
	}
	m.panes[m.focus].AttachErr = ""
	m.notify("attaching " + domain.ShortID(sid) + "…")
	return m, m.attachPaneCmd(m.focus, m.nextEpoch(m.focus), sid)
}

// retryHint / reconnectHint render the live binds, so the chrome cannot advertise
// a key a rebind file moved.
func (m Model) retryHint() string {
	return keybinds.FormatChord(m.binds().Sequence(keybinds.ActionRetry))
}

func (m Model) reconnectHint() string {
	return keybinds.FormatChord(m.binds().Sequence(keybinds.ActionReconnect))
}

// binds is the keybind registry, defaulted: a Model built by a test literal has
// no map, and chrome that renders a bind must still render one.
func (m Model) binds() keybinds.Map {
	if m.km == nil {
		return keybinds.Default()
	}
	return m.km
}

// showBanner reports whether the connectivity banner takes a row of the screen.
func (m Model) showBanner() bool {
	return m.reconnecting || m.backendDead
}
