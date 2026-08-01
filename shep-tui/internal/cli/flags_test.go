package cli

import (
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/config"
)

func TestParseTUIFlags(t *testing.T) {
	f, err := parseTUIFlags([]string{
		"--profile", "fleet", "--theme", "flock-light",
		"--scrollback", "2000", "--no-splash",
	})
	if err != nil {
		t.Fatal(err)
	}
	if f.Overrides.Profile != "fleet" || f.Overrides.Theme != "flock-light" {
		t.Fatalf("overrides = %+v", f.Overrides)
	}
	if f.Overrides.Scrollback != 2000 || !f.NoSplash {
		t.Fatalf("flags = %+v", f)
	}
}

// Demo shells are opt-in: a fresh install must land on the empty state, not on
// two mystery sessions that then live in agentd forever.
func TestDemoShellsAreOptIn(t *testing.T) {
	f, err := parseTUIFlags(nil)
	if err != nil {
		t.Fatal(err)
	}
	if f.Demo {
		t.Fatal("demo sessions must not be the default")
	}
	if f, err = parseTUIFlags([]string{"--demo"}); err != nil || !f.Demo {
		t.Fatalf("--demo = %v (%v)", f.Demo, err)
	}
}

// `shep-tui tui fleet` used to start the default profile and say nothing.
func TestParseTUIFlagsRejectsPositionalArgs(t *testing.T) {
	if _, err := parseTUIFlags([]string{"fleet"}); err == nil {
		t.Fatal("a positional argument must be an error")
	}
}

func TestLoadTUIConfigAppliesFlagLayerOverFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SHEP_TUI_CONFIG_DIR", dir)
	t.Setenv("SHEP_TUI_PROFILE", "")

	saved := config.Default()
	saved.UI.Theme = "flock-dark"
	saved.Profiles["fleet"] = config.Profile{Mode: config.ModeFleet, URL: "https://flock.example"}
	if err := config.Save(saved); err != nil {
		t.Fatal(err)
	}

	f, err := parseTUIFlags([]string{"--profile", "fleet", "--theme", "flock-light"})
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := loadTUIConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultProfile != "fleet" {
		t.Fatalf("--profile ignored: %q", cfg.DefaultProfile)
	}
	if cfg.UI.Theme != "flock-light" {
		t.Fatalf("--theme ignored: %q", cfg.UI.Theme)
	}
}
