package chat

import (
	"testing"
	"time"
)

func TestAppendAndLines(t *testing.T) {
	var p Panel
	now := time.Unix(0, 0).UTC()
	p.Append(Event{Kind: KindUser, Text: "hello", At: now})
	p.Append(Event{Kind: KindAssistant, Text: "hi there", At: now})
	p.Append(Event{Kind: KindTool, Text: "read foo.go", At: now})

	got := p.Lines(10)
	want := []string{
		"[user] hello",
		"[assistant] hi there",
		"[tool] read foo.go",
	}
	assertStrings(t, got, want)
}

func TestLinesMaxAndScroll(t *testing.T) {
	var p Panel
	for i, kind := range []string{KindSystem, KindUser, KindAssistant, KindPlan} {
		p.Append(Event{Kind: kind, Text: string(rune('a' + i))})
	}
	// max=2, scroll=0 → last two
	got := p.Lines(2)
	assertStrings(t, got, []string{"[assistant] c", "[plan] d"})

	// scroll=1 peeks one older line, still window of 2
	p.Scroll = 1
	got = p.Lines(2)
	assertStrings(t, got, []string{"[user] b", "[assistant] c"})

	// scroll past start clamps
	p.Scroll = 100
	got = p.Lines(2)
	assertStrings(t, got, []string{"[system] a", "[user] b"})
}

func TestLinesMultilineText(t *testing.T) {
	var p Panel
	p.Append(Event{Kind: KindAssistant, Text: "line1\nline2"})
	got := p.Lines(10)
	assertStrings(t, got, []string{"[assistant] line1", "  line2"})
}

func TestLinesEmptyKindAndText(t *testing.T) {
	var p Panel
	p.Append(Event{})
	got := p.Lines(5)
	assertStrings(t, got, []string{"[system]"})
}

func TestClear(t *testing.T) {
	var p Panel
	p.Append(Event{Kind: KindUser, Text: "x"})
	p.Scroll = 2
	p.Clear()
	if len(p.Events) != 0 || p.Scroll != 0 {
		t.Fatalf("clear failed: %#v", p)
	}
	if p.Lines(5) != nil {
		t.Fatal("expected nil lines after clear")
	}
}

func assertStrings(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("len got %d want %d\ngot  %#v\nwant %#v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d: got %q want %q\nfull got %#v", i, got[i], want[i], got)
		}
	}
}
