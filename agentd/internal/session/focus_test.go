package session

import (
	"testing"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

func TestSetFocusedFansOutUnseenIdleClear(t *testing.T) {
	m := NewManager()
	s, err := m.Open(Spec{ID: "f1", Command: []string{"sleep", "30"}, Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close("f1")
	_ = s

	// Unfocused idle → unseenIdle true
	m.emitStatus(StatusEvent{ID: "f1", Update: status.Update{State: status.StateIdle}})
	sub := m.SubscribeStatus()
	defer sub.Close()

	// Drain snapshot
	_ = sub.Snapshot

	done := make(chan StatusEvent, 1)
	go func() {
		for ev := range sub.Events {
			if ev.ID == "f1" && ev.UnseenIdle != nil && !*ev.UnseenIdle {
				done <- ev
				return
			}
		}
	}()

	m.SetFocused("f1", true)

	select {
	case <-done:
		// ok
	case <-time.After(time.Second):
		t.Fatal("expected fan-out clearing unseenIdle on focus")
	}
}
