package audit

import (
	"strings"
	"testing"
	"time"
)

func TestFilterAndCursor(t *testing.T) {
	b := &Browser{
		Entries: []Entry{
			{Time: time.Unix(1, 0).UTC(), Action: "login", Actor: "alice", Target: "auth", Detail: "ok"},
			{Time: time.Unix(2, 0).UTC(), Action: "spawn", Actor: "bob", Target: "sess-1", Detail: "shell"},
			{Time: time.Unix(3, 0).UTC(), Action: "close", Actor: "alice", Target: "sess-1", Detail: ""},
		},
		Cursor: 2,
	}
	b.SetFilter("alice")
	got := b.Filtered()
	if len(got) != 2 {
		t.Fatalf("filtered = %#v", got)
	}
	if b.Cursor != 1 { // clamped from 2 → last index of 2 results
		t.Fatalf("cursor = %d", b.Cursor)
	}
	b.SetFilter("spawn")
	if len(b.Filtered()) != 1 || b.Filtered()[0].Actor != "bob" {
		t.Fatalf("spawn filter: %#v", b.Filtered())
	}
	b.SetFilter("no-such")
	if len(b.Filtered()) != 0 || b.Cursor != 0 {
		t.Fatalf("empty filter state cursor=%d entries=%v", b.Cursor, b.Filtered())
	}
}

func TestLinesHighlightCursor(t *testing.T) {
	b := &Browser{
		Entries: []Entry{
			{Action: "a", Actor: "x"},
			{Action: "b", Actor: "y"},
		},
		Cursor: 1,
	}
	lines := b.Lines()
	if len(lines) != 2 {
		t.Fatalf("lines = %v", lines)
	}
	if !strings.HasPrefix(lines[1], ">") {
		t.Fatalf("cursor line should start with >: %q", lines[1])
	}
	if !strings.HasPrefix(lines[0], " ") {
		t.Fatalf("non-cursor should be space: %q", lines[0])
	}
}

func TestEmptyBrowserLines(t *testing.T) {
	var b Browser
	lines := b.Lines()
	if len(lines) != 1 || !strings.Contains(lines[0], "no audit") {
		t.Fatalf("lines = %v", lines)
	}
}
