package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/store"
)

func TestPenMembershipSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pens.json")

	sessions := []domain.Session{
		{ID: "alpha", Name: "alpha", Status: domain.StatusIdle},
		{ID: "beta", Name: "beta", Status: domain.StatusRunning},
		{ID: "gamma", Name: "gamma", Status: domain.StatusAwaitingInput},
	}

	opts1 := Options{
		Sessions: sessions,
		Profile:  "local",
		Caps:     backend.Caps{Mode: "local"},
		PensPath: path,
	}
	m1 := newModel(opts1)
	if len(m1.PenSessionIDs()) != 3 {
		t.Fatalf("pen membership = %v, want all three sessions", m1.PenSessionIDs())
	}
	// Reorder pen: only gamma + alpha (2 panes) by writing store and re-saving.
	m1.nPanes = 2
	m1.panes[0].SessionID = "gamma"
	m1.panes[1].SessionID = "alpha"
	m1.panes[2].SessionID = ""
	m1.savePensIfConfigured()

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("pens.json not written: %v", err)
	}

	// Second start loads pens.json and attaches gamma, alpha — not default first-3 order.
	opts2 := Options{
		Sessions: sessions,
		Profile:  "local",
		Caps:     backend.Caps{Mode: "local"},
		PensPath: path,
	}
	m2 := newModel(opts2)
	ids := m2.PenSessionIDs()
	if len(ids) < 2 {
		t.Fatalf("ids=%v", ids)
	}
	if ids[0] != "gamma" || ids[1] != "alpha" {
		t.Fatalf("persisted pen order not restored: %v", ids)
	}
	// Full session list still available for tree.
	if m2.SessionCount() != 3 {
		t.Fatalf("sessions=%d", m2.SessionCount())
	}

	// Round-trip via store API alone (shipped SavePens/LoadPens).
	st := store.New()
	if err := st.LoadPens(path); err != nil {
		t.Fatal(err)
	}
	ap := st.ActivePen("(default)")
	if len(ap.SessionIDs) < 2 {
		t.Fatalf("active pen after load: %+v", ap)
	}
}
