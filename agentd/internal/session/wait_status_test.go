package session

import (
	"context"
	"testing"
	"time"

	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

func TestWaitStatusImmediateMatch(t *testing.T) {
	m := NewManager()
	// Open a short-lived sleep so a session exists
	s, err := m.Open(Spec{ID: "w1", Command: []string{"sleep", "30"}, Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close("w1")
	_ = s
	m.emitStatus(StatusEvent{ID: "w1", Update: status.Update{State: status.StateIdle}})
	st, err := m.WaitStatus(context.Background(), "w1", []string{"idle"}, 1000)
	if err != nil || st != "idle" {
		t.Fatalf("st=%s err=%v", st, err)
	}
}

func TestWaitStatusTimeout(t *testing.T) {
	m := NewManager()
	s, err := m.Open(Spec{ID: "w2", Command: []string{"sleep", "30"}, Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close("w2")
	_ = s
	m.emitStatus(StatusEvent{ID: "w2", Update: status.Update{State: status.StateRunning}})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err = m.WaitStatus(ctx, "w2", []string{"idle"}, 50)
	if err == nil {
		t.Fatal("expected timeout")
	}
	if e, ok := err.(*WaitStatusError); !ok || e.Code != "timeout" {
		t.Fatalf("err=%v", err)
	}
}

func TestWaitStatusEventDriven(t *testing.T) {
	m := NewManager()
	s, err := m.Open(Spec{ID: "w3", Command: []string{"sleep", "30"}, Cols: 40, Rows: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close("w3")
	_ = s
	m.emitStatus(StatusEvent{ID: "w3", Update: status.Update{State: status.StateRunning}})
	go func() {
		time.Sleep(30 * time.Millisecond)
		m.emitStatus(StatusEvent{ID: "w3", Update: status.Update{State: status.StateAwaiting}})
	}()
	st, err := m.WaitStatus(context.Background(), "w3", []string{"awaiting_input", "blocked"}, 2000)
	if err != nil || st != status.StateAwaiting {
		t.Fatalf("st=%s err=%v", st, err)
	}
}
