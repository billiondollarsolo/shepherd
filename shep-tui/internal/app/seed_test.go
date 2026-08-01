package app

import (
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// Exercises shipped newModel seed: N>2 sessions → full list, pen membership of
// min(N,4) — and one pane on the stage, not a grid nobody asked for.
func TestNewModel_SeedsAllSessionsAndOnePane(t *testing.T) {
	sessions := []domain.Session{
		{ID: "s1", Name: "one", Status: domain.StatusAwaitingInput},
		{ID: "s2", Name: "two", Status: domain.StatusIdle},
		{ID: "s3", Name: "three", Status: domain.StatusRunning},
		{ID: "s4", Name: "four", Status: domain.StatusDone},
		{ID: "s5", Name: "five", Status: domain.StatusIdle},
	}
	opts := SeedOptions(sessions, "local", backend.Caps{Mode: "local", Launch: true, Git: true}, "")
	opts.Version = "dev"
	m := newModel(opts)

	if len(m.sessions) != 5 {
		t.Fatalf("sessions=%d want 5", len(m.sessions))
	}
	if m.nPanes != 1 {
		t.Fatalf("nPanes=%d want a single pane on the stage", m.nPanes)
	}
	ids := m.PenSessionIDs()
	if len(ids) != 4 {
		t.Fatalf("pen ids=%v", ids)
	}
	if m.caps.Mode != "local" || !m.caps.Git {
		t.Fatalf("caps not applied: %+v", m.caps)
	}
	if m.profile != "local" {
		t.Fatalf("profile=%q", m.profile)
	}
}

// The pen holds three sessions; the stage still opens on one of them, and the
// layout the user picks is what unfolds the rest.
func TestNewModel_ThreeSessionsOnePaneUntilAskedForTheGrid(t *testing.T) {
	sessions := []domain.Session{
		{ID: "a", Status: domain.StatusIdle},
		{ID: "b", Status: domain.StatusIdle},
		{ID: "c", Status: domain.StatusIdle},
	}
	m := newModel(SeedOptions(sessions, "home", backend.Caps{Mode: "fleet"}, ""))
	if m.nPanes != 1 {
		t.Fatalf("nPanes=%d want 1", m.nPanes)
	}
	if len(m.PenSessionIDs()) != 3 {
		t.Fatalf("pen membership = %v, want all three sessions", m.PenSessionIDs())
	}
	if len(m.sessions) != 3 {
		t.Fatalf("sessions=%d", len(m.sessions))
	}
	nm, _ := m.setPenLayout(domain.PenLayoutGrid2x2)
	if got := nm.(Model).nPanes; got != 3 {
		t.Fatalf("after choosing a grid layout nPanes=%d want 3", got)
	}
}
