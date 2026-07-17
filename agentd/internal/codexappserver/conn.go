// Package codexappserver implements a client for Codex's `codex app-server`
// JSON-RPC protocol — the structured, stream-over-stdio transport that gives Codex
// the SAME rich chat surface (tool cards, audited approvals, streaming) agentd
// already drives for Claude's stream-json and the ACP agents. It is the structured
// path for Codex, alongside the raw-PTY fallback.
//
// Wire format (verified live on the node): newline-delimited JSON-RPC, ONE JSON
// object per line ("ndjson") — NOT Content-Length framed. This mirrors internal/acp
// (the ACP client) with three deliberate differences:
//
//  1. Responses do NOT carry a "jsonrpc":"2.0" field — the app-server is a
//     lightweight variant. We still SEND "jsonrpc":"2.0" defensively (it's ignored).
//  2. There are three message directions, distinguished purely by the presence of
//     `id` and `method`:
//     - CLIENT→SERVER request:  {"id":n,"method":m,"params":…} → {"id":n,"result":…}
//     - SERVER→CLIENT notification (streaming events): {"method":m,"params":…} (NO id)
//     - SERVER→CLIENT request (approvals): {"id":n,"method":m,"params":…} (HAS id) —
//     we MUST reply {"id":n,"result":…} or the server hangs.
//  3. So a message with BOTH an id AND a method is an inbound server-REQUEST, not a
//     response — the dispatch below keys on that.
package codexappserver

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

// RPCError is a JSON-RPC error object.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("codex app-server rpc error %d: %s", e.Code, e.Message)
}

// message is the ndjson envelope (request, response, notification, or server-request).
// Unlike ACP, an inbound frame with a non-nil ID AND a non-empty Method is a
// server-REQUEST we must reply to (see dispatch).
type message struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// Handlers receives server→client traffic. Both are optional; a nil handler drops
// the message (notifications are ignored; server-requests are left UNANSWERED, so a
// non-nil OnServerRequest is required to keep the server from blocking on approvals).
type Handlers struct {
	// OnNotification is called for every server→client notification (no id): the
	// method name plus its raw params, mapped downstream by codexItemToEvents.
	OnNotification func(method string, params json.RawMessage)
	// OnServerRequest is called for every server→client REQUEST (has id). The
	// handler OWNS the reply: it must eventually call Conn.Reply(id, …) — either
	// immediately (benign default) or later, after an operator answers an approval.
	// This deliberately does NOT block the read loop (unlike a synchronous return),
	// so subsequent notifications keep flowing while an approval is pending.
	OnServerRequest func(id int64, method string, params json.RawMessage)
}

// Conn is a JSON-RPC connection over an ndjson stdio pair. Safe for one reader
// goroutine (Run) and concurrent callers (Call / Reply).
type Conn struct {
	w        io.Writer
	reader   *bufio.Reader
	wmu      sync.Mutex
	nextID   atomic.Int64
	mu       sync.Mutex
	pending  map[int64]chan message
	handlers Handlers
}

// NewConn wires a connection to the app-server's stdout (r) + stdin (w). Call Run in
// a goroutine to pump incoming messages.
func NewConn(r io.Reader, w io.Writer, h Handlers) *Conn {
	return &Conn{
		w:        w,
		reader:   bufio.NewReaderSize(r, 1<<20),
		pending:  make(map[int64]chan message),
		handlers: h,
	}
}

// Run reads + dispatches messages until the stream closes or ctx is cancelled.
// Responses route to their pending Call; notifications + server-requests go to the
// handlers. Returns the terminating error (io.EOF on a clean close).
func (c *Conn) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line, err := c.reader.ReadBytes('\n')
		if len(line) > 0 {
			var msg message
			if jerr := json.Unmarshal(line, &msg); jerr == nil {
				c.dispatch(msg)
			}
			// A malformed line is skipped (tolerant parser), not fatal — the
			// app-server also logs a stray bubblewrap warning to STDERR (drained
			// elsewhere), but a defensive skip here costs nothing.
		}
		if err != nil {
			c.failPending(err)
			return err
		}
	}
}

func (c *Conn) dispatch(msg message) {
	switch {
	// Server→client REQUEST: has BOTH an id and a method. Must be replied to.
	case msg.ID != nil && msg.Method != "":
		if c.handlers.OnServerRequest != nil {
			c.handlers.OnServerRequest(*msg.ID, msg.Method, msg.Params)
		} else {
			// No handler: reply an empty result so the server never blocks.
			c.Reply(*msg.ID, json.RawMessage(`{}`), nil)
		}
	// Response to one of our Calls: has an id, no method.
	case msg.ID != nil:
		c.mu.Lock()
		ch := c.pending[*msg.ID]
		delete(c.pending, *msg.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- msg
		}
	// Notification: has a method, no id.
	case msg.Method != "":
		if c.handlers.OnNotification != nil {
			c.handlers.OnNotification(msg.Method, msg.Params)
		}
	}
}

// Call sends a request and waits for its response, correlating by id.
func (c *Conn) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	ch := make(chan message, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	if err := c.write(message{JSONRPC: "2.0", ID: &id, Method: method, Params: mustRaw(params)}); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case resp := <-ch:
		if resp.Error != nil {
			return nil, resp.Error
		}
		return resp.Result, nil
	}
}

// Notify sends a client→server notification (no response expected).
func (c *Conn) Notify(method string, params any) error {
	return c.write(message{JSONRPC: "2.0", Method: method, Params: mustRaw(params)})
}

// Reply answers an inbound server-request by id. Called by OnServerRequest handlers —
// either inline (benign default) or later once an operator answers an approval.
func (c *Conn) Reply(id int64, result any, rerr *RPCError) {
	_ = c.write(message{JSONRPC: "2.0", ID: &id, Result: mustRaw(result), Error: rerr})
}

func (c *Conn) write(msg message) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.w.Write(append(b, '\n'))
	return err
}

func (c *Conn) failPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, ch := range c.pending {
		ch <- message{Error: &RPCError{Code: -1, Message: err.Error()}}
		delete(c.pending, id)
	}
}

func mustRaw(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	if raw, ok := v.(json.RawMessage); ok {
		return raw
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}
