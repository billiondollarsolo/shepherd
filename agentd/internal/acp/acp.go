// Package acp implements a client for the Agent Client Protocol
// (agentclientprotocol.com) — the structured, JSON-RPC-over-stdio transport that
// Cursor, Gemini, and Grok speak. It is the rich path alongside agentd's raw-PTY
// transport (the universal fallback); see docs/roadmap.md F6.
//
// Wire format (verified against Synara's reference implementation,
// synara/packages/effect-acp): JSON-RPC 2.0 messages, ONE per line, newline
// delimited ("ndjson"), over the agent subprocess's stdin/stdout. No
// Content-Length framing.
package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

// rpcError is a JSON-RPC 2.0 error object.
type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("acp rpc error %d: %s", e.Code, e.Message) }

// message is a JSON-RPC 2.0 envelope (request, response, or notification).
type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Handlers receives agent→client traffic. Both are optional; a nil handler means
// "ignore" (notifications) or "deny" (permission requests).
type Handlers struct {
	// OnUpdate is called for every `session/update` notification, already parsed
	// into the canonical event list (one ACP update can yield one event).
	OnUpdate func(Event)
	// OnPermission answers a `session/request_permission` request. Return the id
	// of the chosen option (the agent's allow/deny option ids), or "" to cancel.
	OnPermission func(PermissionRequest) string
}

// Conn is a JSON-RPC 2.0 connection over an ndjson stdio pair. It is safe for one
// reader goroutine (Run) and concurrent callers (Call).
type Conn struct {
	w        io.Writer
	reader   *bufio.Reader
	wmu      sync.Mutex
	nextID   atomic.Int64
	mu       sync.Mutex
	pending  map[int64]chan message
	handlers Handlers
}

// NewConn wires a connection to an agent's stdout (r) + stdin (w). Call Run in a
// goroutine to pump incoming messages.
func NewConn(r io.Reader, w io.Writer, h Handlers) *Conn {
	return &Conn{
		w:        w,
		reader:   bufio.NewReaderSize(r, 1<<20),
		pending:  make(map[int64]chan message),
		handlers: h,
	}
}

// Run reads + dispatches messages until the stream closes or ctx is cancelled.
// Responses are routed to their pending Call; notifications + requests go to the
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
			// A malformed line is skipped (tolerant parser), not fatal.
		}
		if err != nil {
			c.failPending(err)
			return err
		}
	}
}

func (c *Conn) dispatch(msg message) {
	// A response carries an id + (result|error) and no method.
	if msg.ID != nil && msg.Method == "" {
		c.mu.Lock()
		ch := c.pending[*msg.ID]
		delete(c.pending, *msg.ID)
		c.mu.Unlock()
		if ch != nil {
			ch <- msg
		}
		return
	}
	switch msg.Method {
	case "session/update":
		if c.handlers.OnUpdate != nil {
			for _, ev := range parseSessionUpdate(msg.Params) {
				c.handlers.OnUpdate(ev)
			}
		}
	case "session/request_permission":
		c.handlePermission(msg)
	default:
		// Unknown agent→client request: reply with an empty result so the agent
		// isn't left blocking on a method we don't implement.
		if msg.ID != nil {
			c.reply(*msg.ID, json.RawMessage(`{}`), nil)
		}
	}
}

func (c *Conn) handlePermission(msg message) {
	req := parsePermissionRequest(msg.Params)
	var optionID string
	if c.handlers.OnPermission != nil {
		optionID = c.handlers.OnPermission(req)
	}
	if msg.ID == nil {
		return
	}
	// ACP permission response: { outcome: { outcome: "selected", optionId } } or
	// { outcome: { outcome: "cancelled" } }.
	var result json.RawMessage
	if optionID == "" {
		result = json.RawMessage(`{"outcome":{"outcome":"cancelled"}}`)
	} else {
		b, _ := json.Marshal(map[string]any{
			"outcome": map[string]any{"outcome": "selected", "optionId": optionID},
		})
		result = b
	}
	c.reply(*msg.ID, result, nil)
}

// Call sends a request and waits for its response.
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

// Notify sends a notification (no response expected).
func (c *Conn) Notify(method string, params any) error {
	return c.write(message{JSONRPC: "2.0", Method: method, Params: mustRaw(params)})
}

func (c *Conn) reply(id int64, result json.RawMessage, rerr *rpcError) {
	_ = c.write(message{JSONRPC: "2.0", ID: &id, Result: result, Error: rerr})
}

func (c *Conn) write(msg message) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if _, err := c.w.Write(append(b, '\n')); err != nil {
		return err
	}
	return nil
}

func (c *Conn) failPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, ch := range c.pending {
		ch <- message{Error: &rpcError{Code: -1, Message: err.Error()}}
		delete(c.pending, id)
	}
}

func mustRaw(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}
