package splash

import (
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

func TestLinesIncludeBuildersAndXLinks(t *testing.T) {
	c := Content{Version: "1.0.0", Profile: "local"}
	text := strings.Join(c.Lines(), "\n")
	if !containsCredits(text) {
		t.Fatalf("missing credits/links:\n%s", text)
	}
	if !containsArt(text) {
		t.Fatalf("missing SHEP-TUI / paddock art:\n%s", text)
	}
	if !strings.Contains(text, "mjtechguy") {
		t.Fatal("missing @mjtechguy")
	}
	if !strings.Contains(text, "blndollarsolo") {
		t.Fatal("missing @blndollarsolo")
	}
	if !strings.Contains(text, "https://x.com/mjtechguy") {
		t.Fatal("missing mjtechguy URL")
	}
	if !strings.Contains(text, "https://x.com/blndollarsolo") {
		t.Fatal("missing blndollarsolo URL")
	}
	if !strings.Contains(text, "SHEP-TUI") {
		t.Fatal("missing product name SHEP-TUI")
	}
	if !strings.Contains(text, Tagline) {
		t.Fatal("missing tagline")
	}
	if !strings.Contains(text, "paddock") {
		t.Fatal("missing paddock wording")
	}
}

func TestRenderIncludesCreditsAndArt(t *testing.T) {
	out := Render(Content{Version: "dev", Profile: "local"}, theme.DefaultLight(), 90, 36)
	if !containsCredits(out) {
		t.Fatalf("render missing credits:\n%s", out)
	}
	if !containsArt(out) {
		t.Fatalf("render missing art:\n%s", out)
	}
	if !strings.Contains(out, "press any key") {
		t.Fatal("missing continue hint")
	}
	if !strings.Contains(out, "@mjtechguy") || !strings.Contains(out, "@blndollarsolo") {
		t.Fatalf("missing @handles in render:\n%s", out)
	}
	if !strings.Contains(out, "SHEP-TUI") {
		t.Fatal("missing SHEP-TUI wordmark")
	}
}

func TestNarrowRenderStillHasCreditsAndName(t *testing.T) {
	out := Render(Content{Version: "dev"}, theme.DefaultDark(), 40, 20)
	if !containsCredits(out) {
		t.Fatalf("narrow render missing credits:\n%s", out)
	}
	if !strings.Contains(out, "SHEP-TUI") {
		t.Fatal("narrow missing SHEP-TUI")
	}
}

// containsCredits reports whether rendered text includes both builders + URLs.
func containsCredits(s string) bool {
	return strings.Contains(s, HandleMJ) &&
		strings.Contains(s, HandleBln) &&
		strings.Contains(s, URLMJ) &&
		strings.Contains(s, URLBln)
}

// containsArt reports whether SHEP-TUI title art and sheep/paddock art appear.
func containsArt(s string) bool {
	return strings.Contains(s, "SHEP-TUI") &&
		(strings.Contains(s, "the paddock") || strings.Contains(s, ",'o\""))
}
