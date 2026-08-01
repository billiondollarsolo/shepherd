package fleet

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/gorilla/websocket"
)

// WatchStatus implements backend.Backend via /ws/status.
func (c *Client) WatchStatus(ctx context.Context) (<-chan backend.StatusUpdate, error) {
	if c.isClosed() {
		return nil, fmt.Errorf("fleet client closed")
	}
	wsURL, err := StatusWebSocketURL(c.BaseURL())
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
		return nil, fmt.Errorf("status ws dial: %w", err)
	}

	_ = conn.WriteMessage(websocket.TextMessage, []byte(EncodeStatusSubscribe()))

	// Closing the client hangs the socket up too: a caller that drops its client
	// without cancelling ctx would otherwise keep this subscription alive.
	ctx, cancel := context.WithCancel(ctx)
	c.addWatch(cancel)

	out := make(chan backend.StatusUpdate, 64)
	go func() {
		defer close(out)
		defer conn.Close()
		defer cancel()

		go func() {
			<-ctx.Done()
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
				time.Now().Add(time.Second))
			_ = conn.Close()
		}()

		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			u, ok := ParseStatusFrame(data)
			if !ok {
				continue
			}
			select {
			case out <- u:
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
	return out, nil
}
