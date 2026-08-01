package session

import (
	"context"
	"testing"
	"time"
)

func TestWaitOutputImmediateMatch(t *testing.T) {
	m := NewManager()
	s, err := m.Open(Spec{
		ID: "wo1", Command: []string{"sh", "-c", "printf 'hello MATCHME world\\n'; sleep 30"},
		Cols: 40, Rows: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close("wo1")
	_ = s
	// Give pump time to write
	time.Sleep(50 * time.Millisecond)
	line, err := m.WaitOutput(context.Background(), "wo1", "MATCHME", "", 2000)
	if err != nil {
		t.Fatal(err)
	}
	if line == "" {
		t.Fatal("empty matched line")
	}
}

func TestWaitOutputTimeout(t *testing.T) {
	m := NewManager()
	s, err := m.Open(Spec{
		ID: "wo2", Command: []string{"sh", "-c", "sleep 30"},
		Cols: 40, Rows: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close("wo2")
	_ = s
	_, err = m.WaitOutput(context.Background(), "wo2", "NEVER_APPEARS_XYZ", "", 80)
	if err == nil {
		t.Fatal("expected timeout")
	}
	if e, ok := err.(*WaitStatusError); !ok || e.Code != "timeout" {
		t.Fatalf("err=%v", err)
	}
}

func TestWaitOutputEventualMatch(t *testing.T) {
	m := NewManager()
	s, err := m.Open(Spec{
		ID: "wo3", Command: []string{"sh", "-c", "sleep 0.15; printf 'later LATEMATCH\\n'; sleep 30"},
		Cols: 40, Rows: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close("wo3")
	_ = s
	// Must poll — one-shot at t=0 would fail
	line, err := m.WaitOutput(context.Background(), "wo3", "LATEMATCH", "", 3000)
	if err != nil {
		t.Fatal(err)
	}
	if line == "" {
		t.Fatal("empty")
	}
}

func TestWaitOutputSessionGone(t *testing.T) {
	m := NewManager()
	_, err := m.WaitOutput(context.Background(), "nope", "x", "", 100)
	if err == nil {
		t.Fatal("expected error")
	}
}
