// Package theme holds Flock dark / light / adaptive color tokens as lipgloss styles.
//
// Color mapping mirrors docs/PRODUCT.md §8.2 and flock/docs/design-tokens.md.
package theme

import (
	"os"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// Hex color tokens for Flock dark default (PRODUCT.md §8.2).
const (
	ColorAccent       = "#3b82f6"
	ColorAwaiting     = "#f59e0b"
	ColorIdle         = "#22c55e"
	ColorDone         = "#2dd4bf"
	ColorError        = "#ef4444"
	ColorDisconnected = "#6b7280"
	ColorStarting     = "#94a3b8" // design-tokens status.starting (dark)
	ColorInkPrimary   = "#e6e8eb"
	ColorInkMuted     = "#9aa3af"
	ColorSurface0     = "#0f1115"
	ColorSurface1     = "#171a21"
	ColorSurface2     = "#21262f"
	ColorDiffAdd      = "#0e2a16"
	ColorDiffRemove   = "#3a1414"
	ColorBorder       = "#2a303c" // dim panel edge on surface-0/1
)

// Light theme tokens (PRODUCT.md §8 / design-tokens light).
const (
	ColorLightAccent       = "#2563eb"
	ColorLightAwaiting     = "#d97706"
	ColorLightIdle         = "#16a34a"
	ColorLightDone         = "#0d9488"
	ColorLightError        = "#dc2626"
	ColorLightDisconnected = "#9aa3af"
	ColorLightStarting     = "#64748b"
	ColorLightInkPrimary   = "#1c2024"
	ColorLightInkMuted     = "#5b6470"
	ColorLightSurface0     = "#ffffff"
	ColorLightSurface1     = "#f5f6f8"
	ColorLightSurface2     = "#eaecf0"
	ColorLightDiffAdd      = "#e6f4ea"
	ColorLightDiffRemove   = "#fce8e6"
	ColorLightBorder       = "#d0d5dd"
)

// Names of the themes Named accepts, in toggle order.
const (
	NameAuto  = "auto"
	NameDark  = "flock-dark"
	NameLight = "flock-light"
)

// palette is one theme's raw tokens; every Theme is built from a pair of these
// (identical pairs for the fixed themes, light/dark pairs for the adaptive one).
type palette struct {
	accent, awaiting, idle, done, errC, disc, starting  string
	ink, muted, s0, s1, s2, diffAdd, diffRemove, border string
}

var darkPalette = palette{
	accent: ColorAccent, awaiting: ColorAwaiting, idle: ColorIdle, done: ColorDone,
	errC: ColorError, disc: ColorDisconnected, starting: ColorStarting,
	ink: ColorInkPrimary, muted: ColorInkMuted,
	s0: ColorSurface0, s1: ColorSurface1, s2: ColorSurface2,
	diffAdd: ColorDiffAdd, diffRemove: ColorDiffRemove, border: ColorBorder,
}

var lightPalette = palette{
	accent: ColorLightAccent, awaiting: ColorLightAwaiting, idle: ColorLightIdle, done: ColorLightDone,
	errC: ColorLightError, disc: ColorLightDisconnected, starting: ColorLightStarting,
	ink: ColorLightInkPrimary, muted: ColorLightInkMuted,
	s0: ColorLightSurface0, s1: ColorLightSurface1, s2: ColorLightSurface2,
	diffAdd: ColorLightDiffAdd, diffRemove: ColorLightDiffRemove, border: ColorLightBorder,
}

// Theme is a complete set of Flock UI colors and prebuilt lipgloss styles.
//
// The color fields are lipgloss.TerminalColor, not lipgloss.Color, so a theme
// can carry AdaptiveColor pairs that resolve against the terminal's background.
type Theme struct {
	// Name is the theme's config name ("auto" / "flock-dark" / "flock-light").
	Name string

	// Status / accent tokens
	Accent       lipgloss.TerminalColor
	Awaiting     lipgloss.TerminalColor
	Idle         lipgloss.TerminalColor
	Done         lipgloss.TerminalColor
	Error        lipgloss.TerminalColor
	Disconnected lipgloss.TerminalColor
	Starting     lipgloss.TerminalColor

	// Ink + surfaces
	InkPrimary lipgloss.TerminalColor
	InkMuted   lipgloss.TerminalColor
	Surface0   lipgloss.TerminalColor
	Surface1   lipgloss.TerminalColor
	Surface2   lipgloss.TerminalColor

	// BorderInk is the dim panel edge: an unfocused box's border color.
	BorderInk lipgloss.TerminalColor

	// Diff backgrounds
	DiffAdd    lipgloss.TerminalColor
	DiffRemove lipgloss.TerminalColor

	// Chrome styles
	Border      lipgloss.Style
	BorderFocus lipgloss.Style
	Title       lipgloss.Style
	Muted       lipgloss.Style
	Help        lipgloss.Style
	TitleBar    lipgloss.Style
	ErrorBox    lipgloss.Style
}

// DefaultDark returns the flock-dark theme (PRODUCT.md §8.2).
func DefaultDark() Theme {
	return buildTheme(NameDark, fixed(darkPalette))
}

// DefaultLight returns the flock-light theme.
func DefaultLight() Theme {
	return buildTheme(NameLight, fixed(lightPalette))
}

// Adaptive returns a theme whose every token is a light/dark pair resolved
// against the terminal's detected background. It is the default: a fixed dark
// theme is unreadable on a light terminal and vice versa.
func Adaptive() Theme {
	return buildTheme(NameAuto, func(pick func(palette) string) lipgloss.TerminalColor {
		return lipgloss.AdaptiveColor{Light: pick(lightPalette), Dark: pick(darkPalette)}
	})
}

// Mono is the NO_COLOR theme: shape and layout, no color at all.
func Mono() Theme {
	return buildTheme(NameAuto, func(func(palette) string) lipgloss.TerminalColor {
		return lipgloss.NoColor{}
	})
}

// NoColor reports whether the user asked for an uncolored terminal (NO_COLOR).
func NoColor() bool {
	return os.Getenv("NO_COLOR") != ""
}

// Named returns a theme by name. "auto"/"" is the adaptive theme; NO_COLOR wins
// over every name.
func Named(name string) Theme {
	if NoColor() {
		return Mono()
	}
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "light", NameLight:
		return DefaultLight()
	case "dark", NameDark:
		return DefaultDark()
	default:
		return Adaptive()
	}
}

// Next cycles a theme name for the toggle action: auto → dark → light → auto.
func Next(name string) string {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case NameAuto, "":
		return NameDark
	case "dark", NameDark:
		return NameLight
	default:
		return NameAuto
	}
}

// fixed builds a token picker that ignores the light/dark split.
func fixed(p palette) func(func(palette) string) lipgloss.TerminalColor {
	return func(pick func(palette) string) lipgloss.TerminalColor {
		return lipgloss.Color(pick(p))
	}
}

func buildTheme(name string, color func(func(palette) string) lipgloss.TerminalColor) Theme {
	a := color(func(p palette) string { return p.accent })
	inkC := color(func(p palette) string { return p.ink })
	mut := color(func(p palette) string { return p.muted })
	sf1 := color(func(p palette) string { return p.s1 })
	er := color(func(p palette) string { return p.errC })
	br := color(func(p palette) string { return p.border })

	return Theme{
		Name:         name,
		Accent:       a,
		Awaiting:     color(func(p palette) string { return p.awaiting }),
		Idle:         color(func(p palette) string { return p.idle }),
		Done:         color(func(p palette) string { return p.done }),
		Error:        er,
		Disconnected: color(func(p palette) string { return p.disc }),
		Starting:     color(func(p palette) string { return p.starting }),
		InkPrimary:   inkC,
		InkMuted:     mut,
		Surface0:     color(func(p palette) string { return p.s0 }),
		Surface1:     sf1,
		Surface2:     color(func(p palette) string { return p.s2 }),
		BorderInk:    br,
		DiffAdd:      color(func(p palette) string { return p.diffAdd }),
		DiffRemove:   color(func(p palette) string { return p.diffRemove }),

		Border: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(br),
		BorderFocus: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(a),
		Title: lipgloss.NewStyle().
			Foreground(inkC).
			Bold(true),
		Muted: lipgloss.NewStyle().
			Foreground(mut),
		Help: lipgloss.NewStyle().
			Foreground(mut).
			Padding(0, 1),
		TitleBar: lipgloss.NewStyle().
			Foreground(inkC).
			Background(sf1).
			Padding(0, 1),
		ErrorBox: lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(er).
			Foreground(inkC).
			Padding(1, 2),
	}
}

// OrDefault returns t, or the adaptive theme when t is the zero Theme (a Model
// built by a test literal rather than by newModel).
func (t Theme) OrDefault() Theme {
	if t.Accent == nil {
		return Named(NameAuto)
	}
	return t
}

// HuhTheme maps t onto the launch wizard's form theme, so the form is not a
// different color family (huh's catppuccin default) from the rest of the app.
func HuhTheme(t Theme) *huh.Theme {
	t = t.OrDefault()
	ht := huh.ThemeBase()

	f := &ht.Focused
	f.Base = f.Base.BorderForeground(t.Accent)
	f.Title = f.Title.Foreground(t.Accent).Bold(true)
	f.Description = f.Description.Foreground(t.InkMuted)
	f.ErrorIndicator = f.ErrorIndicator.Foreground(t.Error)
	f.ErrorMessage = f.ErrorMessage.Foreground(t.Error)
	f.SelectSelector = f.SelectSelector.Foreground(t.Accent)
	f.SelectedOption = f.SelectedOption.Foreground(t.Accent)
	f.UnselectedOption = f.UnselectedOption.Foreground(t.InkPrimary)
	f.FocusedButton = f.FocusedButton.Foreground(t.Surface0).Background(t.Accent)
	f.BlurredButton = f.BlurredButton.Foreground(t.InkPrimary).Background(t.Surface2)
	f.TextInput.Cursor = f.TextInput.Cursor.Foreground(t.Accent)
	f.TextInput.Prompt = f.TextInput.Prompt.Foreground(t.Accent)
	f.TextInput.Text = f.TextInput.Text.Foreground(t.InkPrimary)
	f.TextInput.Placeholder = f.TextInput.Placeholder.Foreground(t.InkMuted)

	b := &ht.Blurred
	b.Base = b.Base.BorderForeground(t.BorderInk)
	b.Title = b.Title.Foreground(t.InkMuted)
	b.Description = b.Description.Foreground(t.InkMuted)

	ht.Help.ShortKey = ht.Help.ShortKey.Foreground(t.Accent)
	ht.Help.ShortDesc = ht.Help.ShortDesc.Foreground(t.InkMuted)
	ht.Help.FullKey = ht.Help.FullKey.Foreground(t.Accent)
	ht.Help.FullDesc = ht.Help.FullDesc.Foreground(t.InkMuted)
	return ht
}

// StatusColor returns the token color for s (unknown → disconnected).
func (t Theme) StatusColor(s domain.Status) lipgloss.TerminalColor {
	switch s {
	case domain.StatusStarting:
		return t.Starting
	case domain.StatusRunning:
		return t.Accent
	case domain.StatusAwaitingInput:
		return t.Awaiting
	case domain.StatusIdle:
		return t.Idle
	case domain.StatusDone:
		return t.Done
	case domain.StatusError:
		return t.Error
	case domain.StatusDisconnected:
		return t.Disconnected
	default:
		if s == "" {
			return t.Idle
		}
		return t.Disconnected
	}
}

// StatusStyle is foreground styling for status labels / glyphs.
func (t Theme) StatusStyle(s domain.Status) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(t.StatusColor(s))
}

// StatusGlyph returns a colored ● for s (empty string never returned for known statuses).
func (t Theme) StatusGlyph(s domain.Status) string {
	return t.StatusStyle(s).Render("●")
}

// StatusLabel returns "● Label" with status color on the glyph and label.
func (t Theme) StatusLabel(s domain.Status) string {
	return t.StatusStyle(s).Render("● " + s.Label())
}
