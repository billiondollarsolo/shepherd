// Package pen provides pure geometry math for pen multi-pane layouts.
//
// These functions are UI-framework-agnostic: they map a pen layout preset and
// pane count onto pixel/cell rectangles within a host area. Callers (Bubble
// Tea views, tests) own drawing and focus.
package pen

import (
	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

// Rect is an axis-aligned rectangle in cell/pixel coordinates.
// X,Y is the top-left origin; W,H are inclusive extents (width/height).
type Rect struct {
	X, Y, W, H int
}

// Empty reports whether r has zero or negative area.
func (r Rect) Empty() bool {
	return r.W <= 0 || r.H <= 0
}

// Area returns W*H, or 0 for empty/negative rects.
func (r Rect) Area() int {
	if r.Empty() {
		return 0
	}
	return r.W * r.H
}

// Contains reports whether (px,py) is inside the half-open range
// [X, X+W) × [Y, Y+H). Empty rects contain nothing.
func (r Rect) Contains(px, py int) bool {
	if r.Empty() {
		return false
	}
	return px >= r.X && px < r.X+r.W && py >= r.Y && py < r.Y+r.H
}

// Layout partitions area into n pane rectangles for the given pen layout preset.
//
// n is the number of panes (sessions) to place. Values outside [1, MaxPenSessions]
// yield nil. Zero or negative area yields nil (safe for degenerate terminals).
//
// Returned slices always have length n on success. Rects tile area with no gaps
// and no overlaps: leftover pixels from integer division are distributed to the
// first panes along each split axis.
//
// Layout presets:
//   - cols: equal-width vertical strips (left → right)
//   - rows: equal-height horizontal strips (top → bottom)
//   - grid2x2: 2×2 box, row-major fill:
//     n=1 full; n=2 top row side-by-side; n=3 top pair + bottom full-width; n=4 true 2×2
//   - main+stack: large main pane + stacked remainder
//     (main left / stack right when area is wider than tall; main top otherwise)
//
// Unknown layout values yield nil.
func Layout(layout domain.PenLayout, n int, area Rect) []Rect {
	if n < 1 || n > domain.MaxPenSessions || area.Empty() {
		return nil
	}
	switch layout {
	case domain.PenLayoutCols:
		return splitAxis(area, n, true)
	case domain.PenLayoutRows:
		return splitAxis(area, n, false)
	case domain.PenLayoutGrid2x2:
		return layoutGrid2x2(n, area)
	case domain.PenLayoutMainStack:
		return layoutMainStack(n, area)
	default:
		return nil
	}
}

// splitAxis divides area into n equal strips.
// vertical=true → columns (vary X/W); false → rows (vary Y/H).
func splitAxis(area Rect, n int, vertical bool) []Rect {
	out := make([]Rect, n)
	if vertical {
		sizes := distribute(area.W, n)
		x := area.X
		for i, w := range sizes {
			out[i] = Rect{X: x, Y: area.Y, W: w, H: area.H}
			x += w
		}
		return out
	}
	sizes := distribute(area.H, n)
	y := area.Y
	for i, h := range sizes {
		out[i] = Rect{X: area.X, Y: y, W: area.W, H: h}
		y += h
	}
	return out
}

// layoutGrid2x2 mirrors web flock grid2x2SessionLayout geometry:
//
//	[ 0 | 1 ]
//	[ 2 | 3 ]
//
// n=1 full; n=2 one row; n=3 top pair + bottom full width; n=4 true 2×2.
func layoutGrid2x2(n int, area Rect) []Rect {
	switch n {
	case 1:
		return []Rect{area}
	case 2:
		return splitAxis(area, 2, true)
	case 3:
		// Top half: two columns; bottom half: full-width third pane.
		rows := splitAxis(area, 2, false)
		top := splitAxis(rows[0], 2, true)
		return []Rect{top[0], top[1], rows[1]}
	case 4:
		rows := splitAxis(area, 2, false)
		top := splitAxis(rows[0], 2, true)
		bot := splitAxis(rows[1], 2, true)
		return []Rect{top[0], top[1], bot[0], bot[1]}
	default:
		return nil
	}
}

// MainFraction is the share of the primary axis given to the main pane in
// main+stack layouts when n > 1. The stack receives the remainder.
// 2/3 matches the "large main" pen preset.
const MainFractionNum = 2
const MainFractionDen = 3

// layoutMainStack places pane 0 as the large main and panes 1..n-1 stacked
// along the secondary axis. Orientation follows aspect ratio: wider-or-square
// areas put main on the left; taller areas put main on top.
func layoutMainStack(n int, area Rect) []Rect {
	if n == 1 {
		return []Rect{area}
	}

	mainLeft := area.W >= area.H
	if mainLeft {
		mainW := mainSize(area.W)
		// Guard against pathological thin areas.
		if mainW >= area.W {
			mainW = area.W - 1
		}
		if mainW < 1 {
			mainW = 1
		}
		stackW := area.W - mainW
		main := Rect{X: area.X, Y: area.Y, W: mainW, H: area.H}
		stackArea := Rect{X: area.X + mainW, Y: area.Y, W: stackW, H: area.H}
		stack := splitAxis(stackArea, n-1, false)
		out := make([]Rect, n)
		out[0] = main
		copy(out[1:], stack)
		return out
	}

	mainH := mainSize(area.H)
	if mainH >= area.H {
		mainH = area.H - 1
	}
	if mainH < 1 {
		mainH = 1
	}
	stackH := area.H - mainH
	main := Rect{X: area.X, Y: area.Y, W: area.W, H: mainH}
	stackArea := Rect{X: area.X, Y: area.Y + mainH, W: area.W, H: stackH}
	stack := splitAxis(stackArea, n-1, true)
	out := make([]Rect, n)
	out[0] = main
	copy(out[1:], stack)
	return out
}

// mainSize returns floor(total * MainFraction) but at least 1 and less than total
// when total > 1, so the stack always gets a non-zero strip when possible.
func mainSize(total int) int {
	if total <= 1 {
		return total
	}
	s := total * MainFractionNum / MainFractionDen
	if s < 1 {
		s = 1
	}
	if s >= total {
		s = total - 1
	}
	return s
}

// distribute splits length into n positive-biased integer sizes that sum to length.
// Leftover pixels (length % n) go to the first remainder panes (standard tiling).
// If length < n, some sizes may be 0 so callers still get n rects that cover the span.
func distribute(length, n int) []int {
	if n <= 0 {
		return nil
	}
	out := make([]int, n)
	if length <= 0 {
		return out
	}
	base := length / n
	rem := length % n
	for i := 0; i < n; i++ {
		out[i] = base
		if i < rem {
			out[i]++
		}
	}
	return out
}
