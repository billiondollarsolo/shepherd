package backend

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// blockingStream blocks every Write until release is closed, the way a slow
// websocket peer does.
type blockingStream struct {
	release chan struct{}
	out     chan []byte

	mu       sync.Mutex
	written  []byte
	sizes    [][2]uint16
	closed   bool
	writeErr error
}

func newBlockingStream() *blockingStream {
	return &blockingStream{release: make(chan struct{}), out: make(chan []byte)}
}

func (b *blockingStream) Output() <-chan []byte { return b.out }

func (b *blockingStream) Write(p []byte) (int, error) {
	<-b.release
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.writeErr != nil {
		return 0, b.writeErr
	}
	b.written = append(b.written, p...)
	return len(p), nil
}

func (b *blockingStream) Resize(cols, rows uint16) error {
	<-b.release
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sizes = append(b.sizes, [2]uint16{cols, rows})
	return nil
}

func (b *blockingStream) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	return nil
}

func (b *blockingStream) state() (string, [][2]uint16, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.written), append([][2]uint16(nil), b.sizes...), b.closed
}

// A blocked peer must not block the caller: the whole point is that Update never
// waits on the network.
func TestAsyncWriteDoesNotBlockOnASlowPeer(t *testing.T) {
	slow := newBlockingStream()
	a := Async(slow, 8)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for _, k := range []string{"h", "i"} {
			if _, err := a.Write([]byte(k)); err != nil {
				t.Errorf("Write: %v", err)
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Write blocked on the peer")
	}

	close(slow.release)
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	WaitClosed(a, time.Second)
	written, _, closed := slow.state()
	if written != "hi" {
		t.Fatalf("written = %q want hi — Close dropped queued keys", written)
	}
	if !closed {
		t.Fatal("Close did not reach the underlying stream")
	}
}

// Close is called from the Bubble Tea update loop, where the writer goroutine may
// be parked in a socket write for as long as its deadline. Waiting for it there
// froze the whole TUI; only WaitClosed, on the quit path, may wait.
func TestAsyncCloseDoesNotBlockOnASlowPeer(t *testing.T) {
	slow := newBlockingStream()
	a := Async(slow, 8)
	if _, err := a.Write([]byte("h")); err != nil {
		t.Fatal(err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = a.Close()
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Close blocked on the peer")
	}

	// The queued key still reaches the agent once the peer drains.
	close(slow.release)
	WaitClosed(a, time.Second)
	if written, _, closed := slow.state(); written != "h" || !closed {
		t.Fatalf("written = %q closed = %v — the drain was dropped", written, closed)
	}
}

// A resize drag queues one size per frame; only the last one is worth a control
// frame, and the queue must not fill up with stale ones.
func TestAsyncResizeCoalesces(t *testing.T) {
	slow := newBlockingStream()
	a := Async(slow, 8)
	for i := uint16(1); i <= 20; i++ {
		if err := a.Resize(i, i); err != nil {
			t.Fatal(err)
		}
	}
	close(slow.release)
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	WaitClosed(a, time.Second)
	_, sizes, _ := slow.state()
	if len(sizes) == 0 || len(sizes) > 2 {
		t.Fatalf("sizes = %v — resizes did not coalesce", sizes)
	}
	if last := sizes[len(sizes)-1]; last != [2]uint16{20, 20} {
		t.Fatalf("last size = %v want the newest", last)
	}
}

// The writer goroutine's error has to reach the caller, or a dead peer looks
// exactly like a working one.
func TestAsyncSurfacesWriteError(t *testing.T) {
	slow := newBlockingStream()
	slow.writeErr = errors.New("peer gone")
	close(slow.release)
	a := Async(slow, 8)

	if _, err := a.Write([]byte("x")); err != nil {
		t.Fatalf("first write should be queued: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	var err error
	for time.Now().Before(deadline) {
		if _, err = a.Write([]byte("y")); err != nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if err == nil {
		t.Fatal("write error never surfaced to the caller")
	}
	// Reported once, not once per keystroke.
	if _, err := a.Write([]byte("z")); err != nil {
		t.Fatalf("error repeated: %v", err)
	}
	_ = a.Close()
}

func TestAsyncFullQueueIsReported(t *testing.T) {
	slow := newBlockingStream()
	a := Async(slow, 1)
	// One write is taken by the writer goroutine, one fills the queue; the rest
	// have nowhere to go.
	var err error
	for i := 0; i < 8 && err == nil; i++ {
		_, err = a.Write([]byte("x"))
	}
	if !errors.Is(err, ErrWriteQueueFull) {
		t.Fatalf("err = %v want ErrWriteQueueFull", err)
	}
	close(slow.release)
	_ = a.Close()
}
