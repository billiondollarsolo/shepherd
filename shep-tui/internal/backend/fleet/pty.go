package fleet

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/gorilla/websocket"
)

// ptyWriteTimeout bounds a frame write: without a deadline a dead peer blocks
// the writer forever, and gorilla/websocket has no write timeout by default.
const ptyWriteTimeout = 5 * time.Second

// OpenPty implements backend.Backend via /ws/pty/:id (binary PTY bridge).
func (c *Client) OpenPty(ctx context.Context, sessionID string, cols, rows uint16) (backend.PtyStream, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("OpenPty: empty session id")
	}
	if c.isClosed() {
		return nil, fmt.Errorf("fleet client closed")
	}
	wsURL, err := PtyWebSocketURL(c.BaseURL(), sessionID, cols, rows)
	if err != nil {
		return nil, err
	}

	hdr := http.Header{}
	if ck := c.cookieHeader(); ck != "" {
		hdr.Set("Cookie", ck)
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		Jar:              c.jar,
	}
	conn, _, err := dialer.DialContext(ctx, wsURL, hdr)
	if err != nil {
		return nil, fmt.Errorf("pty ws dial: %w", err)
	}

	stream := &ptyStream{
		conn:      conn,
		sessionID: sessionID,
		out:       make(chan []byte, 64),
	}
	go stream.readLoop()
	return stream, nil
}

type ptyStream struct {
	conn      *websocket.Conn
	sessionID string
	out       chan []byte
	once      sync.Once
	mu        sync.Mutex
	closed    bool
	writeMu   sync.Mutex
}

func (p *ptyStream) readLoop() {
	defer p.Close()
	for {
		msgType, data, err := p.conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType != websocket.BinaryMessage {
			continue
		}
		cp := make([]byte, len(data))
		copy(cp, data)
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return
		}
		select {
		case p.out <- cp:
		default:
			select {
			case <-p.out:
			default:
			}
			select {
			case p.out <- cp:
			default:
			}
		}
		p.mu.Unlock()
	}
}

func (p *ptyStream) Output() <-chan []byte { return p.out }

func (p *ptyStream) Write(b []byte) (int, error) {
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return 0, fmt.Errorf("pty closed")
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.conn.SetWriteDeadline(time.Now().Add(ptyWriteTimeout)); err != nil {
		return 0, err
	}
	if err := p.conn.WriteMessage(websocket.BinaryMessage, b); err != nil {
		return 0, err
	}
	return len(b), nil
}

func (p *ptyStream) Resize(cols, rows uint16) error {
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return fmt.Errorf("pty closed")
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	if err := p.conn.SetWriteDeadline(time.Now().Add(ptyWriteTimeout)); err != nil {
		return err
	}
	return p.conn.WriteMessage(websocket.TextMessage, []byte(EncodePtyResize(p.sessionID, cols, rows)))
}

func (p *ptyStream) Close() error {
	p.once.Do(func() {
		p.mu.Lock()
		p.closed = true
		close(p.out)
		p.mu.Unlock()
		_ = p.conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
			time.Now().Add(time.Second))
		_ = p.conn.Close()
	})
	return nil
}
