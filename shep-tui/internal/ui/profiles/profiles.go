// Package profiles provides pure helpers for listing and switching config profiles.
package profiles

import (
	"fmt"
	"sort"

	"github.com/billiondollarsolo/shep-tui/internal/config"
)

// Names returns sorted profile names from cfg.
func Names(cfg *config.Config) []string {
	if cfg == nil || len(cfg.Profiles) == 0 {
		return nil
	}
	out := make([]string, 0, len(cfg.Profiles))
	for name := range cfg.Profiles {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Switch sets DefaultProfile to name and returns the new default name.
// name must exist in cfg.Profiles.
func Switch(cfg *config.Config, name string) (string, error) {
	if cfg == nil {
		return "", fmt.Errorf("profiles: nil config")
	}
	if name == "" {
		return "", fmt.Errorf("profiles: empty name")
	}
	if _, ok := cfg.Profiles[name]; !ok {
		return "", fmt.Errorf("profiles: unknown profile %q", name)
	}
	cfg.DefaultProfile = name
	return name, nil
}

// Lines formats profile names for CLI display (marks the active one).
func Lines(cfg *config.Config) []string {
	names := Names(cfg)
	if len(names) == 0 {
		return []string{"(no profiles)"}
	}
	active := cfg.ActiveName()
	out := make([]string, 0, len(names))
	for _, n := range names {
		mark := " "
		if n == active {
			mark = "*"
		}
		mode := ""
		if cfg != nil {
			if p, ok := cfg.Profiles[n]; ok {
				mode = string(p.Mode)
				if mode == "" {
					mode = string(config.ModeLocal)
				}
			}
		}
		out = append(out, fmt.Sprintf("%s %s\t%s", mark, n, mode))
	}
	return out
}
