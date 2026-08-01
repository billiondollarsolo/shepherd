package backend

import (
	"errors"
	"sync"
	"time"
)

// ErrWriteQueueFull is returned when the peer is too slow to drain the queue.
// The key is refused rather than silently dropped: the UI reports it.
var ErrWriteQueueFull = errors.New("pty write queue full")

// Async wraps s so Write and Resize never block the caller. A single writer
// goroutine owns the underlying stream; on the fleet backend a Write is a
// websocket frame over the network, and the caller is the Bubble Tea update
// loop, where one slow peer would stall keystrokes, rendering, and every other
// pane's output.
//
// depth is the write queue size (< 1 picks a default). Resizes coalesce onto a
// single slot: a resize drag must not fill the queue, and only the last size
// matters. Errors from the writer goroutine are stored and surface on the next
// Write or Resize, which is how they reach the statusline.
func Async(s PtyStream, depth int) PtyStream {
	if s == nil {
		return nil
	}
	if depth < 1 {
		depth = 256
	}
	a := &asyncStream{
		s:       s,
		writes:  make(chan []byte, depth),
		resizes: make(chan [2]uint16, 1),
		done:    make(chan struct{}),
		drained: make(chan struct{}),
	}
	go a.run()
	return a
}

// WaitClosed gives a stream closed with Close a bounded moment to flush the
// writes still queued behind it. Only the quit path waits: Close itself is
// called from the Bubble Tea update loop, which may not block on a socket.
func WaitClosed(s PtyStream, d time.Duration) {
	if w, ok := s.(interface{ waitClosed(time.Duration) }); ok {
		w.waitClosed(d)
	}
}

type asyncStream struct {
	s       PtyStream
	writes  chan []byte
	resizes chan [2]uint16
	done    chan struct{}
	drained chan struct{}

	once sync.Once

	mu     sync.Mutex
	closed bool
	err    error
}

// run drains the queues until Close. Buffered writes are delivered before the
// closed channel reports done, so a quit cannot lose the last keystrokes.
func (a *asyncStream) run() {
	defer close(a.done)
	for {
		select {
		case b, ok := <-a.writes:
			if !ok {
				a.drainResize()
				return
			}
			if _, err := a.s.Write(b); err != nil {
				a.setErr(err)
			}
		case sz := <-a.resizes:
			if err := a.s.Resize(sz[0], sz[1]); err != nil {
				a.setErr(err)
			}
		}
	}
}

func (a *asyncStream) drainResize() {
	select {
	case sz := <-a.resizes:
		if err := a.s.Resize(sz[0], sz[1]); err != nil {
			a.setErr(err)
		}
	default:
	}
}

func (a *asyncStream) Output() <-chan []byte { return a.s.Output() }

func (a *asyncStream) Write(p []byte) (int, error) {
	if err := a.takeErr(); err != nil {
		return 0, err
	}
	cp := make([]byte, len(p))
	copy(cp, p)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return 0, errors.New("pty closed")
	}
	select {
	case a.writes <- cp:
		return len(p), nil
	default:
		return 0, ErrWriteQueueFull
	}
}

func (a *asyncStream) Resize(cols, rows uint16) error {
	if err := a.takeErr(); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return errors.New("pty closed")
	}
	select {
	case a.resizes <- [2]uint16{cols, rows}:
		return nil
	default:
	}
	// The queued size is stale — replace it rather than queue a second one.
	select {
	case <-a.resizes:
	default:
	}
	select {
	case a.resizes <- [2]uint16{cols, rows}:
	default:
	}
	return nil
}

// Close stops accepting writes and lets the writer goroutine drain what is
// already queued. It does not wait for it: the writer may be inside a websocket
// write with a five second deadline, and Close is called from the update loop —
// waiting there froze the whole TUI on a dead peer. WaitClosed is the bounded
// wait, for the quit path.
func (a *asyncStream) Close() error {
	a.once.Do(func() {
		a.mu.Lock()
		a.closed = true
		close(a.writes)
		a.mu.Unlock()
		go func() {
			<-a.done
			_ = a.s.Close()
			close(a.drained)
		}()
	})
	return nil
}

func (a *asyncStream) waitClosed(d time.Duration) {
	select {
	case <-a.drained:
	case <-time.After(d):
	}
}

func (a *asyncStream) setErr(err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.err == nil {
		a.err = err
	}
}

// takeErr returns the writer goroutine's first error and clears it, so one dead
// peer produces one message rather than one per keystroke.
func (a *asyncStream) takeErr() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	err := a.err
	a.err = nil
	return err
}
