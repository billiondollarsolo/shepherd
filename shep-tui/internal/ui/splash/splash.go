// Package splash renders the SHEP-TUI startup screen (ASCII art + credits).
package splash

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/ui/theme"
)

// Builders — keep in sync with flock apps/web BuiltBy.tsx.
const (
	HandleMJ  = "mjtechguy"
	HandleBln = "blndollarsolo"
	URLMJ     = "https://x.com/mjtechguy"
	URLBln    = "https://x.com/blndollarsolo"
	Tagline   = "Shepherd Your Agents"
	Product   = "SHEP-TUI"
)

// TitleArt is the always-on product wordmark (must contain "SHEP-TUI").
// Block letters spell SHEP-TUI (not a leftover FLOCK glyph).
const TitleArt = `
 ███████╗██╗  ██╗███████╗██████╗     ████████╗██╗   ██╗██╗
 ██╔════╝██║  ██║██╔════╝██╔══██╗    ╚══██╔══╝██║   ██║██║
 ███████╗███████║█████╗  ██████╔╝       ██║   ██║   ██║██║
 ╚════██║██╔══██║██╔══╝  ██╔═══╝        ██║   ██║   ██║██║
 ███████║██║  ██║███████╗██║            ██║   ╚██████╔╝██║
 ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝            ╚═╝    ╚═════╝ ╚═╝
`

// SheepSafe is sheep ASCII (no raw backticks — they break Go raw strings).
const SheepSafe = `
       __  _
    .-'  '  '-._  __  _
   (_,         .-'  '  '-._
 ,'o"(        (_,           )
(__,-'      ,'o"(            )>
   (       (__,-'            )
    '-'._.--._(             )
       |||  |||'-'._.--._.-'
                 |||  |||
            ~  the paddock  ~
`

// Content is the pure splash model (testable without Bubble Tea).
type Content struct {
	Version string
	Profile string
}

// Lines returns plain (uncolored) splash lines for tests / NO_COLOR.
func (c Content) Lines() []string {
	var out []string
	out = append(out, strings.Split(strings.Trim(TitleArt, "\n"), "\n")...)
	out = append(out, strings.Split(strings.Trim(SheepSafe, "\n"), "\n")...)
	out = append(out, "")
	out = append(out, Product+"  ·  "+Tagline)
	out = append(out, "paddock  ·  pens  ·  nodes  ·  agents")
	if c.Version != "" {
		out = append(out, "v"+strings.TrimPrefix(c.Version, "v"))
	}
	if c.Profile != "" {
		out = append(out, "profile: "+c.Profile)
	}
	out = append(out, "")
	out = append(out, "Built by  @"+HandleMJ+"  ·  @"+HandleBln)
	out = append(out, URLMJ)
	out = append(out, URLBln)
	out = append(out, "")
	out = append(out, "press any key to enter the paddock  ·  q to quit")
	return out
}

// Render paints a splash for the given terminal size in theme th.
// Content is top-centered when short; top-aligned when tall so art is never clipped away.
func Render(c Content, th theme.Theme, width, height int) string {
	if width <= 0 {
		width = 80
	}
	if height <= 0 {
		height = 24
	}

	th = th.OrDefault()
	accent := th.Accent
	muted := th.InkMuted
	ink := th.InkPrimary
	artStyle := lipgloss.NewStyle().Foreground(accent).Bold(true)
	sheepStyle := lipgloss.NewStyle().Foreground(ink)
	titleStyle := lipgloss.NewStyle().Foreground(accent).Bold(true)
	mutedStyle := lipgloss.NewStyle().Foreground(muted)
	linkStyle := lipgloss.NewStyle().Foreground(accent).Underline(true)

	// On very narrow terminals, show compact title instead of full block letters.
	titleBlock := strings.Trim(TitleArt, "\n")
	if width < 70 {
		titleBlock = "  SHEP-TUI"
	}
	sheepBlock := strings.Trim(SheepSafe, "\n")
	if height < 22 {
		// Compact sheep for short terminals — still recognizable.
		sheepBlock = "  ,-.___,-.\n  \\_/_ _\\_/\n    )O_O(\n   { (_) }\n    `-'-'\n ~ the paddock ~"
	}

	var body []string
	body = append(body, artStyle.Render(titleBlock))
	body = append(body, sheepStyle.Render(sheepBlock))
	body = append(body, "")
	body = append(body, titleStyle.Render(Product+"  ·  "+Tagline))
	body = append(body, mutedStyle.Render("paddock  ·  pens  ·  nodes  ·  agents"))
	meta := ""
	if c.Version != "" {
		meta = "v" + strings.TrimPrefix(c.Version, "v")
	}
	if c.Profile != "" {
		if meta != "" {
			meta += "  ·  "
		}
		meta += "profile " + c.Profile
	}
	if meta != "" {
		body = append(body, mutedStyle.Render(meta))
	}
	body = append(body, "")
	body = append(body, mutedStyle.Render("Built by"))
	body = append(body, fmt.Sprintf("%s  ·  %s",
		linkStyle.Render("@"+HandleMJ),
		linkStyle.Render("@"+HandleBln),
	))
	body = append(body, linkStyle.Render(URLMJ))
	body = append(body, linkStyle.Render(URLBln))
	body = append(body, "")
	body = append(body, mutedStyle.Render("press any key to enter the paddock  ·  q to quit"))

	inner := strings.Join(body, "\n")
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(accent).
		Padding(0, 2)
	framed := box.Render(inner)

	// Prefer top-center so tall art is not vertically clipped to emptiness.
	// If framed height exceeds terminal, return framed as-is (scrollable feel).
	fh := lipgloss.Height(framed)
	if fh >= height {
		return framed
	}
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, framed)
}
