package cli

import (
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/app"
	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// TestBuildTUIOptions_FullSessionListNoTwoClamp is the real seed path used by runTUI:
// ListSessions of N>2 must seed ALL N into Options.Sessions, with pen panes = min(N,4).
func TestBuildTUIOptions_FullSessionListNoTwoClamp(t *testing.T) {
	sessions := []domain.Session{
		{ID: "s1", Name: "one", Status: domain.StatusAwaitingInput},
		{ID: "s2", Name: "two", Status: domain.StatusIdle},
		{ID: "s3", Name: "three", Status: domain.StatusRunning},
		{ID: "s4", Name: "four", Status: domain.StatusDone},
		{ID: "s5", Name: "five", Status: domain.StatusIdle},
	}
	caps := backend.Caps{Mode: "local", Launch: true, Git: true, ShellDrawer: true}
	cfg := config.Default()
	opts := BuildTUIOptions("dev", sessions, cfg, caps)

	if len(opts.Sessions) != 5 {
		t.Fatalf("Sessions len=%d want 5 (full list for tree; no [:2] clamp)", len(opts.Sessions))
	}
	if opts.Profile != "local" {
		t.Fatalf("Profile=%q", opts.Profile)
	}
	if opts.Caps.Mode != "local" || !opts.Caps.Git || !opts.Caps.Launch {
		t.Fatalf("Caps not wired: %+v", opts.Caps)
	}
	if opts.PensPath == "" {
		t.Fatal("PensPath empty — pen persist not configured")
	}
	if opts.Version != "dev" {
		t.Fatalf("Version=%q", opts.Version)
	}
	if opts.Backend != nil {
		t.Fatal("BuildTUIOptions should not set Backend (runTUI assigns client)")
	}

	// Pen pane count from shipped helper (same as newModel).
	if got := app.PenPaneCount(opts.Sessions); got != domain.MaxPenSessions {
		t.Fatalf("PenPaneCount=%d want %d", got, domain.MaxPenSessions)
	}
}

func TestBuildTUIOptions_ThreeSessions(t *testing.T) {
	sessions := []domain.Session{
		{ID: "a", Status: domain.StatusIdle},
		{ID: "b", Status: domain.StatusIdle},
		{ID: "c", Status: domain.StatusIdle},
	}
	cfg := config.Default()
	cfg.Profiles["home"] = config.Profile{Mode: config.ModeFleet, URL: "https://flock.example"}
	cfg.DefaultProfile = "home"
	opts := BuildTUIOptions("v", sessions, cfg, backend.Caps{Mode: "fleet", MultiNode: true})
	if len(opts.Sessions) != 3 {
		t.Fatalf("len=%d", len(opts.Sessions))
	}
	if app.PenPaneCount(opts.Sessions) != 3 {
		t.Fatalf("pen count=%d", app.PenPaneCount(opts.Sessions))
	}
	if opts.Profile != "home" || opts.Caps.Mode != "fleet" {
		t.Fatalf("profile/caps: %q %+v", opts.Profile, opts.Caps)
	}
}

func TestHelpMentionsPensNotDualPaneSpike(t *testing.T) {
	out, err := captureStdout(t, func() error {
		return Run("dev", []string{"help"})
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "dual-pane spike") {
		t.Fatalf("help still says dual-pane spike:\n%s", out)
	}
	if !strings.Contains(out, "paddock") && !strings.Contains(out, "pens") {
		t.Fatalf("help missing paddock/pens wording:\n%s", out)
	}
}
