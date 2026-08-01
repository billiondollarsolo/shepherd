package profiles

import (
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/config"
)

func TestNamesSorted(t *testing.T) {
	cfg := &config.Config{
		DefaultProfile: "local",
		Profiles: map[string]config.Profile{
			"zeta":  {Mode: config.ModeFleet},
			"local": {Mode: config.ModeLocal},
			"alpha": {Mode: config.ModeFleet},
		},
	}
	got := Names(cfg)
	want := []string{"alpha", "local", "zeta"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestActiveAndSwitch(t *testing.T) {
	cfg := config.Default()
	if cfg.ActiveName() != "local" {
		t.Fatalf("active = %q", cfg.ActiveName())
	}
	cfg.Profiles["fleet"] = config.Profile{Mode: config.ModeFleet, URL: "https://x"}
	got, err := Switch(cfg, "fleet")
	if err != nil || got != "fleet" {
		t.Fatalf("switch: %q %v", got, err)
	}
	if cfg.ActiveName() != "fleet" || cfg.DefaultProfile != "fleet" {
		t.Fatalf("default = %q active = %q", cfg.DefaultProfile, cfg.ActiveName())
	}
	_, err = Switch(cfg, "missing")
	if err == nil {
		t.Fatal("expected error for missing profile")
	}
}

func TestLinesMarksActive(t *testing.T) {
	cfg := config.Default()
	cfg.Profiles["home"] = config.Profile{Mode: config.ModeFleet}
	cfg.DefaultProfile = "home"
	joined := strings.Join(Lines(cfg), "\n")
	if !strings.Contains(joined, "* home") {
		t.Fatalf("active mark missing:\n%s", joined)
	}
	if !strings.Contains(joined, "  local") {
		t.Fatalf("inactive local missing:\n%s", joined)
	}
}

func TestNilConfig(t *testing.T) {
	if Names(nil) != nil {
		t.Fatal("Names(nil)")
	}
	var nilCfg *config.Config
	if nilCfg.ActiveName() != "" {
		t.Fatal("ActiveName(nil)")
	}
	if _, err := Switch(nil, "x"); err == nil {
		t.Fatal("Switch(nil)")
	}
}
