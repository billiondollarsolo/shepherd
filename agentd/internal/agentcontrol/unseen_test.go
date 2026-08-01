package agentcontrol

import "testing"

func TestNextUnseenIdle(t *testing.T) {
	if !NextUnseenIdle("running", "idle", false, false) {
		t.Fatal("unfocused idle should be unseen")
	}
	if NextUnseenIdle("running", "idle", true, false) {
		t.Fatal("focused clears")
	}
	if NextUnseenIdle("idle", "done", false, true) {
		t.Fatal("done clears")
	}
	if NextUnseenIdle("idle", "running", false, true) {
		t.Fatal("not idle")
	}
}
