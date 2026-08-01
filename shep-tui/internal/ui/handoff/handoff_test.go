package handoff

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBuildBootstrapBasic(t *testing.T) {
	got := BuildBootstrap("claude", "fix login bug", []string{"ran tests", "failed on auth"}, 0)
	if !strings.Contains(got, "From: claude") {
		t.Fatalf("missing from: %q", got)
	}
	if !strings.Contains(got, "Summary: fix login bug") {
		t.Fatalf("missing summary: %q", got)
	}
	if !strings.Contains(got, "ran tests") || !strings.Contains(got, "failed on auth") {
		t.Fatalf("missing context: %q", got)
	}
	if !strings.HasPrefix(got, "## Agent handoff\n") {
		t.Fatalf("prefix: %q", got)
	}
}

func TestBuildBootstrapEmpty(t *testing.T) {
	got := BuildBootstrap("", "", nil, 0)
	if got != "## Agent handoff\n" {
		t.Fatalf("got %q", got)
	}
}

func TestBuildBootstrapTruncation(t *testing.T) {
	lines := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		lines = append(lines, strings.Repeat("x", 40))
	}
	const max = 200
	got := BuildBootstrap("agent-a", "long handoff", lines, max)
	n := utf8.RuneCountInString(got)
	if n > max {
		t.Fatalf("rune count %d > max %d\n%q", n, max, got)
	}
	if !strings.Contains(got, "…[truncated]…") {
		t.Fatalf("expected truncation marker: %q", got)
	}
	// Header should mostly survive (prefix-weighted).
	if !strings.Contains(got, "Agent handoff") {
		t.Fatalf("header lost: %q", got)
	}
}

func TestBuildBootstrapUnderLimit(t *testing.T) {
	got := BuildBootstrap("a", "b", []string{"c"}, 10_000)
	if strings.Contains(got, "truncated") {
		t.Fatalf("unexpected truncate: %q", got)
	}
}

func TestBuildBootstrapTinyMax(t *testing.T) {
	got := BuildBootstrap("agent", "summary", []string{"line"}, 5)
	if utf8.RuneCountInString(got) != 5 {
		t.Fatalf("want 5 runes, got %d %q", utf8.RuneCountInString(got), got)
	}
}

func TestBuildBootstrapUnicode(t *testing.T) {
	// Ensure truncation is by runes, not bytes.
	summary := strings.Repeat(" agé", 50) // multi-byte é
	got := BuildBootstrap("x", summary, nil, 30)
	if utf8.RuneCountInString(got) > 30 {
		t.Fatalf("rune overflow: %d %q", utf8.RuneCountInString(got), got)
	}
	if !utf8.ValidString(got) {
		t.Fatal("invalid utf8 after truncate")
	}
}
