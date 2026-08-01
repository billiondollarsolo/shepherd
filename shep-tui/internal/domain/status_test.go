package domain

import "testing"

func TestEveryStatusHasAffirmativeLabel(t *testing.T) {
	for _, s := range StatusValues {
		label := s.Label()
		if label == "" {
			t.Fatalf("%s: empty label", s)
		}
	}
	if StatusIdle.Label() != "Idle" {
		t.Fatalf("idle label = %q, want Idle", StatusIdle.Label())
	}
	if StatusRunning.Label() != "Working" {
		t.Fatalf("running label = %q, want Working", StatusRunning.Label())
	}
	if StatusAwaitingInput.Label() != "Needs you" {
		t.Fatalf("awaiting label = %q, want Needs you", StatusAwaitingInput.Label())
	}
}

func TestAttentionRankNeedsYouFirst(t *testing.T) {
	if StatusAwaitingInput.Policy().AttentionRank != 0 {
		t.Fatal("Needs you must rank 0")
	}
	if StatusError.Policy().AttentionRank != 1 {
		t.Fatal("Error must rank 1")
	}
	if StatusAwaitingInput.Policy().AttentionRank >= StatusIdle.Policy().AttentionRank {
		t.Fatal("Needs you must sort above Idle")
	}
}

func TestNotifyPolicy(t *testing.T) {
	wantPush := map[Status]bool{
		StatusAwaitingInput: true,
		StatusError:         true,
		StatusDone:          true,
		StatusRunning:       false,
		StatusIdle:          false,
	}
	for s, want := range wantPush {
		if s.Policy().Pushes != want {
			t.Fatalf("%s pushes=%v want %v", s, s.Policy().Pushes, want)
		}
	}
}
