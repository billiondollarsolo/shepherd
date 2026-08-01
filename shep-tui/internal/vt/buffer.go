package vt

// buffer is a rectangular cell grid of fixed cols×rows.
type buffer struct {
	cols, rows int
	cells      []Cell // row-major: cells[y*cols+x]
}

func newBuffer(cols, rows int) *buffer {
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}
	b := &buffer{cols: cols, rows: rows, cells: make([]Cell, cols*rows)}
	b.clearAll()
	return b
}

func (b *buffer) idx(x, y int) int { return y*b.cols + x }

func (b *buffer) inBounds(x, y int) bool {
	return x >= 0 && y >= 0 && x < b.cols && y < b.rows
}

func (b *buffer) get(x, y int) Cell {
	if !b.inBounds(x, y) {
		return EmptyCell()
	}
	return b.cells[b.idx(x, y)]
}

func (b *buffer) set(x, y int, c Cell) {
	if !b.inBounds(x, y) {
		return
	}
	b.cells[b.idx(x, y)] = c
}

func (b *buffer) clearAll() {
	empty := EmptyCell()
	for i := range b.cells {
		b.cells[i] = empty
	}
}

func (b *buffer) clearRect(x0, y0, x1, y1 int, style Cell) {
	// Inclusive rectangle, clamped.
	if x0 < 0 {
		x0 = 0
	}
	if y0 < 0 {
		y0 = 0
	}
	if x1 >= b.cols {
		x1 = b.cols - 1
	}
	if y1 >= b.rows {
		y1 = b.rows - 1
	}
	blank := EmptyCell()
	blank.FG = style.FG
	blank.BG = style.BG
	blank.Attr = style.Attr
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			b.cells[b.idx(x, y)] = blank
		}
	}
}

// scrollUp moves lines [top,bottom] up by n, inserting blank lines at bottom.
// Returns the lines that scrolled off the top (length n, each of length cols).
func (b *buffer) scrollUp(top, bottom, n int, style Cell) [][]Cell {
	if n <= 0 || top > bottom {
		return nil
	}
	height := bottom - top + 1
	if n > height {
		n = height
	}
	// Capture scrolled-off rows.
	off := make([][]Cell, n)
	for i := 0; i < n; i++ {
		row := make([]Cell, b.cols)
		copy(row, b.cells[b.idx(0, top+i):b.idx(0, top+i)+b.cols])
		off[i] = row
	}
	// Shift remaining rows up.
	for y := top; y <= bottom-n; y++ {
		src := b.idx(0, y+n)
		dst := b.idx(0, y)
		copy(b.cells[dst:dst+b.cols], b.cells[src:src+b.cols])
	}
	// Blank new lines at bottom of region.
	blank := EmptyCell()
	blank.FG = style.FG
	blank.BG = style.BG
	blank.Attr = style.Attr
	for y := bottom - n + 1; y <= bottom; y++ {
		for x := 0; x < b.cols; x++ {
			b.cells[b.idx(x, y)] = blank
		}
	}
	return off
}

// scrollDown moves lines [top,bottom] down by n, inserting blank lines at top.
func (b *buffer) scrollDown(top, bottom, n int, style Cell) {
	if n <= 0 || top > bottom {
		return
	}
	height := bottom - top + 1
	if n > height {
		n = height
	}
	for y := bottom; y >= top+n; y-- {
		src := b.idx(0, y-n)
		dst := b.idx(0, y)
		copy(b.cells[dst:dst+b.cols], b.cells[src:src+b.cols])
	}
	blank := EmptyCell()
	blank.FG = style.FG
	blank.BG = style.BG
	blank.Attr = style.Attr
	for y := top; y < top+n; y++ {
		for x := 0; x < b.cols; x++ {
			b.cells[b.idx(x, y)] = blank
		}
	}
}

// resize keeps content top-left aligned; new cells are blank.
func (b *buffer) resize(cols, rows int) {
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}
	if cols == b.cols && rows == b.rows {
		return
	}
	nb := make([]Cell, cols*rows)
	empty := EmptyCell()
	for i := range nb {
		nb[i] = empty
	}
	copyRows := b.rows
	if rows < copyRows {
		copyRows = rows
	}
	copyCols := b.cols
	if cols < copyCols {
		copyCols = cols
	}
	for y := 0; y < copyRows; y++ {
		copy(nb[y*cols:y*cols+copyCols], b.cells[y*b.cols:y*b.cols+copyCols])
	}
	b.cols = cols
	b.rows = rows
	b.cells = nb
}

// rowString returns the printable text of row y (continuation cells skipped).
func (b *buffer) rowString(y int) string {
	if y < 0 || y >= b.rows {
		return ""
	}
	runes := make([]rune, 0, b.cols)
	for x := 0; x < b.cols; x++ {
		c := b.cells[b.idx(x, y)]
		if c.Width == 0 && c.Rune == 0 {
			// Wide-char continuation: skip.
			continue
		}
		runes = append(runes, c.RuneOrSpace())
	}
	// Trim trailing spaces for cleaner test output? Keep full width for fidelity.
	return string(runes)
}

// clone deep-copies the buffer.
func (b *buffer) clone() *buffer {
	nb := &buffer{
		cols:  b.cols,
		rows:  b.rows,
		cells: make([]Cell, len(b.cells)),
	}
	copy(nb.cells, b.cells)
	return nb
}
