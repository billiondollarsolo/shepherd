package domain

import (
	"testing"
)

func TestSortSessionsByAttentionOrder(t *testing.T) {
	// Unsorted mix: idle, running, awaiting, error, done, disconnected, starting
	in := []Session{
		{Name: "zeta", Status: StatusIdle},
		{Name: "alpha", Status: StatusRunning},
		{Name: "need-b", Status: StatusAwaitingInput},
		{Name: "need-a", Status: StatusAwaitingInput},
		{Name: "err", Status: StatusError},
		{Name: "done", Status: StatusDone},
		{Name: "gone", Status: StatusDisconnected},
		{Name: "boot", Status: StatusStarting},
	}
	SortSessionsByAttention(in)

	// Expected rank order: awaiting(0), error(1), done(2), idle(3), starting(4), running(5), disconnected(6)
	// Within awaiting: need-a before need-b (name).
	want := []struct {
		name   string
		status Status
	}{
		{"need-a", StatusAwaitingInput},
		{"need-b", StatusAwaitingInput},
		{"err", StatusError},
		{"done", StatusDone},
		{"zeta", StatusIdle},
		{"boot", StatusStarting},
		{"alpha", StatusRunning},
		{"gone", StatusDisconnected},
	}
	if len(in) != len(want) {
		t.Fatalf("len = %d, want %d", len(in), len(want))
	}
	for i := range want {
		if in[i].Name != want[i].name || in[i].Status != want[i].status {
			t.Fatalf("at %d: got %s/%s, want %s/%s", i, in[i].Name, in[i].Status, want[i].name, want[i].status)
		}
	}
}

func TestSortSessionsByAttentionStable(t *testing.T) {
	// Same rank + same name path not required; same rank different equal names keep relative order.
	in := []Session{
		{ID: "1", Name: "same", Status: StatusIdle},
		{ID: "2", Name: "same", Status: StatusIdle},
		{ID: "3", Name: "same", Status: StatusIdle},
	}
	SortSessionsByAttention(in)
	if in[0].ID != "1" || in[1].ID != "2" || in[2].ID != "3" {
		t.Fatalf("stable order broken: %v %v %v", in[0].ID, in[1].ID, in[2].ID)
	}
}

func TestSortSessionsByAttentionEmpty(t *testing.T) {
	SortSessionsByAttention(nil)
	SortSessionsByAttention([]Session{})
}
