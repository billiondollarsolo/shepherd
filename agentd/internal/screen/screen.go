// Package screen maintains a minimal per-session terminal model for
// screen-manifest agent detection (master improvement plan D1–D2).
// It tracks a line buffer (or last N rows), OSC 0/2 title, OSC progress,
// and alternate-screen state. It is intentionally not a full xterm emulator.
package screen

import (
	"bytes"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// Default rows retained for detection bottom-buffer snapshots.
const DefaultRows = 40

// Model is a concurrent-safe minimal VT screen for detection snapshots.
type Model struct {
	mu sync.Mutex

	cols, rows int
	// lines holds the current screen rows (primary or alt).
	lines [][]rune
	// scroll holds lines that scrolled off the top (bounded).
	scroll []string
	maxScroll int

	cursorRow, cursorCol int
	altScreen            bool
	// Saved primary buffer when entering alt screen.
	primaryLines [][]rune
	primaryScroll []string
	primaryCR, primaryCC int

	oscTitle    string
	oscProgress string
	revision    uint64

	// partial CSI / OSC parsers
	inEsc  bool
	inCSI  bool
	inOSC  bool
	oscBuf strings.Builder
	csiBuf strings.Builder
}

// New creates a model with the given size (defaults 80x24 if zero).
func New(cols, rows int) *Model {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	m := &Model{cols: cols, rows: rows, maxScroll: 200}
	m.resetLines()
	return m
}

func (m *Model) resetLines() {
	m.lines = make([][]rune, m.rows)
	for i := range m.lines {
		m.lines[i] = make([]rune, 0, m.cols)
	}
	m.cursorRow, m.cursorCol = 0, 0
}

// Resize updates geometry; content is best-effort preserved for bottom rows.
func (m *Model) Resize(cols, rows int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	if cols == m.cols && rows == m.rows {
		return
	}
	// Snapshot text and re-feed naively.
	text := m.textLocked()
	m.cols, m.rows = cols, rows
	m.resetLines()
	m.scroll = nil
	m.cursorRow, m.cursorCol = 0, 0
	m.writePlainLocked([]byte(text))
	m.revision++
}

// Write feeds raw PTY bytes into the model.
func (m *Model) Write(p []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writeBytesLocked(p)
	m.revision++
}

// Snapshot is the detection-oriented view of the live screen.
type Snapshot struct {
	Text        string
	OSCTitle    string
	OSCProgress string
	AltScreen   bool
	Cols        int
	Rows        int
	Revision    uint64
}

// Snapshot returns a copy of the current detection view.
func (m *Model) Snapshot() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return Snapshot{
		Text:        m.textLocked(),
		OSCTitle:    m.oscTitle,
		OSCProgress: m.oscProgress,
		AltScreen:   m.altScreen,
		Cols:        m.cols,
		Rows:        m.rows,
		Revision:    m.revision,
	}
}

// BottomLines returns the last n non-empty-aware lines joined (all bottom rows).
func (m *Model) BottomLines(n int) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n <= 0 {
		n = m.rows
	}
	var out []string
	start := 0
	if len(m.lines) > n {
		start = len(m.lines) - n
	}
	for i := start; i < len(m.lines); i++ {
		out = append(out, string(m.lines[i]))
	}
	return strings.Join(out, "\n")
}

func (m *Model) textLocked() string {
	var b strings.Builder
	for i, line := range m.lines {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(string(line))
	}
	return b.String()
}

func (m *Model) writeBytesLocked(p []byte) {
	i := 0
	for i < len(p) {
		if m.inOSC {
			// OSC ends with BEL or ST (ESC \)
			if p[i] == 0x07 {
				m.finishOSCLocked()
				i++
				continue
			}
			if p[i] == 0x1b && i+1 < len(p) && p[i+1] == '\\' {
				m.finishOSCLocked()
				i += 2
				continue
			}
			m.oscBuf.WriteByte(p[i])
			i++
			continue
		}
		if m.inCSI {
			c := p[i]
			m.csiBuf.WriteByte(c)
			i++
			if c >= 0x40 && c <= 0x7e {
				m.handleCSILocked(m.csiBuf.String())
				m.csiBuf.Reset()
				m.inCSI = false
			}
			continue
		}
		if m.inEsc {
			m.inEsc = false
			switch p[i] {
			case '[':
				m.inCSI = true
				m.csiBuf.Reset()
			case ']':
				m.inOSC = true
				m.oscBuf.Reset()
			case '7', '8', 'c', 'M', 'D', 'E', 'H':
				// ignore simple ESC sequences
			default:
				// ignore
			}
			i++
			continue
		}
		if p[i] == 0x1b {
			m.inEsc = true
			i++
			continue
		}
		// batch plain run
		j := i
		for j < len(p) && p[j] != 0x1b {
			j++
		}
		m.writePlainLocked(p[i:j])
		i = j
	}
}

func (m *Model) finishOSCLocked() {
	m.inOSC = false
	s := m.oscBuf.String()
	m.oscBuf.Reset()
	// OSC 0/2: set title — forms "0;title" or "2;title"
	if strings.HasPrefix(s, "0;") {
		m.oscTitle = s[2:]
		return
	}
	if strings.HasPrefix(s, "2;") {
		m.oscTitle = s[2:]
		return
	}
	// OSC 9;4 progress (ConEmu) — store raw
	if strings.HasPrefix(s, "9;") {
		m.oscProgress = s[2:]
		return
	}
}

func (m *Model) handleCSILocked(seq string) {
	if len(seq) == 0 {
		return
	}
	final := seq[len(seq)-1]
	params := seq[:len(seq)-1]
	switch final {
	case 'A': // CUU
		n := csiNum(params, 1)
		m.cursorRow -= n
		if m.cursorRow < 0 {
			m.cursorRow = 0
		}
	case 'B': // CUD
		n := csiNum(params, 1)
		m.cursorRow += n
		if m.cursorRow >= m.rows {
			m.cursorRow = m.rows - 1
		}
	case 'C': // CUF
		n := csiNum(params, 1)
		m.cursorCol += n
		if m.cursorCol >= m.cols {
			m.cursorCol = m.cols - 1
		}
	case 'D': // CUB
		n := csiNum(params, 1)
		m.cursorCol -= n
		if m.cursorCol < 0 {
			m.cursorCol = 0
		}
	case 'H', 'f': // CUP
		r, c := 1, 1
		if params != "" {
			parts := strings.Split(params, ";")
			if len(parts) >= 1 && parts[0] != "" {
				r, _ = strconv.Atoi(parts[0])
			}
			if len(parts) >= 2 && parts[1] != "" {
				c, _ = strconv.Atoi(parts[1])
			}
		}
		m.cursorRow = clamp(r-1, 0, m.rows-1)
		m.cursorCol = clamp(c-1, 0, m.cols-1)
	case 'J': // ED
		mode := csiNum(params, 0)
		switch mode {
		case 2, 3: // entire screen
			m.resetLines()
		case 0: // cursor to end
			for r := m.cursorRow; r < m.rows; r++ {
				if r == m.cursorRow {
					if m.cursorCol < len(m.lines[r]) {
						m.lines[r] = m.lines[r][:m.cursorCol]
					}
				} else {
					m.lines[r] = m.lines[r][:0]
				}
			}
		}
	case 'K': // EL
		mode := csiNum(params, 0)
		line := m.lines[m.cursorRow]
		switch mode {
		case 0:
			if m.cursorCol < len(line) {
				m.lines[m.cursorRow] = line[:m.cursorCol]
			}
		case 1:
			// clear to cursor — pad spaces
			for len(m.lines[m.cursorRow]) < m.cursorCol {
				m.lines[m.cursorRow] = append(m.lines[m.cursorRow], ' ')
			}
			for i := 0; i < m.cursorCol && i < len(m.lines[m.cursorRow]); i++ {
				m.lines[m.cursorRow][i] = ' '
			}
		case 2:
			m.lines[m.cursorRow] = m.lines[m.cursorRow][:0]
			m.cursorCol = 0
		}
	case 'm': // SGR — ignore styling for detection text
	case 'h': // SM — detect alt screen ?1049h / ?47h
		if strings.Contains(params, "?1049") || strings.Contains(params, "?47") || strings.Contains(params, "?1047") {
			if !m.altScreen {
				m.enterAltLocked()
			}
		}
	case 'l': // RM
		if strings.Contains(params, "?1049") || strings.Contains(params, "?47") || strings.Contains(params, "?1047") {
			if m.altScreen {
				m.leaveAltLocked()
			}
		}
	}
}

func (m *Model) enterAltLocked() {
	m.primaryLines = cloneLines(m.lines)
	m.primaryScroll = append([]string(nil), m.scroll...)
	m.primaryCR, m.primaryCC = m.cursorRow, m.cursorCol
	m.resetLines()
	m.scroll = nil
	m.altScreen = true
}

func (m *Model) leaveAltLocked() {
	if m.primaryLines != nil {
		m.lines = m.primaryLines
		m.scroll = m.primaryScroll
		m.cursorRow, m.cursorCol = m.primaryCR, m.primaryCC
	} else {
		m.resetLines()
	}
	m.primaryLines = nil
	m.primaryScroll = nil
	m.altScreen = false
}

func cloneLines(in [][]rune) [][]rune {
	out := make([][]rune, len(in))
	for i, l := range in {
		out[i] = append([]rune(nil), l...)
	}
	return out
}

func (m *Model) writePlainLocked(p []byte) {
	for len(p) > 0 {
		r, size := utf8.DecodeRune(p)
		if r == utf8.RuneError && size == 1 {
			// skip invalid
			p = p[1:]
			continue
		}
		p = p[size:]
		switch r {
		case '\r':
			m.cursorCol = 0
		case '\n':
			m.newlineLocked()
		case '\b':
			if m.cursorCol > 0 {
				m.cursorCol--
			}
		case '\t':
			m.cursorCol = (m.cursorCol + 8) / 8 * 8
			if m.cursorCol >= m.cols {
				m.newlineLocked()
			}
		default:
			if r < 32 {
				continue
			}
			// ensure line capacity
			line := m.lines[m.cursorRow]
			for len(line) <= m.cursorCol {
				line = append(line, ' ')
			}
			line[m.cursorCol] = r
			m.lines[m.cursorRow] = line
			m.cursorCol++
			if m.cursorCol >= m.cols {
				m.newlineLocked()
			}
		}
	}
}

func (m *Model) newlineLocked() {
	m.cursorCol = 0
	if m.cursorRow < m.rows-1 {
		m.cursorRow++
		return
	}
	// scroll up
	scrolled := string(m.lines[0])
	m.scroll = append(m.scroll, scrolled)
	if len(m.scroll) > m.maxScroll {
		m.scroll = m.scroll[len(m.scroll)-m.maxScroll:]
	}
	copy(m.lines[0:], m.lines[1:])
	m.lines[m.rows-1] = make([]rune, 0, m.cols)
}

func csiNum(params string, def int) int {
	if params == "" {
		return def
	}
	// take first number, strip ?
	params = strings.TrimPrefix(params, "?")
	if i := strings.IndexByte(params, ';'); i >= 0 {
		params = params[:i]
	}
	n, err := strconv.Atoi(params)
	if err != nil || n == 0 {
		return def
	}
	return n
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// StripANSI is a lightweight helper for tests/fixtures that are already mostly plain.
func StripANSI(s string) string {
	var b bytes.Buffer
	inEsc := false
	inCSI := false
	inOSC := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if inOSC {
			if c == 0x07 {
				inOSC = false
				continue
			}
			if c == 0x1b && i+1 < len(s) && s[i+1] == '\\' {
				inOSC = false
				i++
				continue
			}
			continue
		}
		if inCSI {
			if c >= 0x40 && c <= 0x7e {
				inCSI = false
			}
			continue
		}
		if inEsc {
			inEsc = false
			if c == '[' {
				inCSI = true
				continue
			}
			if c == ']' {
				inOSC = true
				continue
			}
			continue
		}
		if c == 0x1b {
			inEsc = true
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}
