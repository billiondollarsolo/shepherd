package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// killBackend records the sessions the app asked agentd to close.
type killBackend struct {
	backend.Backend
	closed []string
	err    error
}

func (b *killBackend) CloseSession(_ context.Context, id string) error {
	b.closed = append(b.closed, id)
	return b.err
}

func (b *killBackend) Close() error { return nil }

func actionsModel(t *testing.T) Model {
	t.Helper()
	caps := testLocalCaps()
	caps.Cost = true
	caps.Git = false
	caps.Files = false
	caps.Chat = false
	caps.Handoff = false
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       caps,
		PensPath:   filepath.Join(t.TempDir(), "pens.json"),
		Sessions: []domain.Session{
			{ID: "alpha", Name: "claude-api", Status: domain.StatusRunning},
			{ID: "beta", Name: "codex-ui", Status: domain.StatusIdle},
		},
	})
	m.applySize(120, 40)
	m.region = RegionMain
	return m
}

// The menu lists what the selected session can actually do — an action the
// backend cannot serve is not offered, and its key does nothing.
func TestSessionActionsAreScopedToTheSelection(t *testing.T) {
	m := actionsModel(t)

	keys := map[string]bool{}
	for _, a := range m.sessionActions() {
		keys[a.Key] = true
	}
	for _, want := range []string{"enter", "r", "e", "x"} {
		if !keys[want] {
			t.Fatalf("actions omit %q: %v", want, keys)
		}
	}
	if keys["R"] {
		t.Fatal("respond is offered for a session that is not attached to a live pane")
	}
	if keys["g"] {
		t.Fatal("git is offered on a backend without the capability")
	}

	m.caps.Git = true
	m.panes[0].SessionID = "alpha"
	m.panes[0].Stream = stubStream{}
	m.focus = 0
	keys = map[string]bool{}
	for _, a := range m.sessionActions() {
		keys[a.Key] = true
	}
	if !keys["R"] || !keys["g"] {
		t.Fatalf("attached session with git omits respond/git: %v", keys)
	}
}

// The menu is discovery, the keys are speed: both go through one dispatch, so a
// key that is not offered cannot act either.
func TestUnavailableActionKeyDoesNotDispatch(t *testing.T) {
	m := actionsModel(t)
	if _, _, ok := m.runSessionAction("g"); ok {
		t.Fatal("git dispatched without the capability")
	}
	if _, _, ok := m.runSessionAction("x"); !ok {
		t.Fatal("kill must always be available")
	}
}

func TestActionsOverlayOpensAndClosesLikeEveryOtherOverlay(t *testing.T) {
	m := actionsModel(t)
	m = press(m, "a")
	if m.stage != StageActions {
		t.Fatalf("a did not open the actions overlay: %s", m.stage)
	}
	view := m.View()
	if !strings.Contains(view, "claude-api") || !strings.Contains(view, "kill session") {
		t.Fatalf("actions overlay does not describe the selection:\n%s", view)
	}
	m = press(m, "esc")
	if m.stage != StageTable {
		t.Fatalf("esc did not close the actions overlay: %s", m.stage)
	}
}

// Kill is irreversible: it is asked for twice, and only then does it reach the
// backend — off the Update goroutine.
func TestKillConfirmsThenClosesTheSession(t *testing.T) {
	be := &killBackend{}
	m := actionsModel(t)
	m.be = be
	m.panes[0].SessionID = "alpha"
	m.panes[0].Stream = stubStream{}

	m = press(m, "x")
	if m.stage != StageConfirm {
		t.Fatalf("x killed without confirming: stage = %s", m.stage)
	}
	if len(be.closed) != 0 {
		t.Fatalf("the backend was called before the user said yes: %v", be.closed)
	}
	if !strings.Contains(m.View(), "kill claude-api?") {
		t.Fatalf("the confirm does not name what it would kill:\n%s", m.View())
	}

	// n is not yes.
	m = press(m, "n")
	if m.stage != StageTable || len(be.closed) != 0 {
		t.Fatalf("n killed anyway: stage = %s closed = %v", m.stage, be.closed)
	}

	m = press(m, "x")
	next, cmd := m.Update(keyMsg("y"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("y must issue the close as a command")
	}
	m, _ = pump(t, m, cmd)
	if len(be.closed) != 1 || be.closed[0] != "alpha" {
		t.Fatalf("CloseSession = %v", be.closed)
	}
	for _, s := range m.sessions {
		if s.ID == "alpha" {
			t.Fatal("the killed session is still in the list")
		}
	}
	if m.panes[0].SessionID != "" || m.panes[0].Stream != nil {
		t.Fatalf("the pane still holds the killed session: %+v", m.panes[0])
	}
	if m.toast.level != toastOK || !strings.Contains(m.toast.text, "claude-api") {
		t.Fatalf("kill did not report itself: %+v", m.toast)
	}
}

func TestKillFailureIsReported(t *testing.T) {
	be := &killBackend{err: errors.New("no such session")}
	m := actionsModel(t)
	m.be = be

	m = press(m, "x", "y")
	m, _ = pump(t, m, m.killSessionCmd("alpha", "claude-api"))
	if m.toast.level != toastErr || !strings.Contains(m.toast.text, "no such session") {
		t.Fatalf("a failed kill must say so: %+v", m.toast)
	}
	if len(m.sessions) != 2 {
		t.Fatal("a session that was not killed may not leave the list")
	}
}

// The name is this client's: agentd has no rename, so it is persisted here and
// applied wherever the session is drawn.
func TestRenameIsALocalNameAppliedEverywhere(t *testing.T) {
	m := actionsModel(t)
	m.panes[0].SessionID = "alpha"
	m.panes[0].Title = m.paneTitle(m.sessionOrPlaceholder("alpha"))

	m = press(m, "r")
	if m.stage != StageRename {
		t.Fatalf("r did not open the rename bar: %s", m.stage)
	}
	m = press(m, "p", "a", "y", "m", "e", "n", "t", "s")
	next, cmd := m.Update(keyMsg("enter"))
	m = next.(Model)
	if m.stage != StageTable {
		t.Fatalf("enter did not close the rename bar: %s", m.stage)
	}
	if got := m.aliases["alpha"]; got != "payments" {
		t.Fatalf("alias = %q", got)
	}
	if !strings.Contains(m.panes[0].Title, "payments") {
		t.Fatalf("pane title kept the old name: %q", m.panes[0].Title)
	}
	m.syncTable()
	if !strings.Contains(renderTable(m, 120, 20), "payments") {
		t.Fatalf("the table kept the old name:\n%s", renderTable(m, 120, 20))
	}

	m, _ = pump(t, m, cmd)
	if _, err := os.Stat(m.aliasPath); err != nil {
		t.Fatalf("the name was never persisted: %v", err)
	}

	// A reload of the same directory finds the name again.
	reloaded := newModel(Options{Version: "test", SkipSplash: true, PensPath: m.pensPath,
		Sessions: []domain.Session{{ID: "alpha", Name: "claude-api"}}})
	if got := reloaded.sessionName(domain.Session{ID: "alpha", Name: "claude-api"}); got != "payments" {
		t.Fatalf("name did not survive a restart: %q", got)
	}

	// An empty name clears it.
	nm, _ := reloaded.applyRename("alpha", "")
	if got := nm.(Model).sessionName(domain.Session{ID: "alpha", Name: "claude-api"}); got != "claude-api" {
		t.Fatalf("empty name did not clear the alias: %q", got)
	}
}

// Telemetry is drawn on the agent it belongs to — one column each, and an agent
// the backend says nothing about gets empty cells rather than invented ones.
func TestTableCarriesTheSessionsTelemetry(t *testing.T) {
	cost := 0.18
	m := actionsModel(t)
	m.sessions[0].Telemetry = domain.Telemetry{
		Model: "sonnet", ContextTokens: 42, ContextLimit: 100,
		Tokens: 12000, CostUSD: &cost,
	}
	m.syncTable()

	body := renderTable(m, 120, 20)
	for _, want := range []string{"sonnet", "42%", "12k", "$0.18"} {
		if !strings.Contains(body, want) {
			t.Fatalf("the table omits the running agent's %q:\n%s", want, body)
		}
	}
	if strings.Count(body, "codex-ui") != 1 {
		t.Fatalf("the agent without telemetry lost its row:\n%s", body)
	}
	for _, r := range m.table.Rows() {
		if r.SessionID == "beta" && (r.Model != "" || r.Cost != "" || r.Tokens != "") {
			t.Fatalf("unknown telemetry was invented: %+v", r)
		}
	}
	// One line per agent: the table never grows a row it did not have an agent for.
	if m.table.Len() != len(m.sessions) {
		t.Fatalf("table rows = %d for %d agents", m.table.Len(), len(m.sessions))
	}
}
