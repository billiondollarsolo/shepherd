package session

// ring is a bounded byte buffer holding the most recent output for
// reconnect-resume. When it exceeds cap, the oldest bytes are dropped. Cheap and
// good enough for terminal scrollback (the client's xterm keeps fuller history).
type ring struct {
	buf []byte
	cap int
}

func newRing(capBytes int) *ring {
	return &ring{cap: capBytes}
}

func (r *ring) write(p []byte) {
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.cap {
		r.buf = r.buf[len(r.buf)-r.cap:]
	}
}

// snapshot returns a copy of the current contents (safe to hand to a caller).
func (r *ring) snapshot() []byte {
	out := make([]byte, len(r.buf))
	copy(out, r.buf)
	return out
}
