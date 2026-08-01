package vt

// scrollback is a ring of historical lines from the primary screen.
type scrollback struct {
	max   int
	lines [][]Cell // oldest at 0, newest at len-1
}

func newScrollback(max int) *scrollback {
	if max < 0 {
		max = 0
	}
	return &scrollback{max: max, lines: make([][]Cell, 0, min(max, 64))}
}

func (s *scrollback) cap() int { return s.max }

func (s *scrollback) len() int { return len(s.lines) }

// push appends lines (oldest first among the batch). Drops oldest when over max.
func (s *scrollback) push(rows ...[]Cell) {
	if s.max == 0 {
		return
	}
	for _, row := range rows {
		// Own a copy so buffer reuse cannot corrupt history.
		cp := make([]Cell, len(row))
		copy(cp, row)
		s.lines = append(s.lines, cp)
	}
	if over := len(s.lines) - s.max; over > 0 {
		// Avoid unbounded growth of underlying array: re-slice compactly.
		copy(s.lines, s.lines[over:])
		s.lines = s.lines[:s.max]
	}
}

// line returns the i-th oldest line (0 = oldest).
func (s *scrollback) line(i int) []Cell {
	if i < 0 || i >= len(s.lines) {
		return nil
	}
	return s.lines[i]
}

// clear empties scrollback history.
func (s *scrollback) clear() {
	s.lines = s.lines[:0]
}

// setMax changes capacity, trimming oldest lines if needed.
func (s *scrollback) setMax(max int) {
	if max < 0 {
		max = 0
	}
	s.max = max
	if max == 0 {
		s.lines = nil
		return
	}
	if len(s.lines) > max {
		drop := len(s.lines) - max
		copy(s.lines, s.lines[drop:])
		s.lines = s.lines[:max]
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
