// Package motion handles reduced-motion prefs and attention blink timing.
package motion

import (
	"os"
	"strings"
	"time"
)

// BlinkPeriod is the Needs-you pulse half-period (on/off each interval).
// Web Flock uses a ~2s ease pulse; we flip every second for terminal glyphs.
const BlinkPeriod = time.Second

// envNames are the reduced-motion env vars in precedence order. The documented
// SHEP_TUI_ name comes first; FLOCK_* names are legacy aliases from flock-tui.
var envNames = []string{
	"SHEP_TUI_REDUCED_MOTION",
	"FLOCK_TUI_REDUCED_MOTION",
	"FLOCK_REDUCED_MOTION",
	"PREFERS_REDUCED_MOTION",
}

// ReducedMotion resolves the preference: env over the config value pref, so an
// explicit SHEP_TUI_REDUCED_MOTION=0 turns animation back on for one session
// without editing config.toml. NO_COLOR is a color pref and lives in ui/theme.
func ReducedMotion(pref bool) bool {
	if _, v, pinned := EnvPin(); pinned {
		return v
	}
	return pref
}

// EnvPin reports the value the environment forces, if any. name is the var that
// won, so a caller offering to change the preference can say what to unset
// instead of pretending a toggle it cannot honor took effect.
func EnvPin() (name string, value, pinned bool) {
	for _, n := range envNames {
		if v, ok := lookupBool(n); ok {
			return n, v, true
		}
	}
	return "", false, false
}

// lookupBool reads name as a boolean; present reports that it was set at all
// (an unset var and an explicit "0" mean different things here).
func lookupBool(name string) (value, present bool) {
	raw, ok := os.LookupEnv(name)
	if !ok {
		return false, false
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return false, false
	case "0", "false", "no", "off":
		return false, true
	default:
		return true, true
	}
}
