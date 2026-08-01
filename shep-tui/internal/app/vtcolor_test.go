package app

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"

	"github.com/billiondollarsolo/shep-tui/internal/vt"
)

// forceColor pins the color profile for the test: lipgloss strips color when it
// decides the terminal has none, which under `go test` is always. Restored after,
// so it cannot leak into a test that asserts plain output.
func forceColor(t *testing.T) {
	t.Helper()
	prev := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	t.Cleanup(func() { lipgloss.SetColorProfile(prev) })
}

// Agent PTYs (htop, claude code, ls --color) paint with SGR. The vt parser stores
// it per cell, but the string accessors flatten a row to runes — so a renderer
// reading RowString shows the text and throws every color away.
func TestAgentColorsSurviveTheRenderPath(t *testing.T) {
	forceColor(t)

	s := vt.New(40, 4, 100)
	_, _ = s.Write([]byte("\x1b[31mred\x1b[0m plain \x1b[1;32mboldgreen\x1b[0m"))

	out := renderVT(s, 40, 4, 0)
	if !strings.Contains(out, "red") || !strings.Contains(out, "boldgreen") {
		t.Fatalf("text missing from render:\n%q", out)
	}
	if !strings.Contains(out, "\x1b[") {
		t.Fatalf("no SGR in rendered output — agent colors are being dropped:\n%q", out)
	}
	// The plain word must not inherit the red run's styling.
	if strings.Count(out, "\x1b[0m") == 0 {
		t.Errorf("no style resets — runs are not being closed:\n%q", out)
	}
}

func TestTrueColorAndIndexedBothRender(t *testing.T) {
	forceColor(t)

	s := vt.New(40, 2, 10)
	_, _ = s.Write([]byte("\x1b[38;2;255;0;0mrgb\x1b[0m\x1b[38;5;213mxterm\x1b[0m"))
	out := renderVT(s, 40, 2, 0)

	if !strings.Contains(out, "rgb") || !strings.Contains(out, "xterm") {
		t.Fatalf("text missing:\n%q", out)
	}
	if !strings.Contains(out, "\x1b[") {
		t.Fatalf("24-bit / 256-color SGR did not survive:\n%q", out)
	}
}

// A run of identically-styled cells must be emitted once, not per character —
// renderVT runs on every PTY chunk.
func TestStyledRunsAreCoalesced(t *testing.T) {
	forceColor(t)

	s := vt.New(40, 2, 10)
	_, _ = s.Write([]byte("\x1b[31maaaaaaaaaa\x1b[0m"))
	out := renderVT(s, 40, 2, 0)

	// Ten red 'a's is one styled run: one opener, not ten.
	if n := strings.Count(out, "\x1b[0m"); n > 2 {
		t.Errorf("style emitted %d times for one run — not coalesced:\n%q", n, out)
	}
}

func TestDefaultColorsDoNotOverrideTheTerminal(t *testing.T) {
	forceColor(t)

	s := vt.New(20, 2, 10)
	_, _ = s.Write([]byte("plain"))
	out := renderVT(s, 20, 2, 0)

	if strings.Contains(out, "\x1b[") {
		t.Errorf("unstyled text must emit no SGR (it would override the user's palette):\n%q", out)
	}
}

func TestReverseVideoSwapsColors(t *testing.T) {
	a := vt.Cell{Rune: 'x', Width: 1,
		FG:   vt.Color{Type: vt.ColorIndexed, Index: 1},
		BG:   vt.Color{Type: vt.ColorIndexed, Index: 2},
		Attr: vt.AttrReverse,
	}
	st := cellStyle(a)
	if st.GetForeground() != lipgloss.Color("2") || st.GetBackground() != lipgloss.Color("1") {
		t.Errorf("reverse did not swap fg/bg: fg=%v bg=%v", st.GetForeground(), st.GetBackground())
	}
}
