package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/billiondollarsolo/flock/agentd/internal/session"
	"github.com/billiondollarsolo/flock/agentd/internal/status"
	"github.com/billiondollarsolo/flock/agentd/proto"
)

// TestD9ClearUnseenIdleOnWire is the definition of "D9 badge clear works":
// focus-clear StatusEvent → real statusControl → json.Marshal → wire contains
// "unseenIdle":false (not omitted by omitempty). Then simulate orchestrator
// merge of sticky true + parsed false → false.
//
// A plain bool+omitempty on Control.UnseenIdle would drop false on the wire and
// leave merge sticky-true — that bug is what this test gates forever.
func TestD9ClearUnseenIdleOnWire(t *testing.T) {
	// Focus-clear event as Manager.SetFocused produces (UnseenIdle=&false).
	cleared := false
	ev := session.StatusEvent{
		ID: "sess-d9",
		Update: status.Update{
			State:      status.StateIdle,
			UnseenIdle: &cleared,
		},
	}

	ctrl := statusControl(ev)
	if ctrl.UnseenIdle == nil {
		t.Fatal("statusControl must assign UnseenIdle pointer (not nil)")
	}
	if *ctrl.UnseenIdle {
		t.Fatal("statusControl must carry false for badge clear")
	}

	raw, err := json.Marshal(ctrl)
	if err != nil {
		t.Fatal(err)
	}
	wire := string(raw)
	if !strings.Contains(wire, `"unseenIdle":false`) {
		t.Fatalf("wire must emit explicit false for D9 clear; got %s", wire)
	}

	// Orchestrator shape: JSON control frame as NodeAgentdClient receives it.
	var parsed struct {
		Op         string `json:"op"`
		ID         string `json:"id"`
		State      string `json:"state"`
		UnseenIdle *bool  `json:"unseenIdle"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.UnseenIdle == nil {
		t.Fatal("parsed wire missing unseenIdle — omitempty dropped false (proto bug)")
	}
	if *parsed.UnseenIdle {
		t.Fatal("parsed unseenIdle must be false")
	}

	// Sticky previous badge true + incoming clear false (mergeAgentMeta rule).
	prevUnseen := true
	var merged bool
	if parsed.UnseenIdle != nil {
		merged = *parsed.UnseenIdle
	} else {
		merged = prevUnseen
	}
	if merged {
		t.Fatal("after wire clear, merge must yield false (not sticky previous true)")
	}
}

// TestD9UnseenIdleTrueStillOnWire ensures setting the badge still encodes.
func TestD9UnseenIdleTrueStillOnWire(t *testing.T) {
	set := true
	ev := session.StatusEvent{
		ID: "sess-d9-set",
		Update: status.Update{
			State:      status.StateIdle,
			UnseenIdle: &set,
		},
	}
	raw, err := json.Marshal(statusControl(ev))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"unseenIdle":true`) {
		t.Fatalf("want true on wire, got %s", raw)
	}
}

// TestD9NilUnseenIdleOmitsField: unknown/absent does not force a value.
func TestD9NilUnseenIdleOmitsField(t *testing.T) {
	ev := session.StatusEvent{
		ID:     "sess-d9-nil",
		Update: status.Update{State: status.StateRunning},
	}
	raw, err := json.Marshal(statusControl(ev))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "unseenIdle") {
		t.Fatalf("nil UnseenIdle must omit field, got %s", raw)
	}
	// Compile-time: Control.UnseenIdle is *bool
	var c proto.Control
	var _ *bool = c.UnseenIdle
}

// TestD9RegressionPlainBoolWouldDropFalse documents the bug we fixed.
func TestD9RegressionPlainBoolWouldDropFalse(t *testing.T) {
	type broken struct {
		UnseenIdle bool `json:"unseenIdle,omitempty"`
	}
	raw, _ := json.Marshal(broken{UnseenIdle: false})
	if strings.Contains(string(raw), "unseenIdle") {
		t.Fatal("test assumption failed: plain bool false should omit with omitempty")
	}
	// And the shipped type must NOT behave like that when set to false.
	f := false
	shipped, _ := json.Marshal(proto.Control{Op: "status", UnseenIdle: &f})
	if !strings.Contains(string(shipped), `"unseenIdle":false`) {
		t.Fatalf("shipped proto.Control must emit false, got %s", shipped)
	}
}
