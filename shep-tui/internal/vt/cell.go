package vt

// Attr is a bitset of SGR text attributes.
type Attr uint16

const (
	AttrBold Attr = 1 << iota
	AttrDim
	AttrItalic
	AttrUnderline
	AttrBlink
	AttrReverse
	AttrHidden
	AttrStrike
)

// ColorType selects how a Color is interpreted.
type ColorType uint8

const (
	ColorDefault ColorType = iota
	ColorIndexed           // 0–255 ANSI/xterm palette
	ColorRGB               // truecolor
)

// Color is a terminal foreground or background color.
type Color struct {
	Type    ColorType
	Index   uint8 // ColorIndexed
	R, G, B uint8
}

// DefaultFG/DefaultBG are the terminal default colors.
var (
	DefaultFG = Color{Type: ColorDefault}
	DefaultBG = Color{Type: ColorDefault}
)

// Cell is one terminal grid cell.
//
// For wide (double-width) runes the leading cell holds the rune with Width==2
// and the following cell is a continuation (Rune==0, Width==0).
type Cell struct {
	Rune  rune
	Width int8 // 0 = continuation/empty spacer, 1 = normal, 2 = wide
	FG    Color
	BG    Color
	Attr  Attr
}

// EmptyCell is a blank cell with default colors.
func EmptyCell() Cell {
	return Cell{Rune: ' ', Width: 1, FG: DefaultFG, BG: DefaultBG}
}

// IsEmpty reports whether c is effectively blank (space or empty with default style).
func (c Cell) IsEmpty() bool {
	return (c.Rune == 0 || c.Rune == ' ') &&
		c.Attr == 0 &&
		c.FG.Type == ColorDefault &&
		c.BG.Type == ColorDefault
}

// RuneOrSpace returns the display rune, treating 0 as space.
func (c Cell) RuneOrSpace() rune {
	if c.Rune == 0 {
		return ' '
	}
	return c.Rune
}
