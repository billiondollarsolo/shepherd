package motion

import "testing"

func TestReducedMotionPrefAndEnv(t *testing.T) {
	t.Setenv("SHEP_TUI_REDUCED_MOTION", "")
	t.Setenv("FLOCK_REDUCED_MOTION", "")
	t.Setenv("PREFERS_REDUCED_MOTION", "")

	if ReducedMotion(false) {
		t.Fatal("no env, pref off: want false")
	}
	if !ReducedMotion(true) {
		t.Fatal("no env, pref on: want true")
	}

	// The documented name is the one PRODUCT.md tells users to set.
	t.Setenv("SHEP_TUI_REDUCED_MOTION", "1")
	if !ReducedMotion(false) {
		t.Fatal("SHEP_TUI_REDUCED_MOTION=1 should enable reduced motion")
	}
	// An explicit 0 overrides a config true.
	t.Setenv("SHEP_TUI_REDUCED_MOTION", "0")
	if ReducedMotion(true) {
		t.Fatal("SHEP_TUI_REDUCED_MOTION=0 should override the config pref")
	}

	t.Setenv("SHEP_TUI_REDUCED_MOTION", "")
	t.Setenv("FLOCK_REDUCED_MOTION", "yes")
	if !ReducedMotion(false) {
		t.Fatal("legacy FLOCK_REDUCED_MOTION should still work")
	}
}
