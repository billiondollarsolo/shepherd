package cli

import (
	"path/filepath"

	"github.com/billiondollarsolo/shep-tui/internal/app"
	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// DefaultPensFile is the on-disk pen membership path under the config dir.
// Empty disables pen persistence: an unresolvable config dir has already been
// reported by config.Load, which runs first.
func DefaultPensFile() string {
	dir, err := config.Dir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "pens.json")
}

// BuildTUIOptions is the shipped seed path for runTUI.
//
// Sessions is the full list (sidebar) — never truncated.
// Pen panes use min(len(sessions), MaxPenSessions) via app.SeedOptions/newModel.
// cfg carries the [ui] settings the paddock renders with (theme, scrollback,
// pen layout, reduced motion, mouse).
func BuildTUIOptions(version string, sessions []domain.Session, cfg *config.Config, caps backend.Caps) app.Options {
	profile := cfg.ActiveName()
	if profile == "" {
		profile = cfg.DefaultProfile
	}
	opts := app.SeedOptions(sessions, profile, caps, DefaultPensFile())
	opts.Version = version
	opts.Cfg = cfg
	return opts
}
