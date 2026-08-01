package vt

// parserState is the VT state machine phase (simplified DEC/xterm).
type parserState int

const (
	stateGround parserState = iota
	stateEscape
	stateCSI
	stateOSC
	stateOSCEsc // ESC inside OSC — may terminate with \
	stateDCS
	stateDCSEsc
	stateCharset // ESC ( ) * + intermediate — ignore one final
)

// parser holds partial escape sequence state.
type parser struct {
	state parserState

	// CSI params
	params   [16]int
	nParams  int
	paramIdx int // current param being built
	hasDigit bool
	priv     byte   // private marker '?' '<' '=' '>' or 0
	intermed byte   // intermediate byte (e.g. ' ' for some sequences)
	csiBuf   []byte // raw CSI body for rare inspection (capped)

	// OSC
	oscBuf []byte
}

const maxOSC = 1024
const maxCSIBody = 64

func (p *parser) resetCSI() {
	p.nParams = 0
	p.paramIdx = 0
	p.hasDigit = false
	p.priv = 0
	p.intermed = 0
	p.params = [16]int{}
	p.csiBuf = p.csiBuf[:0]
}

func (p *parser) resetOSC() {
	p.oscBuf = p.oscBuf[:0]
}

// param returns CSI parameter i (0-based), or def if missing/zero-as-default.
// ECMA-48: missing parameters often default to 1 for cursor ops, 0 for SGR/erase.
func (p *parser) param(i, def int) int {
	if i >= p.nParams {
		return def
	}
	v := p.params[i]
	if v == 0 {
		return def
	}
	return v
}

// paramRaw returns the raw parameter (0 if missing), without defaulting zeros.
func (p *parser) paramRaw(i int) int {
	if i >= p.nParams {
		return 0
	}
	return p.params[i]
}

func (p *parser) finishParam() {
	if p.hasDigit || p.nParams == 0 {
		// ensure slot exists
		if p.paramIdx >= len(p.params) {
			p.paramIdx = len(p.params) - 1
		}
		if p.nParams <= p.paramIdx {
			p.nParams = p.paramIdx + 1
		}
	}
	p.hasDigit = false
}

func (p *parser) pushDigit(d byte) {
	if p.paramIdx >= len(p.params) {
		return
	}
	// Cap large numbers to avoid overflow abuse.
	const maxParam = 32767
	v := p.params[p.paramIdx]
	v = v*10 + int(d-'0')
	if v > maxParam {
		v = maxParam
	}
	p.params[p.paramIdx] = v
	p.hasDigit = true
	if p.nParams <= p.paramIdx {
		p.nParams = p.paramIdx + 1
	}
}

func (p *parser) nextParam() {
	p.finishParam()
	if p.paramIdx+1 < len(p.params) {
		p.paramIdx++
	}
	p.hasDigit = false
}
