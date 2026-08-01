package app

import (
	"strings"
	"testing"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/keybinds"
)

// fleetViewOnlyCaps is what the fleet client actually reports: it can list,
// watch, attach and close, and nothing else.
func fleetViewOnlyCaps() backend.Caps {
	return backend.Caps{Mode: "fleet", MultiNode: true, Cost: true}
}

func capsModel(caps backend.Caps, sessions ...domain.Session) Model {
	m := newModel(Options{
		Version:    "test",
		SkipSplash: true,
		Caps:       caps,
		Sessions:   sessions,
	})
	m.applySize(120, 40)
	return m
}

func paletteHas(m Model, id string) bool {
	for _, c := range m.buildPaletteCatalog() {
		if c.ID == id {
			return true
		}
	}
	return false
}

// Fleet cannot create a session and has no shell drawer or audit log. The
// palette offered all of them and every one dead-ended in an ErrNotSupported
// toast.
func TestPaletteHidesWhatFleetCannotDo(t *testing.T) {
	m := capsModel(fleetViewOnlyCaps())
	for _, id := range []string{
		"action:launch",
		"action:spawn",
		"action:shell",
		"action:focusshell",
		"action:audit",
	} {
		if paletteHas(m, id) {
			t.Errorf("the fleet palette offers %s, which returns ErrNotSupported", id)
		}
	}

	local := capsModel(testLocalCaps())
	for _, id := range []string{"action:launch", "action:spawn", "action:shell", "action:focusshell"} {
		if !paletteHas(local, id) {
			t.Errorf("the local palette lost %s", id)
		}
	}
}

// No backend implements ListAudit, so the audit surface appears nowhere. It is
// gated rather than deleted: the day a backend reports Caps.Audit it lights up.
func TestPaletteAuditFollowsTheCapability(t *testing.T) {
	caps := fleetViewOnlyCaps()
	if paletteHas(capsModel(caps), "action:audit") {
		t.Fatal("audit listed with Caps.Audit false")
	}
	caps.Audit = true
	if !paletteHas(capsModel(caps), "action:audit") {
		t.Fatal("audit hidden with Caps.Audit true")
	}
}

// The cost table is a palette entry only where a cost exists to table.
func TestPaletteCostFollowsTheCapability(t *testing.T) {
	if paletteHas(capsModel(testLocalCaps()), "action:cost") {
		t.Fatal("cost table offered on agentd, which reports no cost")
	}
	caps := testLocalCaps()
	caps.Cost = true
	if !paletteHas(capsModel(caps), "action:cost") {
		t.Fatal("cost table hidden on a backend that reports cost")
	}
}

// A backend that cannot price a session gets no COST column: an always-empty
// column reads as "this agent cost nothing".
func TestCostColumnAbsentWithoutCapability(t *testing.T) {
	cost := 0.18
	session := domain.Session{
		ID: "s1", Name: "one", Status: domain.StatusRunning,
		Telemetry: domain.Telemetry{Model: "sonnet", Tokens: 12000, CostUSD: &cost},
	}

	m := capsModel(testLocalCaps(), session)
	out := renderTable(m, 120, 20)
	if strings.Contains(out, "COST") {
		t.Fatalf("the COST column survives on a backend with no cost:\n%s", out)
	}
	if strings.Contains(out, "$0.18") {
		t.Fatalf("a cost was printed on a backend that reports none:\n%s", out)
	}

	caps := testLocalCaps()
	caps.Cost = true
	m = capsModel(caps, session)
	out = renderTable(m, 120, 20)
	if !strings.Contains(out, "COST") || !strings.Contains(out, "$0.18") {
		t.Fatalf("the COST column must be drawn where cost is reported:\n%s", out)
	}
}

// The empty state names the way out, and only where there is one: fleet has no
// launch key to press.
func TestEmptyStateDoesNotPromiseLaunchOnFleet(t *testing.T) {
	fleet := emptyStateMessage(capsModel(fleetViewOnlyCaps()))
	if strings.Contains(fleet, "press n") || strings.Contains(fleet, "to launch agent") {
		t.Fatalf("the fleet empty state tells the user to press a dead key: %q", fleet)
	}
	if !strings.Contains(fleet, "cannot launch") {
		t.Fatalf("the fleet empty state must say why: %q", fleet)
	}
	local := emptyStateMessage(capsModel(testLocalCaps()))
	if !strings.Contains(local, "to launch agent") {
		t.Fatalf("the local empty state lost its call to action: %q", local)
	}
}

// The header hotkeys obey the same rule as the actions menu.
func TestHeaderHotkeysHideLaunchAndShellOnFleet(t *testing.T) {
	m := capsModel(fleetViewOnlyCaps(), domain.Session{ID: "s1", Name: "one"})
	for _, hk := range m.headerHotkeys() {
		if hk.Desc == "Launch" || hk.Desc == "Shell" {
			t.Fatalf("the fleet header advertises %q (<%s>), which cannot work", hk.Desc, hk.Key)
		}
	}
	local := capsModel(testLocalCaps(), domain.Session{ID: "s1", Name: "one"})
	var launch, shell bool
	for _, hk := range local.headerHotkeys() {
		switch hk.Desc {
		case "Launch":
			launch = true
		case "Shell":
			shell = true
		}
	}
	if !launch || !shell {
		t.Fatalf("the local header lost its keys: %+v", local.headerHotkeys())
	}
}

// Pressing the launch key on a backend that cannot launch does nothing at all —
// it does not open a form whose only outcome is an error toast.
func TestLaunchKeyIsInertOnFleet(t *testing.T) {
	m := capsModel(fleetViewOnlyCaps())
	nm, _, ok := m.runAction(keybinds.ActionLaunch)
	if ok {
		t.Fatalf("launch dispatched on fleet: stage=%s", nm.stage)
	}
	if nm.stage == StageLaunch {
		t.Fatal("the launch form opened on a backend that cannot launch")
	}
}

// Handoff hands off: the bootstrap carries the outgoing agent's transcript, and
// the agent the user launches from the panel is typed that bootstrap as soon as
// its PTY is live. Before, the transcript arg was hardcoded nil and no session
// was ever created.
func TestHandoffSeedsTheAgentItLaunches(t *testing.T) {
	m := capsModel(testLocalCaps(), domain.Session{ID: "s1", Name: "one", Status: domain.StatusRunning})
	m.be = &attachBackend{}
	m.panes[0].SessionID = "s1"
	m.panes[0].Stream = &countingStream{}
	m.focusSessionID = "s1"
	m.panes[0].feed([]byte("the outgoing agent said this\r\n"))

	nm, _ := m.openHandoff()
	m = nm.(Model)
	if m.panelKind != "handoff" {
		t.Fatalf("panel = %q", m.panelKind)
	}
	body := strings.Join(m.panel.Lines(), "\n")
	for _, want := range []string{"Agent handoff", "Recent context", "the outgoing agent said this"} {
		if !strings.Contains(body, want) {
			t.Fatalf("the bootstrap omits %q:\n%s", want, body)
		}
	}

	next, _ := m.Update(keyMsg("enter"))
	m = next.(Model)
	if m.stage != StageLaunch {
		t.Fatalf("enter did not chain into launch: stage=%s", m.stage)
	}
	if m.launchSeed == "" {
		t.Fatal("the launch carries no seed")
	}

	next, _ = m.Update(spawnDoneMsg{session: domain.Session{ID: "s2", Name: "two"}})
	m = next.(Model)
	if m.seedBySession["s2"] == "" {
		t.Fatal("the new session was not given the seed to type")
	}

	pane := -1
	for i := 0; i < m.nPanes; i++ {
		if m.panes[i].SessionID == "s2" {
			pane = i
		}
	}
	if pane < 0 {
		t.Fatal("the launched session took no pane")
	}
	stream := &countingStream{}
	next, _ = m.Update(attachDoneMsg{pane: pane, epoch: m.panes[pane].Epoch, stream: stream})
	m = next.(Model)
	// The adopted stream is an Async writer: the bytes leave on its own goroutine.
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(stream.Written(), "Agent handoff") {
		if time.Now().After(deadline) {
			t.Fatalf("the seed never reached the new agent's PTY: %q", stream.Written())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if m.seedBySession["s2"] != "" {
		t.Fatal("the seed must be typed once, not on every re-attach")
	}
}
