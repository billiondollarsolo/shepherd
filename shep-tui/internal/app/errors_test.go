package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// failingBackend refuses every attach and hangs up its status stream: the two
// ways a live paddock loses touch with agentd.
type failingBackend struct {
	backend.Backend
	opens int
}

func (b *failingBackend) OpenPty(context.Context, string, uint16, uint16) (backend.PtyStream, error) {
	b.opens++
	return nil, errors.New("connection refused")
}

func (b *failingBackend) WatchStatus(context.Context) (<-chan backend.StatusUpdate, error) {
	return nil, errors.New("connection refused")
}

func (b *failingBackend) Close() error { return nil }

func errModel(t *testing.T) Model {
	t.Helper()
	caps := testLocalCaps()
	caps.Git = false
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       caps,
		Sessions:   []domain.Session{{ID: "s1", Name: "one", Status: domain.StatusIdle}},
	})
	m.applySize(100, 30)
	return m
}

// An attach that failed is drawn, not stored where nothing renders it.
func TestAttachFailureIsVisibleAndRetryable(t *testing.T) {
	be := &failingBackend{}
	m := errModel(t)
	m.be = be

	next, _ := m.Update(attachDoneMsg{pane: 0, epoch: m.panes[0].Epoch, err: errors.New("connection refused")})
	m = next.(Model)
	if m.panes[0].AttachErr == "" {
		t.Fatal("attach error must be recorded on the pane")
	}
	if m.toast.level != toastErr || !strings.Contains(m.toast.text, "attach") {
		t.Fatalf("attach failure must raise an error toast: %+v", m.toast)
	}
	body := renderPane(m, 0, paneFocusActive, 40, 12)
	if !strings.Contains(body, "attach failed") || !strings.Contains(body, "connection refused") {
		t.Fatalf("pane does not show why it is empty:\n%s", body)
	}
	// The whole hint, not the bare key: "attach failed" and "connection refused"
	// are full of r's, and an assertion they satisfy proves nothing.
	hint := "press " + m.retryHint() + " to retry"
	if !strings.Contains(body, hint) {
		t.Fatalf("pane does not name the retry key (want %q):\n%s", hint, body)
	}

	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'t'}})
	m = next.(Model)
	if m.panes[0].AttachErr != "" {
		t.Fatal("retry must clear the previous failure")
	}
	if cmd == nil {
		t.Fatal("the retry key must issue a fresh attach")
	}
	m, _ = pump(t, m, cmd)
	if be.opens == 0 {
		t.Fatal("retry never reached the backend")
	}
	if m.panes[0].AttachErr == "" {
		t.Fatal("a retry that fails again must report it")
	}
}

// A closed status watch retries instead of animating a lie forever.
func TestStatusWatchClosedRetriesThenGivesUp(t *testing.T) {
	m := errModel(t)
	m.be = &failingBackend{}

	next, cmd := m.Update(statusWatchClosedMsg{})
	m = next.(Model)
	if !m.reconnecting || m.retryN != 1 {
		t.Fatalf("closed watch must start the reconnect loop: reconnecting=%v retryN=%d", m.reconnecting, m.retryN)
	}
	if cmd == nil {
		t.Fatal("closed watch must return a retry command — the banner spun forever without one")
	}

	// Exhaust the backoff: every re-dial fails.
	for i := 0; i < maxReconnectTries; i++ {
		next, _ = m.Update(reconnectDoneMsg{err: errors.New("connection refused")})
		m = next.(Model)
	}
	if !m.backendDead || m.reconnecting {
		t.Fatalf("after %d failures the app must stop pretending: dead=%v reconnecting=%v",
			maxReconnectTries, m.backendDead, m.reconnecting)
	}
	if m.needsSpinner() {
		t.Fatal("the give-up banner must not animate")
	}
	banner := renderBanner(m)
	if !strings.Contains(banner, "backend lost") || !strings.Contains(banner, "ctrl+r") {
		t.Fatalf("give-up banner does not say what to press:\n%s", banner)
	}

	// ctrl+r is the way back out.
	next, cmd = m.Update(tea.KeyMsg{Type: tea.KeyCtrlR})
	m = next.(Model)
	if m.backendDead || !m.reconnecting || cmd == nil {
		t.Fatalf("ctrl+r must restart the reconnect: dead=%v reconnecting=%v cmd=%v",
			m.backendDead, m.reconnecting, cmd != nil)
	}
}

// A successful re-dial adopts the backend and re-attaches every pane.
func TestReconnectReattachesPanes(t *testing.T) {
	m := errModel(t)
	m.be = &failingBackend{}
	m.reconnecting = true
	m.retryN = 2
	m.panes[0].AttachErr = "connection refused"

	fresh := &attachBackend{}
	next, cmd := m.Update(reconnectDoneMsg{
		be:       fresh,
		caps:     testLocalCaps(),
		sessions: []domain.Session{{ID: "s1", Name: "one", Status: domain.StatusIdle}},
	})
	m = next.(Model)
	if m.be != backend.Backend(fresh) || m.reconnecting || m.retryN != 0 {
		t.Fatalf("reconnect did not adopt the new backend: reconnecting=%v retryN=%d", m.reconnecting, m.retryN)
	}
	m, seen := pump(t, m, cmd)
	attached := false
	for _, msg := range seen {
		if a, ok := msg.(attachDoneMsg); ok && a.pane == 0 && a.err == nil {
			attached = true
		}
	}
	if !attached {
		t.Fatal("reconnect must re-attach the panes it dropped")
	}
	if m.panes[0].AttachErr != "" {
		t.Fatalf("a successful re-attach must clear the old failure: %q", m.panes[0].AttachErr)
	}
}

// Messages are leveled and they go away.
func TestToastExpires(t *testing.T) {
	m := errModel(t)
	m.notifyErr("spawn: connection refused")
	stale := m.toast.seq

	next, _ := m.Update(toastExpiredMsg{seq: stale - 1})
	m = next.(Model)
	if m.toast.text == "" {
		t.Fatal("the timer of a replaced message must not clear the current one")
	}
	next, _ = m.Update(toastExpiredMsg{seq: stale})
	m = next.(Model)
	if m.toast.text != "" {
		t.Fatal("a message must expire on its own — only esc used to clear one")
	}

	// Every setter arms the expiry, wherever in the model it was raised.
	next, cmd := m.Update(gitCommitMsg{ok: "committed"})
	m = next.(Model)
	if m.toast.level != toastOK || cmd == nil {
		t.Fatalf("toast = %+v, expiry cmd = %v", m.toast, cmd != nil)
	}
}

// The detach hint is an invariant — it lives in the header, where a toast
// cannot mask it, and both must be readable at once.
func TestInputHeaderKeepsTheDetachHintBesideAToast(t *testing.T) {
	m := errModel(t)
	m.mode = ModeInput
	m.notifyErr("unmapped key: f13")

	head := renderHeader(m)
	if !strings.Contains(head, "Detach") || !strings.Contains(head, "ctrl+g") {
		t.Fatalf("the input header lost the detach hint:\n%s", head)
	}
	if !strings.Contains(renderToastRow(m), "unmapped key") {
		t.Fatalf("the message itself must still be readable:\n%s", renderToastRow(m))
	}
	// The toast row carries the message and nothing else — the keys are upstairs.
	if strings.Contains(renderToastRow(m), "launch") {
		t.Fatalf("the bottom row grew a key strip:\n%s", renderToastRow(m))
	}
}

// The header hotkeys describe the selection the user is on.
func TestHeaderHotkeysFollowTheSelection(t *testing.T) {
	m := errModel(t)
	keys := map[string]string{}
	for _, hk := range m.headerHotkeys() {
		keys[hk.Key] = hk.Desc
	}
	for _, want := range []string{"enter", "n", "p", "/", "?"} {
		if keys[want] == "" {
			t.Fatalf("the header omits <%s>: %v", want, keys)
		}
	}
	// The session is not attached to a pane, so there is nothing to respond to —
	// and the header may not advertise a key that does nothing.
	if _, ok := keys["R"]; ok {
		t.Fatalf("the header offers respond for a detached agent: %v", keys)
	}
	if _, ok := keys["g"]; ok {
		t.Fatalf("the header offers git on a backend without the capability: %v", keys)
	}

	m.caps.Git = true
	m.panes[0].SessionID = "s1"
	m.panes[0].Stream = stubStream{}
	m.focusSessionID = "s1"
	keys = map[string]string{}
	for _, hk := range m.headerHotkeys() {
		keys[hk.Key] = hk.Desc
	}
	if keys["R"] == "" || keys["g"] == "" {
		t.Fatalf("an attached agent on a git backend must offer both: %v", keys)
	}
	head := renderHeader(m)
	for _, want := range []string{"<enter>", "Attach", "Needs you:", "Agents:", "Profile:"} {
		if !strings.Contains(head, want) {
			t.Fatalf("the header omits %q:\n%s", want, head)
		}
	}
}

// Panels load in a command; a result for a panel the user left is dropped.
func TestPanelLoadsAsynchronously(t *testing.T) {
	m := errModel(t)
	nm, cmd := m.openPanelAsync("files", filesPanelLoader(t.TempDir()))
	m = nm.(Model)
	if cmd == nil {
		t.Fatal("an async panel must load in a command, not inside Update")
	}
	if len(m.panel.Lines()) == 0 || !strings.Contains(m.panel.Lines()[0], "loading") {
		t.Fatalf("panel must show it is loading: %v", m.panel.Lines())
	}
	m, _ = pump(t, m, cmd)
	if m.filesBrowser == nil || len(m.panel.Lines()) == 0 || strings.Contains(m.panel.Lines()[0], "loading") {
		t.Fatalf("panel content never arrived: %v", m.panel.Lines())
	}

	loaded := strings.Join(m.panel.Lines(), "\n")
	next, _ := m.Update(panelLoadedMsg{kind: "files", seq: m.panelSeq - 1, lines: []string{"stale"}})
	m = next.(Model)
	if strings.Join(m.panel.Lines(), "\n") != loaded {
		t.Fatal("a load from a panel the user has left must not overwrite the open one")
	}
}

// The stale watch of a backend the app has replaced must not push that machine's
// sessions into the tree of the one the user is now connected to.
func TestStaleStatusWatchIsFenced(t *testing.T) {
	m := errModel(t)
	m.be = &attachBackend{}

	// Generation 1 is the live watch.
	cmd := m.watchStatusCmd()
	if cmd == nil {
		t.Fatal("no watch")
	}
	m, _ = pump(t, m, cmd)
	live := m.watchSeq

	// The profile switch (or reconnect) opens generation 2 and cancels the first.
	if cmd := m.watchStatusCmd(); cmd == nil {
		t.Fatal("no second watch")
	}
	if m.watchSeq == live {
		t.Fatal("a new subscription must open a new generation")
	}

	next, cmd := m.Update(statusUpdateMsg{
		StatusUpdate: backend.StatusUpdate{SessionID: "ghost", Status: domain.StatusIdle},
		seq:          live,
	})
	m = next.(Model)
	for _, s := range m.sessions {
		if s.ID == "ghost" {
			t.Fatal("a session from the replaced backend was appended to the session list")
		}
	}
	if cmd != nil {
		t.Fatal("a stale watch must die, not re-arm itself on the current channel")
	}

	// The stale watch hanging up is not the live backend going away.
	next, _ = m.Update(statusWatchClosedMsg{seq: live})
	if next.(Model).reconnecting {
		t.Fatal("a stale watch closing must not start the reconnect loop")
	}
}

// The blink loop is one chain per generation: attention flipping off and back on
// inside a tick window used to leave two loops repainting the screen forever.
func TestBlinkLoopsDoNotStack(t *testing.T) {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Sessions:   []domain.Session{{ID: "s1", Status: domain.StatusAwaitingInput}},
	})
	m.reducedMotion = false
	inFlight := blinkTickMsg{seq: m.blinkSeq}

	// Attention clears, then returns while the first loop's tick is still pending.
	next, _ := m.Update(statusUpdateMsg{StatusUpdate: backend.StatusUpdate{
		SessionID: "s1", Status: domain.StatusIdle}})
	m = next.(Model)
	next, cmd := m.Update(statusUpdateMsg{StatusUpdate: backend.StatusUpdate{
		SessionID: "s1", Status: domain.StatusAwaitingInput}})
	m = next.(Model)
	if cmd == nil {
		t.Fatal("attention returning must arm the blink loop")
	}

	// The tick from the old generation is orphaned: it may not start a second chain.
	next, cmd = m.Update(inFlight)
	m = next.(Model)
	if cmd != nil {
		t.Fatal("a tick from a superseded generation started a second blink loop")
	}

	// The current generation's chain keeps running.
	if _, cmd := m.Update(blinkTickMsg{seq: m.blinkSeq}); cmd == nil {
		t.Fatal("the live blink loop stopped re-arming")
	}
}

// A pane may never be titled with one session while holding another's PTY.
func TestPenSwitchNeverLeavesAPaneOnAnotherSessionsPty(t *testing.T) {
	m := newModel(Options{Version: "test", SkipSplash: true, Sessions: []domain.Session{
		{ID: "A", Name: "a"}, {ID: "B", Name: "b"}, {ID: "C", Name: "c"},
	}})
	m.applySize(100, 30)
	sa, sb := &countingStream{}, &countingStream{}
	m.nPanes = 2
	m.panes[0].SessionID, m.panes[0].Stream = "A", sa
	m.panes[1].SessionID, m.panes[1].Stream = "B", sb

	// The new pen keeps B, but on another pane.
	m.applyActivePen(domain.Pen{ID: "p2", ProjectID: "(default)", Name: "p2",
		SessionIDs: []string{"B", "C"}, Layout: domain.PenLayoutCols})

	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].Stream == nil {
			continue
		}
		t.Fatalf("pane %d (%s) kept a stream from the previous pen", i, m.panes[i].SessionID)
	}
	if sb.Closes() == 0 {
		t.Fatal("the moved session's old stream was never closed — its PTY would feed another pane")
	}
	if sa.Closes() == 0 {
		t.Fatal("the departed session's stream was never closed")
	}
}

// A pane pointed at a new session must not keep drawing the last one's failure.
func TestAttachErrorDoesNotFollowThePane(t *testing.T) {
	m := errModel(t)
	m.sessions = append(m.sessions, domain.Session{ID: "s2", Name: "two", Status: domain.StatusIdle})
	m.panes[0].AttachErr = "dial: connection refused"

	next, _ := m.focusSessionIntoPen(m.sessionOrPlaceholder("s2"))
	m = next.(Model)
	if m.panes[0].AttachErr != "" {
		t.Fatalf("AttachErr = %q — the new session inherited the old one's failure", m.panes[0].AttachErr)
	}
	if body := renderPane(m, 0, paneFocusActive, 40, 12); strings.Contains(body, "attach failed") {
		t.Fatalf("the pane still draws the previous session's failure:\n%s", body)
	}
}

// The composed view must fit the terminal on every surface: a viewport sized from
// a different geometry than its box pushes the statusline off the screen.
func TestViewFitsTheTerminal(t *testing.T) {
	base := errModel(t)
	base.applySize(80, 40)
	nm, _ := base.openPanel("git", strings.Split(strings.Repeat("diff line\n", 200), "\n"))
	panelModel := nm.(Model)

	drawer := panelModel
	drawer.shellOpen = true
	drawer.resizeStreams()

	banner := panelModel
	banner.reconnecting = true
	banner.resizeStreams()

	for name, m := range map[string]Model{
		"panel":            panelModel,
		"panel + drawer":   drawer,
		"panel + banner":   banner,
		"paddock":          base,
		"paddock + drawer": func() Model { d := base; d.shellOpen = true; d.resizeStreams(); return d }(),
	} {
		if h := lipgloss.Height(m.View()); h > m.height {
			t.Errorf("%s: view is %d rows on a %d-row terminal", name, h, m.height)
		}
	}
}

// A toast raised inside newModel predates the first Update, so the seq diff that
// arms expiry never sees it: Init has to arm it, or the message is pinned to the
// statusline for the rest of the session.
func TestStartupToastExpires(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pens.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := newModel(Options{Version: "test", SkipSplash: true, PensPath: path})
	if m.toast.text == "" {
		t.Fatal("a corrupt pens.json must be reported")
	}

	// This model has no backend and nothing to animate, so the expiry is the only
	// command Init can return.
	if m.Init() == nil {
		t.Fatal("Init armed no expiry for the startup toast — it would never go away")
	}
	next, _ := m.Update(toastExpiredMsg{seq: m.toast.seq})
	if got := next.(Model); got.toast.text != "" {
		t.Fatalf("the toast outlived its expiry: %q", got.toast.text)
	}
}
