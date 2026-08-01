package local

import (
	"io"
	"sync"

	"github.com/billiondollarsolo/flock/agentd/proto"
)

// ptyOutputQueue is how many PTY chunks may be in flight to the UI. The Bubble
// Tea loop drains them in coalesced batches; a shallow queue drops agent output
// whenever the UI is busy for a moment.
const ptyOutputQueue = 1024

type ptyStream struct {
	client *Client
	id     string
	out    chan []byte
	once   sync.Once
	closed bool
	mu     sync.Mutex
}

func newPtyStream(c *Client, id string) *ptyStream {
	return &ptyStream{
		client: c,
		id:     id,
		out:    make(chan []byte, ptyOutputQueue),
	}
}

func (p *ptyStream) push(b []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	// copy — caller may reuse buffer
	cp := make([]byte, len(b))
	copy(cp, b)
	select {
	case p.out <- cp:
	default:
		// drop oldest-style: try once more after non-blocking drain of one
		select {
		case <-p.out:
		default:
		}
		select {
		case p.out <- cp:
		default:
		}
	}
}

func (p *ptyStream) Output() <-chan []byte { return p.out }

func (p *ptyStream) Write(b []byte) (int, error) {
	if err := p.client.writePty(p.id, b); err != nil {
		return 0, err
	}
	return len(b), nil
}

func (p *ptyStream) Resize(cols, rows uint16) error {
	return p.client.sendControl(proto.Control{Op: "resize", ID: p.id, Cols: cols, Rows: rows})
}

func (p *ptyStream) Close() error {
	p.once.Do(func() {
		p.mu.Lock()
		p.closed = true
		close(p.out)
		p.mu.Unlock()
		p.client.mu.Lock()
		delete(p.client.dataHandlers, p.id)
		p.client.mu.Unlock()
		_ = p.client.sendControl(proto.Control{Op: "unsubscribe", ID: p.id})
	})
	return nil
}

var _ io.Writer = (*ptyStream)(nil)
