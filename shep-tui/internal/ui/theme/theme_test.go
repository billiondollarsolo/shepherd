package theme

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// hex unwraps a fixed theme's token. Theme colors are lipgloss.TerminalColor so
// the adaptive theme can carry light/dark pairs.
func hex(t *testing.T, c lipgloss.TerminalColor) string {
	t.Helper()
	col, ok := c.(lipgloss.Color)
	if !ok {
		t.Fatalf("token %#v is not a fixed color", c)
	}
	return string(col)
}

func TestDefaultDarkStatusGlyphNonEmpty(t *testing.T) {
	th := DefaultDark()
	for _, s := range domain.StatusValues {
		g := th.StatusGlyph(s)
		if g == "" {
			t.Fatalf("%s: StatusGlyph empty", s)
		}
		// Glyph must contain the bullet (ANSI wrapping allowed).
		if !strings.Contains(g, "●") {
			t.Fatalf("%s: StatusGlyph %q missing ●", s, g)
		}
	}
	// Empty status defaults to idle color path; still non-empty.
	if g := th.StatusGlyph(""); g == "" || !strings.Contains(g, "●") {
		t.Fatalf("empty status glyph = %q", g)
	}
}

func TestStatusColorMapping(t *testing.T) {
	th := DefaultDark()
	cases := map[domain.Status]string{
		domain.StatusRunning:       ColorAccent,
		domain.StatusAwaitingInput: ColorAwaiting,
		domain.StatusIdle:          ColorIdle,
		domain.StatusDone:          ColorDone,
		domain.StatusError:         ColorError,
		domain.StatusDisconnected:  ColorDisconnected,
		domain.StatusStarting:      ColorStarting,
	}
	for s, want := range cases {
		got := hex(t, th.StatusColor(s))
		if got != want {
			t.Fatalf("%s color = %q, want %q", s, got, want)
		}
	}
}

func TestDefaultDarkSurfacesAndInk(t *testing.T) {
	th := DefaultDark()
	if hex(t, th.Accent) != ColorAccent {
		t.Fatalf("accent = %v", th.Accent)
	}
	if hex(t, th.InkPrimary) != ColorInkPrimary {
		t.Fatalf("ink primary = %v", th.InkPrimary)
	}
	if hex(t, th.InkMuted) != ColorInkMuted {
		t.Fatalf("ink muted = %v", th.InkMuted)
	}
	if hex(t, th.Surface0) != ColorSurface0 || hex(t, th.Surface1) != ColorSurface1 || hex(t, th.Surface2) != ColorSurface2 {
		t.Fatalf("surfaces = %v/%v/%v", th.Surface0, th.Surface1, th.Surface2)
	}
}

func TestStatusLabelUsesAffirmativeWords(t *testing.T) {
	th := DefaultDark()
	label := th.StatusLabel(domain.StatusRunning)
	if !strings.Contains(label, "Working") {
		t.Fatalf("running label = %q, want Working", label)
	}
	if !strings.Contains(th.StatusLabel(domain.StatusAwaitingInput), "Needs you") {
		t.Fatal("awaiting must say Needs you")
	}
}

func TestStylesNonZero(t *testing.T) {
	th := DefaultDark()
	// Smoke: styles render without panic.
	_ = th.Title.Render("title")
	_ = th.Muted.Render("muted")
	_ = th.Help.Render("help")
	_ = th.TitleBar.Width(40).Render("bar")
	_ = th.Border.Render("x")
	_ = th.BorderFocus.Render("x")
	_ = th.ErrorBox.Render("err")
	_ = th.StatusStyle(domain.StatusError).Render("Error")
}

func TestNamedResolvesAllThemes(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	cases := map[string]string{
		"":            NameAuto,
		"auto":        NameAuto,
		"flock-dark":  NameDark,
		"dark":        NameDark,
		"flock-light": NameLight,
		"light":       NameLight,
		"nonsense":    NameAuto,
	}
	for name, want := range cases {
		if got := Named(name).Name; got != want {
			t.Fatalf("Named(%q).Name = %q, want %q", name, got, want)
		}
	}
	if hex(t, Named("flock-light").Accent) != ColorLightAccent {
		t.Fatal("flock-light must use the light accent")
	}
}

func TestAdaptiveCarriesBothPalettes(t *testing.T) {
	th := Adaptive()
	ac, ok := th.Accent.(lipgloss.AdaptiveColor)
	if !ok {
		t.Fatalf("adaptive accent = %#v", th.Accent)
	}
	if ac.Light != ColorLightAccent || ac.Dark != ColorAccent {
		t.Fatalf("accent pair = %+v", ac)
	}
}

func TestNoColorWins(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	if _, ok := Named(NameDark).Accent.(lipgloss.NoColor); !ok {
		t.Fatal("NO_COLOR must strip theme colors")
	}
}

func TestNextCyclesThemes(t *testing.T) {
	if got := Next(NameAuto); got != NameDark {
		t.Fatalf("auto → %q", got)
	}
	if got := Next(NameDark); got != NameLight {
		t.Fatalf("dark → %q", got)
	}
	if got := Next(NameLight); got != NameAuto {
		t.Fatalf("light → %q", got)
	}
}

func TestOrDefaultFillsZeroTheme(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	var zero Theme
	if zero.OrDefault().Name != NameAuto {
		t.Fatal("zero theme must fall back to the adaptive theme")
	}
}

func TestHuhThemeUsesFlockAccent(t *testing.T) {
	ht := HuhTheme(DefaultLight())
	if ht == nil {
		t.Fatal("nil huh theme")
	}
	if ht.Focused.Title.GetForeground() != DefaultLight().Accent {
		t.Fatal("launch form title must use the flock accent, not huh's own palette")
	}
}
