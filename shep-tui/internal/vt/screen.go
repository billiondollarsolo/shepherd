package vt

import (
	"strings"
	"unicode/utf8"

	"github.com/mattn/go-runewidth"
)

// DefaultScrollback is the default primary-buffer history length.
const DefaultScrollback = 10000

// Screen is a minimal VT100/xterm-style terminal emulator suitable for
// multi-pane PTY rendering. It is not concurrency-safe; callers must serialize access.
type Screen struct {
	cols, rows int

	primary *buffer
	alt     *buffer
	active  *buffer // points at primary or alt
	altOn   bool
	scroll  *scrollback

	// Cursor (0-based).
	x, y int
	// Saved cursor (DECSC/DECRC) and origin.
	savedX, savedY int
	savedPen       Cell

	// Current pen (SGR attributes applied to newly written cells).
	pen Cell

	// Wrap: if true, next graphic char wraps before being written.
	// (DEC auto-wrap pending state after writing into last column.)
	wrapPending bool

	// Origin mode / scroll region (0-based inclusive).
	// top/bottom default to full screen.
	scrollTop    int
	scrollBottom int

	// Modes
	autoWrap bool // DECAWM, default true
	origin   bool // DECOM
	insert   bool // IRM

	// Parser state machine.
	p parser

	// Damage for optional repaint coalescing.
	Damage Damage

	// Title from OSC 0/2 (last set), empty if never set.
	Title string
}

// New creates a Screen with the given geometry and scrollback capacity.
// If scrollback < 0, DefaultScrollback is used. scrollback == 0 disables history.
func New(cols, rows, scrollback int) *Screen {
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}
	if scrollback < 0 {
		scrollback = DefaultScrollback
	}
	s := &Screen{
		cols:         cols,
		rows:         rows,
		primary:      newBuffer(cols, rows),
		alt:          newBuffer(cols, rows),
		scroll:       newScrollback(scrollback),
		pen:          EmptyCell(),
		autoWrap:     true,
		scrollTop:    0,
		scrollBottom: rows - 1,
	}
	s.active = s.primary
	return s
}

// Cols returns the current width.
func (s *Screen) Cols() int { return s.cols }

// Rows returns the current height.
func (s *Screen) Rows() int { return s.rows }

// Cursor returns the 0-based cursor position.
func (s *Screen) Cursor() (x, y int) { return s.x, s.y }

// AltScreen reports whether the alternate screen buffer is active.
func (s *Screen) AltScreen() bool { return s.altOn }

// ScrollbackLen returns how many history lines are stored.
func (s *Screen) ScrollbackLen() int { return s.scroll.len() }

// SetScrollback changes the history capacity, trimming the oldest lines when it
// shrinks. Used when the scrollback setting changes without a restart.
func (s *Screen) SetScrollback(n int) { s.scroll.setMax(n) }

// ScrollbackLine returns a copy of the i-th oldest scrollback line as a string.
func (s *Screen) ScrollbackLine(i int) string {
	row := s.scroll.line(i)
	if row == nil {
		return ""
	}
	runes := make([]rune, 0, len(row))
	for _, c := range row {
		if c.Width == 0 && c.Rune == 0 {
			continue
		}
		runes = append(runes, c.RuneOrSpace())
	}
	return string(runes)
}

// Resize changes the visible geometry. Content is preserved top-left aligned.
// Cursor is clamped. Scroll region resets to full screen.
func (s *Screen) Resize(cols, rows int) {
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}
	if cols == s.cols && rows == s.rows {
		return
	}
	s.primary.resize(cols, rows)
	s.alt.resize(cols, rows)
	s.cols = cols
	s.rows = rows
	s.scrollTop = 0
	s.scrollBottom = rows - 1
	s.clampCursor()
	s.wrapPending = false
	s.Damage.MarkAll()
}

// Write implements io.Writer: parse and apply PTY output bytes.
func (s *Screen) Write(p []byte) (int, error) {
	s.Parse(p)
	return len(p), nil
}

// Parse is an alias for Write without the io.Writer signature.
func (s *Screen) Parse(p []byte) {
	for i := 0; i < len(p); {
		b := p[i]
		switch s.p.state {
		case stateGround:
			n := s.groundByte(p[i:])
			i += n
		case stateEscape:
			s.escapeByte(b)
			i++
		case stateCSI:
			s.csiByte(b)
			i++
		case stateOSC:
			s.oscByte(b)
			i++
		case stateOSCEsc:
			if b == '\\' { // ST = ESC \
				s.handleOSC()
				s.p.state = stateGround
			} else {
				// Not ST; treat as ESC sequence start after partial OSC drop.
				s.p.resetOSC()
				s.p.state = stateEscape
				s.escapeByte(b)
			}
			i++
		case stateDCS:
			// Ignore DCS payload until ST (ESC \) or BEL.
			if b == 0x1b {
				s.p.state = stateDCSEsc
			} else if b == 0x07 {
				s.p.state = stateGround
			}
			i++
		case stateDCSEsc:
			if b == '\\' {
				s.p.state = stateGround
			} else {
				s.p.state = stateDCS
			}
			i++
		case stateCharset:
			// Consume one final byte of charset designation.
			s.p.state = stateGround
			i++
		default:
			s.p.state = stateGround
			i++
		}
	}
}

// CellAt returns the cell at 0-based (x,y) on the active screen.
func (s *Screen) CellAt(x, y int) Cell {
	return s.active.get(x, y)
}

// RowString returns the text content of row y (0-based), full width.
func (s *Screen) RowString(y int) string {
	return s.active.rowString(y)
}

// String returns the full screen as lines joined by '\n' (trailing spaces kept).
func (s *Screen) String() string {
	lines := make([]string, s.rows)
	for y := 0; y < s.rows; y++ {
		lines[y] = s.RowString(y)
	}
	return strings.Join(lines, "\n")
}

// TrimmedString is like String but strips trailing spaces per line (handy in tests).
func (s *Screen) TrimmedString() string {
	lines := make([]string, s.rows)
	for y := 0; y < s.rows; y++ {
		lines[y] = strings.TrimRight(s.RowString(y), " ")
	}
	// Trim trailing empty lines for compact comparison? Keep all rows.
	return strings.Join(lines, "\n")
}

// --- ground / controls -------------------------------------------------------

func (s *Screen) groundByte(rest []byte) int {
	b := rest[0]

	// C0 controls
	switch b {
	case 0x00: // NUL
		return 1
	case 0x07: // BEL
		return 1
	case 0x08: // BS
		s.backspace()
		return 1
	case 0x09: // HT
		s.tab()
		return 1
	case 0x0a: // LF
		s.lineFeed()
		return 1
	case 0x0b, 0x0c: // VT, FF treat as LF
		s.lineFeed()
		return 1
	case 0x0d: // CR
		s.carriageReturn()
		return 1
	case 0x0e, 0x0f: // SO/SI charset — ignore
		return 1
	case 0x1b: // ESC
		s.p.state = stateEscape
		return 1
	case 0x7f: // DEL
		return 1
	}

	// UTF-8 graphic
	if b < 0x20 {
		// Other C0: ignore
		return 1
	}

	r, size := utf8.DecodeRune(rest)
	if r == utf8.RuneError && size == 1 {
		// Invalid; skip byte.
		return 1
	}
	s.putRune(r)
	return size
}

func (s *Screen) escapeByte(b byte) {
	switch b {
	case '[':
		s.p.resetCSI()
		s.p.state = stateCSI
	case ']':
		s.p.resetOSC()
		s.p.state = stateOSC
	case 'P': // DCS
		s.p.state = stateDCS
	case '7': // DECSC
		s.saveCursor()
		s.p.state = stateGround
	case '8': // DECRC
		s.restoreCursor()
		s.p.state = stateGround
	case 'c': // RIS hard reset
		s.hardReset()
		s.p.state = stateGround
	case 'D': // IND index
		s.index()
		s.p.state = stateGround
	case 'E': // NEL
		s.carriageReturn()
		s.lineFeed()
		s.p.state = stateGround
	case 'M': // RI reverse index
		s.reverseIndex()
		s.p.state = stateGround
	case '(', ')', '*', '+', '-', '.', '/':
		// Charset designation — consume next final.
		s.p.state = stateCharset
	case '\\': // ST alone — ignore
		s.p.state = stateGround
	case '=': // DECKPAM — ignore
		s.p.state = stateGround
	case '>': // DECKPNM — ignore
		s.p.state = stateGround
	default:
		// Unknown ESC sequence: drop.
		s.p.state = stateGround
	}
}

func (s *Screen) csiByte(b byte) {
	// Collect limited raw body for debugging (unused currently).
	if len(s.p.csiBuf) < maxCSIBody {
		s.p.csiBuf = append(s.p.csiBuf, b)
	}

	switch {
	case b >= 0x30 && b <= 0x39: // digit
		s.p.pushDigit(b)
	case b == ';':
		s.p.nextParam()
	case b == '?':
		// Private parameter marker — only meaningful at start.
		if s.p.nParams == 0 && !s.p.hasDigit && s.p.priv == 0 {
			s.p.priv = b
		}
	case b == '<' || b == '=' || b == '>':
		if s.p.nParams == 0 && !s.p.hasDigit && s.p.priv == 0 {
			s.p.priv = b
		}
	case b >= 0x20 && b <= 0x2f: // intermediate
		s.p.intermed = b
	case b >= 0x40 && b <= 0x7e: // final
		s.p.finishParam()
		s.handleCSI(b)
		s.p.state = stateGround
	case b == 0x1b:
		// ESC aborts CSI and starts new escape.
		s.p.state = stateEscape
	default:
		// Cancel on unexpected C0 etc.
		if b < 0x20 {
			s.p.state = stateGround
			// Reprocess control? Drop for simplicity.
		}
	}
}

func (s *Screen) oscByte(b byte) {
	switch b {
	case 0x07: // BEL terminates OSC
		s.handleOSC()
		s.p.state = stateGround
	case 0x1b:
		s.p.state = stateOSCEsc
	default:
		if len(s.p.oscBuf) < maxOSC {
			s.p.oscBuf = append(s.p.oscBuf, b)
		}
	}
}

func (s *Screen) handleOSC() {
	// OSC Ps ; Pt  — support 0/2 title set.
	buf := s.p.oscBuf
	s.p.resetOSC()
	semi := -1
	for i, c := range buf {
		if c == ';' {
			semi = i
			break
		}
	}
	if semi < 0 {
		return
	}
	ps := string(buf[:semi])
	pt := string(buf[semi+1:])
	switch ps {
	case "0", "2":
		s.Title = pt
	}
}

// --- cursor / pen helpers ----------------------------------------------------

func (s *Screen) clampCursor() {
	if s.x < 0 {
		s.x = 0
	}
	if s.y < 0 {
		s.y = 0
	}
	if s.x >= s.cols {
		s.x = s.cols - 1
	}
	if s.y >= s.rows {
		s.y = s.rows - 1
	}
}

func (s *Screen) saveCursor() {
	s.savedX, s.savedY = s.x, s.y
	s.savedPen = s.pen
}

func (s *Screen) restoreCursor() {
	s.x, s.y = s.savedX, s.savedY
	s.pen = s.savedPen
	s.clampCursor()
	s.wrapPending = false
}

func (s *Screen) hardReset() {
	s.primary.clearAll()
	s.alt.clearAll()
	s.active = s.primary
	s.altOn = false
	s.x, s.y = 0, 0
	s.savedX, s.savedY = 0, 0
	s.pen = EmptyCell()
	s.savedPen = EmptyCell()
	s.wrapPending = false
	s.autoWrap = true
	s.origin = false
	s.insert = false
	s.scrollTop = 0
	s.scrollBottom = s.rows - 1
	s.scroll.clear()
	s.Title = ""
	s.p = parser{}
	s.Damage.MarkAll()
}

func (s *Screen) backspace() {
	s.wrapPending = false
	if s.x > 0 {
		s.x--
	}
}

func (s *Screen) tab() {
	s.wrapPending = false
	// Tab stops every 8 columns.
	next := ((s.x / 8) + 1) * 8
	if next >= s.cols {
		next = s.cols - 1
	}
	s.x = next
}

func (s *Screen) carriageReturn() {
	s.wrapPending = false
	s.x = 0
}

func (s *Screen) lineFeed() {
	s.wrapPending = false
	s.index()
}

func (s *Screen) index() {
	// Move down; scroll if at bottom of scroll region.
	if s.y == s.scrollBottom {
		s.scrollUp(1)
		return
	}
	if s.y < s.rows-1 {
		s.y++
	}
}

func (s *Screen) reverseIndex() {
	s.wrapPending = false
	if s.y == s.scrollTop {
		s.active.scrollDown(s.scrollTop, s.scrollBottom, 1, s.eraseStyle())
		s.Damage.MarkAll()
		return
	}
	if s.y > 0 {
		s.y--
	}
}

func (s *Screen) scrollUp(n int) {
	off := s.active.scrollUp(s.scrollTop, s.scrollBottom, n, s.eraseStyle())
	// Only primary full-screen region scroll feeds scrollback.
	if !s.altOn && s.scrollTop == 0 && s.scrollBottom == s.rows-1 {
		s.scroll.push(off...)
	}
	s.Damage.MarkAll()
}

func (s *Screen) eraseStyle() Cell {
	// ED/EL typically use current background; keep FG/BG from pen, clear attrs on blanks.
	c := EmptyCell()
	c.FG = s.pen.FG
	c.BG = s.pen.BG
	return c
}

func (s *Screen) putRune(r rune) {
	if r == 0 {
		return
	}
	w := runewidth.RuneWidth(r)
	if w <= 0 {
		// Non-spacing / zero-width: ignore for grid placement (combining not joined).
		return
	}
	if s.wrapPending && s.autoWrap {
		s.carriageReturn()
		s.lineFeed()
	}
	// Wide char that doesn't fit at end of line: wrap first.
	if w == 2 && s.x == s.cols-1 && s.autoWrap {
		s.carriageReturn()
		s.lineFeed()
	}
	if s.x >= s.cols {
		if s.autoWrap {
			s.x = 0
			s.lineFeed()
		} else {
			s.x = s.cols - 1
		}
	}

	// Clear any wide-char residue we're overwriting.
	s.clearCellForWrite(s.x, s.y)
	if w == 2 && s.x+1 < s.cols {
		s.clearCellForWrite(s.x+1, s.y)
	}

	cell := Cell{
		Rune:  r,
		Width: int8(w),
		FG:    s.pen.FG,
		BG:    s.pen.BG,
		Attr:  s.pen.Attr,
	}
	s.active.set(s.x, s.y, cell)
	s.Damage.Mark(s.x, s.y)

	if w == 2 {
		if s.x+1 < s.cols {
			cont := Cell{Rune: 0, Width: 0, FG: s.pen.FG, BG: s.pen.BG, Attr: s.pen.Attr}
			s.active.set(s.x+1, s.y, cont)
			s.Damage.Mark(s.x+1, s.y)
			s.x += 2
		} else {
			// No room for continuation; still advance.
			s.x++
		}
	} else {
		s.x++
	}

	if s.x >= s.cols {
		s.x = s.cols - 1
		s.wrapPending = s.autoWrap
	} else {
		s.wrapPending = false
	}
}

func (s *Screen) clearCellForWrite(x, y int) {
	c := s.active.get(x, y)
	// If this is a wide continuation, clear the lead cell too.
	if c.Width == 0 && x > 0 {
		prev := s.active.get(x-1, y)
		if prev.Width == 2 {
			s.active.set(x-1, y, s.eraseStyle())
			s.Damage.Mark(x-1, y)
		}
	}
	// If this is a wide lead, clear the continuation.
	if c.Width == 2 && x+1 < s.cols {
		s.active.set(x+1, y, s.eraseStyle())
		s.Damage.Mark(x+1, y)
	}
}

// --- CSI handlers ------------------------------------------------------------

func (s *Screen) handleCSI(final byte) {
	// Intermediate-aware (e.g. CSI " p) — ignore unknown.
	if s.p.intermed != 0 {
		// DECSTBM uses no intermediate; most of our supported set don't either.
		// Handle SM/RM private with '?' already in priv.
		return
	}

	switch final {
	case 'A': // CUU
		n := s.p.param(0, 1)
		s.moveCursorRel(0, -n)
	case 'B': // CUD
		n := s.p.param(0, 1)
		s.moveCursorRel(0, n)
	case 'C': // CUF
		n := s.p.param(0, 1)
		s.moveCursorRel(n, 0)
	case 'D': // CUB
		n := s.p.param(0, 1)
		s.moveCursorRel(-n, 0)
	case 'E': // CNL
		n := s.p.param(0, 1)
		s.wrapPending = false
		s.x = 0
		s.moveCursorRel(0, n)
	case 'F': // CPL
		n := s.p.param(0, 1)
		s.wrapPending = false
		s.x = 0
		s.moveCursorRel(0, -n)
	case 'G': // CHA
		n := s.p.param(0, 1)
		s.wrapPending = false
		s.x = n - 1
		s.clampCursor()
	case 'H', 'f': // CUP / HVP
		row := s.p.param(0, 1)
		col := s.p.param(1, 1)
		s.cup(row, col)
	case 'J': // ED
		s.eraseDisplay(s.p.paramRaw(0))
	case 'K': // EL
		s.eraseLine(s.p.paramRaw(0))
	case 'L': // IL insert lines
		n := s.p.param(0, 1)
		if s.y >= s.scrollTop && s.y <= s.scrollBottom {
			s.active.scrollDown(s.y, s.scrollBottom, n, s.eraseStyle())
			s.Damage.MarkAll()
		}
	case 'M': // DL delete lines
		n := s.p.param(0, 1)
		if s.y >= s.scrollTop && s.y <= s.scrollBottom {
			s.active.scrollUp(s.y, s.scrollBottom, n, s.eraseStyle())
			s.Damage.MarkAll()
		}
	case 'P': // DCH delete chars
		n := s.p.param(0, 1)
		s.deleteChars(n)
	case 'S': // SU scroll up
		n := s.p.param(0, 1)
		s.scrollUp(n)
	case 'T': // SD scroll down
		n := s.p.param(0, 1)
		s.active.scrollDown(s.scrollTop, s.scrollBottom, n, s.eraseStyle())
		s.Damage.MarkAll()
	case 'X': // ECH erase chars
		n := s.p.param(0, 1)
		s.eraseChars(n)
	case 'd': // VPA
		n := s.p.param(0, 1)
		s.wrapPending = false
		s.y = n - 1
		s.clampCursor()
	case 'm': // SGR
		s.handleSGR()
	case 'r': // DECSTBM
		if s.p.priv == 0 {
			top := s.p.param(0, 1)
			bot := s.p.param(1, s.rows)
			s.setScrollRegion(top, bot)
		}
	case 's': // save cursor (ANSI.SYS)
		if s.p.priv == 0 {
			s.saveCursor()
		}
	case 'u': // restore cursor (ANSI.SYS)
		if s.p.priv == 0 {
			s.restoreCursor()
		}
	case 'h': // SM
		s.setMode(true)
	case 'l': // RM
		s.setMode(false)
	case '@': // ICH insert blanks
		n := s.p.param(0, 1)
		s.insertChars(n)
	case 'n': // DSR — no response channel; ignore
	case 'c': // DA — ignore
	case 't': // window ops — ignore
	default:
		// Unsupported CSI: ignore.
	}
}

func (s *Screen) moveCursorRel(dx, dy int) {
	s.wrapPending = false
	s.x += dx
	s.y += dy
	// Clamp within screen (not scroll region for CUU/CUD unless origin mode —
	// we keep simple: clamp to full screen).
	s.clampCursor()
}

func (s *Screen) cup(row, col int) {
	s.wrapPending = false
	// 1-based input
	y := row - 1
	x := col - 1
	if s.origin {
		y += s.scrollTop
		if y > s.scrollBottom {
			y = s.scrollBottom
		}
	}
	s.x = x
	s.y = y
	s.clampCursor()
}

func (s *Screen) setScrollRegion(top1, bot1 int) {
	top := top1 - 1
	bot := bot1 - 1
	if top < 0 {
		top = 0
	}
	if bot >= s.rows {
		bot = s.rows - 1
	}
	if top >= bot {
		// Invalid — reset to full.
		top = 0
		bot = s.rows - 1
	}
	s.scrollTop = top
	s.scrollBottom = bot
	// Cursor home on set.
	s.x, s.y = 0, 0
	if s.origin {
		s.y = s.scrollTop
	}
	s.wrapPending = false
}

func (s *Screen) eraseDisplay(mode int) {
	style := s.eraseStyle()
	switch mode {
	case 0: // cursor to end of screen
		s.active.clearRect(s.x, s.y, s.cols-1, s.y, style)
		if s.y+1 <= s.rows-1 {
			s.active.clearRect(0, s.y+1, s.cols-1, s.rows-1, style)
		}
	case 1: // start to cursor
		if s.y-1 >= 0 {
			s.active.clearRect(0, 0, s.cols-1, s.y-1, style)
		}
		s.active.clearRect(0, s.y, s.x, s.y, style)
	case 2, 3: // entire screen (3 also clears scrollback in xterm)
		s.active.clearAll()
		if mode == 3 && !s.altOn {
			s.scroll.clear()
		}
	}
	s.Damage.MarkAll()
}

func (s *Screen) eraseLine(mode int) {
	style := s.eraseStyle()
	switch mode {
	case 0: // cursor to end of line
		s.active.clearRect(s.x, s.y, s.cols-1, s.y, style)
	case 1: // start to cursor
		s.active.clearRect(0, s.y, s.x, s.y, style)
	case 2: // entire line
		s.active.clearRect(0, s.y, s.cols-1, s.y, style)
	}
	s.Damage.MarkRect(0, s.y, s.cols-1, s.y)
}

func (s *Screen) eraseChars(n int) {
	if n < 1 {
		n = 1
	}
	style := s.eraseStyle()
	end := s.x + n - 1
	if end >= s.cols {
		end = s.cols - 1
	}
	s.active.clearRect(s.x, s.y, end, s.y, style)
	s.Damage.MarkRect(s.x, s.y, end, s.y)
}

func (s *Screen) deleteChars(n int) {
	if n < 1 {
		n = 1
	}
	// Shift left from x+n, blank tail.
	y := s.y
	for i := 0; i < s.cols-s.x-n; i++ {
		s.active.set(s.x+i, y, s.active.get(s.x+n+i, y))
	}
	style := s.eraseStyle()
	start := s.cols - n
	if start < s.x {
		start = s.x
	}
	for x := start; x < s.cols; x++ {
		s.active.set(x, y, style)
	}
	s.Damage.MarkRect(s.x, y, s.cols-1, y)
}

func (s *Screen) insertChars(n int) {
	if n < 1 {
		n = 1
	}
	y := s.y
	// Shift right.
	for x := s.cols - 1; x >= s.x+n; x-- {
		s.active.set(x, y, s.active.get(x-n, y))
	}
	style := s.eraseStyle()
	end := s.x + n - 1
	if end >= s.cols {
		end = s.cols - 1
	}
	for x := s.x; x <= end; x++ {
		s.active.set(x, y, style)
	}
	s.Damage.MarkRect(s.x, y, s.cols-1, y)
}

func (s *Screen) setMode(enable bool) {
	if s.p.priv == '?' {
		for i := 0; i < s.p.nParams || (s.p.nParams == 0 && i == 0); i++ {
			mode := s.p.paramRaw(i)
			if s.p.nParams == 0 {
				mode = 0
			}
			switch mode {
			case 7: // DECAWM
				s.autoWrap = enable
			case 6: // DECOM
				s.origin = enable
				s.x = 0
				if enable {
					s.y = s.scrollTop
				} else {
					s.y = 0
				}
				s.wrapPending = false
			case 25: // cursor visible — ignored (renderer concern)
			case 47, 1047: // alt screen buffer
				s.useAlt(enable)
			case 1048: // save/restore cursor
				if enable {
					s.saveCursor()
				} else {
					s.restoreCursor()
				}
			case 1049: // alt screen + save cursor + clear
				if enable {
					s.saveCursor()
					s.useAlt(true)
					s.alt.clearAll()
					s.x, s.y = 0, 0
					s.wrapPending = false
					s.Damage.MarkAll()
				} else {
					s.useAlt(false)
					s.restoreCursor()
					s.Damage.MarkAll()
				}
			}
		}
		return
	}
	// ANSI modes
	for i := 0; i < s.p.nParams || (s.p.nParams == 0 && i == 0); i++ {
		mode := s.p.paramRaw(i)
		switch mode {
		case 4: // IRM
			s.insert = enable
		}
	}
}

func (s *Screen) useAlt(on bool) {
	if on == s.altOn {
		return
	}
	s.altOn = on
	if on {
		s.active = s.alt
	} else {
		s.active = s.primary
	}
	s.wrapPending = false
	s.Damage.MarkAll()
}

func (s *Screen) handleSGR() {
	// Empty CSI m → reset
	if s.p.nParams == 0 {
		s.pen = EmptyCell()
		return
	}
	i := 0
	for i < s.p.nParams {
		p := s.p.paramRaw(i)
		i++
		switch {
		case p == 0:
			s.pen = EmptyCell()
		case p == 1:
			s.pen.Attr |= AttrBold
			s.pen.Attr &^= AttrDim
		case p == 2:
			s.pen.Attr |= AttrDim
		case p == 3:
			s.pen.Attr |= AttrItalic
		case p == 4:
			s.pen.Attr |= AttrUnderline
		case p == 5, p == 6:
			s.pen.Attr |= AttrBlink
		case p == 7:
			s.pen.Attr |= AttrReverse
		case p == 8:
			s.pen.Attr |= AttrHidden
		case p == 9:
			s.pen.Attr |= AttrStrike
		case p == 22:
			s.pen.Attr &^= AttrBold | AttrDim
		case p == 23:
			s.pen.Attr &^= AttrItalic
		case p == 24:
			s.pen.Attr &^= AttrUnderline
		case p == 25:
			s.pen.Attr &^= AttrBlink
		case p == 27:
			s.pen.Attr &^= AttrReverse
		case p == 28:
			s.pen.Attr &^= AttrHidden
		case p == 29:
			s.pen.Attr &^= AttrStrike
		case p >= 30 && p <= 37:
			s.pen.FG = Color{Type: ColorIndexed, Index: uint8(p - 30)}
		case p == 38:
			i = s.parseExtColor(i, true)
		case p == 39:
			s.pen.FG = DefaultFG
		case p >= 40 && p <= 47:
			s.pen.BG = Color{Type: ColorIndexed, Index: uint8(p - 40)}
		case p == 48:
			i = s.parseExtColor(i, false)
		case p == 49:
			s.pen.BG = DefaultBG
		case p >= 90 && p <= 97:
			s.pen.FG = Color{Type: ColorIndexed, Index: uint8(p - 90 + 8)}
		case p >= 100 && p <= 107:
			s.pen.BG = Color{Type: ColorIndexed, Index: uint8(p - 100 + 8)}
		}
	}
}

// parseExtColor consumes 256-color or RGB parameters after 38/48.
// i is the index of the next parameter (sub-type). Returns new index.
func (s *Screen) parseExtColor(i int, fg bool) int {
	if i >= s.p.nParams {
		return i
	}
	sub := s.p.paramRaw(i)
	i++
	var c Color
	switch sub {
	case 5: // 256-color
		if i >= s.p.nParams {
			return i
		}
		c = Color{Type: ColorIndexed, Index: uint8(s.p.paramRaw(i))}
		i++
	case 2: // RGB
		if i+2 >= s.p.nParams {
			// Consume what we can.
			return s.p.nParams
		}
		c = Color{
			Type: ColorRGB,
			R:    uint8(s.p.paramRaw(i)),
			G:    uint8(s.p.paramRaw(i + 1)),
			B:    uint8(s.p.paramRaw(i + 2)),
		}
		i += 3
	default:
		return i
	}
	if fg {
		s.pen.FG = c
	} else {
		s.pen.BG = c
	}
	return i
}

// RowCells returns a copy of row y's cells, styling intact. RowString flattens a
// row to runes and drops the SGR attributes the parser worked to capture, so a
// renderer that wants color must read the cells.
func (s *Screen) RowCells(y int) []Cell {
	if y < 0 || y >= s.rows {
		return nil
	}
	out := make([]Cell, 0, s.cols)
	for x := 0; x < s.cols; x++ {
		c := s.active.cells[s.active.idx(x, y)]
		if c.Width == 0 && c.Rune == 0 {
			continue
		}
		out = append(out, c)
	}
	return out
}

// ScrollbackCells returns a copy of scrollback line i's cells, styling intact.
func (s *Screen) ScrollbackCells(i int) []Cell {
	row := s.scroll.line(i)
	if row == nil {
		return nil
	}
	out := make([]Cell, 0, len(row))
	for _, c := range row {
		if c.Width == 0 && c.Rune == 0 {
			continue
		}
		out = append(out, c)
	}
	return out
}
