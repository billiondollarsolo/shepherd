// Agent PTY colors: vt cells carry the SGR state the parser captured; this turns
// it back into styled terminal output.
package app

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"github.com/billiondollarsolo/shep-tui/internal/vt"
)

// renderCells renders one row of VT cells with its colors and attributes.
//
// Cells are grouped into runs of identical styling and each run is rendered once:
// a style per cell would allocate on every character of every PTY chunk, and the
// PTY is the hot path.
func renderCells(cells []vt.Cell, width int) string {
	if len(cells) == 0 {
		return ""
	}
	// Trailing blanks carry no ink, and keeping them would paint a background run
	// to the edge of the pane.
	end := len(cells)
	for end > 0 && cells[end-1].IsEmpty() {
		end--
	}
	cells = cells[:end]
	if len(cells) == 0 {
		return ""
	}

	var b strings.Builder
	var run strings.Builder
	var runStyle vt.Cell
	flush := func() {
		if run.Len() == 0 {
			return
		}
		b.WriteString(cellStyle(runStyle).Render(run.String()))
		run.Reset()
	}

	drawn := 0
	for i, c := range cells {
		w := int(c.Width)
		if w < 1 {
			w = 1
		}
		if drawn+w > width {
			break
		}
		if i == 0 || !sameStyle(c, runStyle) {
			flush()
			runStyle = c
		}
		run.WriteRune(c.RuneOrSpace())
		drawn += w
	}
	flush()
	return b.String()
}

// sameStyle reports whether two cells render with identical styling.
func sameStyle(a, b vt.Cell) bool {
	return a.FG == b.FG && a.BG == b.BG && a.Attr == b.Attr
}

// cellStyle maps a cell's SGR state onto a lipgloss style. Default colors are
// left unset so the user's own terminal palette shows through.
func cellStyle(c vt.Cell) lipgloss.Style {
	fg, bg := c.FG, c.BG
	if c.Attr&vt.AttrReverse != 0 {
		fg, bg = bg, fg
		// Reverse with default colors still has to swap something, or the run
		// renders as though it were never reversed.
		if fg.Type == vt.ColorDefault && bg.Type == vt.ColorDefault {
			fg = vt.Color{Type: vt.ColorIndexed, Index: 0}
			bg = vt.Color{Type: vt.ColorIndexed, Index: 7}
		}
	}
	if c.Attr&vt.AttrHidden != 0 {
		fg = bg
	}

	s := lipgloss.NewStyle()
	if col, ok := lipglossColor(fg); ok {
		s = s.Foreground(col)
	}
	if col, ok := lipglossColor(bg); ok {
		s = s.Background(col)
	}
	if c.Attr&vt.AttrBold != 0 {
		s = s.Bold(true)
	}
	if c.Attr&vt.AttrDim != 0 {
		s = s.Faint(true)
	}
	if c.Attr&vt.AttrItalic != 0 {
		s = s.Italic(true)
	}
	if c.Attr&vt.AttrUnderline != 0 {
		s = s.Underline(true)
	}
	if c.Attr&vt.AttrStrike != 0 {
		s = s.Strikethrough(true)
	}
	if c.Attr&vt.AttrBlink != 0 {
		s = s.Blink(true)
	}
	return s
}

// lipglossColor converts a vt color. A default color reports false: setting it
// explicitly would override the terminal's own foreground/background.
func lipglossColor(c vt.Color) (lipgloss.TerminalColor, bool) {
	switch c.Type {
	case vt.ColorIndexed:
		return lipgloss.Color(strconv.Itoa(int(c.Index))), true
	case vt.ColorRGB:
		return lipgloss.Color(fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B)), true
	default:
		return nil, false
	}
}
