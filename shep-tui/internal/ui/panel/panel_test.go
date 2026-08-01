package panel

import (
	"fmt"
	"strings"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

func longPanel() Model {
	lines := make([]string, 100)
	for i := range lines {
		lines[i] = fmt.Sprintf("line-%03d", i)
	}
	return New("git", "git", lines, 40, 10)
}

func TestScrollingReachesEveryLine(t *testing.T) {
	p := longPanel()
	if !strings.Contains(p.View(theme.DefaultDark()), "line-000") {
		t.Fatal("panel does not open at the top")
	}
	p.GotoBottom()
	out := p.View(theme.DefaultDark())
	if !strings.Contains(out, "line-099") {
		t.Fatalf("last line unreachable:\n%s", out)
	}
	if !strings.Contains(out, "/100") {
		t.Fatalf("missing scroll indicator:\n%s", out)
	}
	p.GotoTop()
	if p.YOffset() != 0 {
		t.Fatal("GotoTop did not reach the top")
	}
	p.HalfPageDown()
	if p.YOffset() == 0 {
		t.Fatal("half page down did not move")
	}
	p.LineUp(1)
	p.LineDown(2)
	if len(p.Lines()) != 100 {
		t.Fatalf("content lost: %d lines", len(p.Lines()))
	}
}

func TestSetLinesKeepsOffsetInRange(t *testing.T) {
	p := longPanel()
	p.GotoBottom()
	p.SetLines([]string{"only"})
	if p.YOffset() != 0 {
		t.Fatalf("offset %d past the new content", p.YOffset())
	}
	if !strings.Contains(p.View(theme.DefaultDark()), "only") {
		t.Fatal("new content not shown")
	}
}
