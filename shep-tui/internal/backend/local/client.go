// Package local is the flock-agentd backend (unix socket framed protocol).
package local

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/compat"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/flock/agentd/controlauth"
	"github.com/billiondollarsolo/flock/agentd/proto"
)

// SessionSpec describes a session to open (or re-attach) on agentd.
// Mirrors orchestrator AgentdSessionSpec / agentd session.Spec open fields.
type SessionSpec struct {
	ID      string
	Kind    string // "agent" | "shell" | …
	Cwd     string
	Command []string
	Cols    uint16
	Rows    uint16
	Mode    string // "" / "pty" (default) or "acp"
	Env     []string
}

// Client is one multiplexed connection to flock-agentd.
//
// Status channel: after a successful hello, agentd pushes unsolicited "status"
// control frames (snapshot first, then live changes). Those are decoded into
// backend.StatusUpdate and buffered on statusCh (capacity 64; drops when full
// so the read loop never blocks). WatchStatus fans that out per caller context.
// Reconnect is not automatic — use DialWithRetry (or Reconnect) after Close /
// dial failure; the daemon keeps sessions alive across client reconnects
// (re-subscribe via OpenPty). Feed status into backend.StatusMap for UI reads.
type Client struct {
	conn   net.Conn
	mu     sync.Mutex
	closed bool

	waiters []controlWaiter

	dataHandlers map[string]func([]byte)
	statusCh     chan backend.StatusUpdate

	daemonVersion string
	// nodeID is the identity this client handshook with: agentd is one node, and
	// this is its name. Every session on this connection lives on it.
	nodeID string
	// capsList is the negotiated capability set from helloOk (e.g. agent_control_v1).
	capsList []string
}

type controlWaiter struct {
	match func(proto.Control) bool
	ch    chan proto.Control
}

// dialFunc is the pluggable connection entry used by DialWithRetry tests.
type dialFunc func(socketPath, nodeID, secret string) (*Client, error)

// Dial connects to agentd at socketPath, performs hello, and starts the read loop.
func Dial(socketPath, nodeID, secret string) (*Client, error) {
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		return nil, fmt.Errorf("dial agentd %s: %w", socketPath, err)
	}
	c := &Client{
		conn:         conn,
		dataHandlers: make(map[string]func([]byte)),
		statusCh:     make(chan backend.StatusUpdate, 64),
	}
	go c.readLoop()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ok, err := c.Hello(ctx, nodeID, secret)
	if err != nil {
		_ = c.Close()
		return nil, err
	}
	c.daemonVersion = ok.DaemonVersion
	c.nodeID = nodeID
	c.capsList = append([]string(nil), ok.Capabilities...)
	return c, nil
}

// RetryOpts controls exponential backoff for DialWithRetry.
// Zero values are replaced with defaults: Initial=200ms, Max=5s, Factor=1.5.
type RetryOpts struct {
	Initial time.Duration // default 200ms
	Max     time.Duration // default 5s
	Factor  float64       // default 1.5
}

func (o RetryOpts) withDefaults() RetryOpts {
	if o.Initial <= 0 {
		o.Initial = 200 * time.Millisecond
	}
	if o.Max <= 0 {
		o.Max = 5 * time.Second
	}
	if o.Factor < 1 {
		o.Factor = 1.5
	}
	if o.Max < o.Initial {
		o.Max = o.Initial
	}
	return o
}

// DialWithRetry dials until success or ctx is done, with exponential backoff
// between attempts (Initial, growing by Factor, capped at Max).
func DialWithRetry(ctx context.Context, socket, nodeID, secret string, opts RetryOpts) (*Client, error) {
	return dialWithRetry(ctx, socket, nodeID, secret, opts, Dial)
}

// dialWithRetry is the testable core; dial is typically Dial.
func dialWithRetry(ctx context.Context, socket, nodeID, secret string, opts RetryOpts, dial dialFunc) (*Client, error) {
	opts = opts.withDefaults()
	var lastErr error
	delay := opts.Initial
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			if lastErr != nil {
				return nil, fmt.Errorf("dial agentd cancelled after %d attempt(s): %w (last: %v)", attempt, err, lastErr)
			}
			return nil, fmt.Errorf("dial agentd cancelled: %w", err)
		}

		c, err := dial(socket, nodeID, secret)
		if err == nil {
			return c, nil
		}
		if terminal(err) {
			// agentd refused the handshake itself; a retry re-sends the same
			// credential and gets the same answer, and burning the dial budget
			// would bury the real reason under a deadline error.
			return nil, err
		}
		lastErr = err

		// Wait with backoff, but abort early if ctx ends.
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, fmt.Errorf("dial agentd cancelled after %d attempt(s): %w (last: %v)", attempt+1, ctx.Err(), lastErr)
		case <-timer.C:
		}

		next := time.Duration(float64(delay) * opts.Factor)
		if next > opts.Max {
			next = opts.Max
		}
		if next < delay {
			// overflow / factor edge: stay at max
			next = opts.Max
		}
		delay = next
	}
}

// Reconnect dials a fresh Client (hello + read loop). Callers replace their
// *Client; existing daemon sessions persist and should be re-attached with
// OpenPty. Prefer DialWithRetry when the daemon may still be starting.
func Reconnect(socketPath, nodeID, secret string) (*Client, error) {
	return Dial(socketPath, nodeID, secret)
}

// DaemonVersion is set after a successful hello.
func (c *Client) DaemonVersion() string { return c.daemonVersion }

// HandshakeError is a handshake the daemon will never accept: a bad credential,
// a node-id mismatch, an unsupported protocol, a failed MAC. Retrying cannot fix
// any of them, so DialWithRetry stops on it instead of spending the whole dial
// budget re-sending a credential agentd has already refused.
type HandshakeError struct {
	Reason string
}

func (e *HandshakeError) Error() string { return e.Reason }

// Terminal reports that no amount of retrying will change the outcome.
func (e *HandshakeError) Terminal() bool { return true }

// terminal reports whether err (or anything it wraps) is permanent.
func terminal(err error) bool {
	var t interface{ Terminal() bool }
	return errors.As(err, &t) && t.Terminal()
}

// Hello sends the protocol handshake.
func (c *Client) Hello(ctx context.Context, nodeID, secret string) (proto.Control, error) {
	if nodeID == "" {
		return proto.Control{}, &HandshakeError{Reason: "agentd hello: empty node id"}
	}
	clientNonce, err := controlauth.Nonce()
	if err != nil {
		return proto.Control{}, fmt.Errorf("agentd hello nonce: %w", err)
	}
	credentialID := controlauth.CredentialID(secret)
	challenge, err := c.requestControl(ctx, proto.Control{
		Op:              "hello",
		ProtocolVersion: proto.ProtocolVersion,
		NodeID:          nodeID,
		ClientNonce:     clientNonce,
		CredentialID:    credentialID,
	}, func(x proto.Control) bool {
		return x.Op == "challenge" || x.Op == "helloOk" || x.Op == "error"
	})
	if err != nil {
		return proto.Control{}, err
	}
	if challenge.Op == "error" {
		return proto.Control{}, &HandshakeError{Reason: fmt.Sprintf("agentd hello failed: %s", challenge.Message)}
	}
	if challenge.Op == "helloOk" {
		return proto.Control{}, &HandshakeError{Reason: "agentd sent an unauthenticated handshake response"}
	}
	if challenge.ProtocolVersion != proto.ProtocolVersion || challenge.NodeID != nodeID ||
		challenge.CredentialID != credentialID || challenge.ClientNonce != clientNonce ||
		!controlauth.ValidNonce(challenge.ServerNonce) || challenge.DaemonVersion == "" ||
		challenge.ServerMAC == "" {
		return proto.Control{}, &HandshakeError{Reason: "agentd returned an invalid authentication challenge"}
	}
	expected := controlauth.MAC(secret, "server", nodeID, clientNonce, challenge.ServerNonce,
		challenge.DaemonVersion, challenge.Capabilities)
	if !controlauth.Verify(expected, challenge.ServerMAC) {
		return proto.Control{}, &HandshakeError{Reason: "agentd daemon authentication failed"}
	}
	ok, err := c.requestControl(ctx, proto.Control{
		Op:          "authenticate",
		NodeID:      nodeID,
		ClientNonce: clientNonce,
		ServerNonce: challenge.ServerNonce,
		ClientMAC: controlauth.MAC(secret, "client", nodeID, clientNonce, challenge.ServerNonce,
			challenge.DaemonVersion, challenge.Capabilities),
	}, func(x proto.Control) bool {
		return x.Op == "helloOk" || x.Op == "error"
	})
	if err != nil {
		return proto.Control{}, err
	}
	if ok.Op == "error" {
		return proto.Control{}, &HandshakeError{Reason: fmt.Sprintf("agentd authentication failed: %s", ok.Message)}
	}
	if ok.ProtocolVersion != proto.ProtocolVersion || ok.NodeID != nodeID ||
		ok.DaemonVersion != challenge.DaemonVersion ||
		!sameStrings(ok.Capabilities, challenge.Capabilities) {
		return proto.Control{}, &HandshakeError{Reason: "agentd authenticated identity changed during handshake"}
	}
	if err := compat.CheckAgentd(ok.ProtocolVersion, ok.DaemonVersion, ok.Capabilities); err != nil {
		return proto.Control{}, &HandshakeError{Reason: err.Error()}
	}
	return ok, nil
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// OpenSession creates or re-attaches a session on agentd and waits for opened/error.
func (c *Client) OpenSession(ctx context.Context, spec SessionSpec) error {
	if spec.ID == "" {
		return fmt.Errorf("OpenSession: empty session id")
	}
	ctrl, err := c.requestControl(ctx, proto.Control{
		Op:      "open",
		ID:      spec.ID,
		Kind:    spec.Kind,
		Cwd:     spec.Cwd,
		Env:     spec.Env,
		Command: spec.Command,
		Mode:    spec.Mode,
		Cols:    spec.Cols,
		Rows:    spec.Rows,
	}, func(x proto.Control) bool {
		return (x.Op == "opened" || x.Op == "error") && x.ID == spec.ID
	})
	if err != nil {
		return err
	}
	if ctrl.Op == "error" {
		return fmt.Errorf("agentd open %s failed: %s", spec.ID, ctrl.Message)
	}
	return nil
}

// CloseSession implements backend.Backend — tear down the session (fire-and-forget; no ack).
func (c *Client) CloseSession(ctx context.Context, id string) error {
	if id == "" {
		return fmt.Errorf("CloseSession: empty session id")
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	return c.sendControl(proto.Control{Op: "close", ID: id})
}

// LaunchAgent implements backend.Backend — open agentd session with explicit command.
func (c *Client) LaunchAgent(ctx context.Context, id, kind, cwd string, command []string, cols, rows uint16) error {
	if id == "" {
		return fmt.Errorf("LaunchAgent: empty session id")
	}
	if kind == "" {
		kind = "agent"
	}
	if cwd == "" {
		cwd = defaultShellCwd()
	}
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	if len(command) == 0 {
		return fmt.Errorf("LaunchAgent: empty command")
	}
	return c.OpenSession(ctx, SessionSpec{
		ID:      id,
		Kind:    kind,
		Cwd:     cwd,
		Command: command,
		Cols:    cols,
		Rows:    rows,
	})
}

// CreateShell implements backend.Backend — open a shell session via agentd "open".
// Prefers /bin/bash -l; falls back to /bin/sh. Empty cwd uses home or getwd.
func (c *Client) CreateShell(ctx context.Context, id, cwd string, cols, rows uint16) error {
	if id == "" {
		return fmt.Errorf("CreateShell: empty session id")
	}
	if cwd == "" {
		cwd = defaultShellCwd()
	}
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	return c.OpenSession(ctx, SessionSpec{
		ID:      id,
		Kind:    "shell",
		Cwd:     cwd,
		Command: defaultShellCommand(),
		Cols:    cols,
		Rows:    rows,
	})
}

// defaultShellCommand prefers login bash; falls back to sh when bash is missing.
func defaultShellCommand() []string {
	if st, err := os.Stat("/bin/bash"); err == nil && !st.IsDir() {
		return []string{"/bin/bash", "-l"}
	}
	return []string{"/bin/sh"}
}

// defaultShellCwd prefers $HOME, then the process working directory.
func defaultShellCwd() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return home
	}
	if wd, err := os.Getwd(); err == nil && wd != "" {
		return wd
	}
	return ""
}

// ListSessions implements backend.Backend.
func (c *Client) ListSessions(ctx context.Context) ([]domain.Session, error) {
	ctrl, err := c.requestControl(ctx, proto.Control{Op: "list"}, func(x proto.Control) bool {
		return x.Op == "sessions"
	})
	if err != nil {
		return nil, err
	}
	out := make([]domain.Session, 0, len(ctrl.Sessions))
	for _, s := range ctrl.Sessions {
		out = append(out, domain.Session{
			ID:        s.ID,
			NodeID:    c.NodeID(),
			Name:      s.ID,
			Cwd:       s.Cwd,
			AgentType: domain.AgentType(s.Kind),
			Status:    domain.StatusDisconnected, // refined by status frames
		})
	}
	return out, nil
}

// NodeID is the node this client handshook with (the daemon's own identity).
func (c *Client) NodeID() string {
	if c.nodeID != "" {
		return c.nodeID
	}
	if host, err := os.Hostname(); err == nil && host != "" {
		return host
	}
	return "local"
}

// ListNodes implements backend.Backend. agentd is one machine and knows of no
// others: the list is itself, and never a second row invented to fill a table.
func (c *Client) ListNodes(ctx context.Context) ([]domain.Node, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	id := c.NodeID()
	host := ""
	if h, err := os.Hostname(); err == nil {
		host = h
	}
	status := domain.NodeConnected
	c.mu.Lock()
	if c.closed {
		status = domain.NodeDisconnected
	}
	c.mu.Unlock()
	return []domain.Node{{
		ID:               id,
		Name:             id,
		Kind:             domain.NodeLocal,
		Host:             host,
		ConnectionStatus: status,
	}}, nil
}

// CreateNode implements backend.Backend: a local agentd cannot register nodes.
func (c *Client) CreateNode(ctx context.Context, spec backend.NodeSpec) (domain.Node, error) {
	select {
	case <-ctx.Done():
		return domain.Node{}, ctx.Err()
	default:
	}
	return domain.Node{}, backend.ErrNotSupported
}

// WatchStatus implements backend.Backend.
//
// Returns a per-caller channel that receives StatusUpdate values as agentd
// pushes "status" frames on this connection (see Client status channel docs).
// The channel is closed when ctx is cancelled or the client connection ends.
// Multiple concurrent WatchStatus calls share the same underlying buffer; slow
// consumers may miss updates (non-blocking send with drop).
func (c *Client) WatchStatus(ctx context.Context) (<-chan backend.StatusUpdate, error) {
	out := make(chan backend.StatusUpdate, 64)
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case u, ok := <-c.statusCh:
				if !ok {
					return
				}
				select {
				case out <- u:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, nil
}

// OpenPty implements backend.Backend (subscribe attach for an existing session).
// Register the data handler before subscribe so scrollback replay is not lost.
// Prefer OpenSession first when creating a new session id.
func (c *Client) OpenPty(ctx context.Context, sessionID string, cols, rows uint16) (backend.PtyStream, error) {
	if sessionID == "" {
		return nil, fmt.Errorf("OpenPty: empty session id")
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}

	stream := newPtyStream(c, sessionID)

	// Handler first, then optional resize, then subscribe — matches orchestrator
	// client order so early PTY frames are not dropped.
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, fmt.Errorf("agentd client closed")
	}
	c.dataHandlers[sessionID] = func(b []byte) {
		stream.push(b)
	}
	c.mu.Unlock()

	if cols > 0 && rows > 0 {
		if err := c.sendControl(proto.Control{Op: "resize", ID: sessionID, Cols: cols, Rows: rows}); err != nil {
			_ = stream.Close()
			return nil, err
		}
	}
	if err := c.sendControl(proto.Control{Op: "subscribe", ID: sessionID}); err != nil {
		_ = stream.Close()
		return nil, err
	}
	// subscribe "no such session" arrives as an unsolicited error frame; we do
	// not await it here so attach stays non-blocking. Callers that just opened
	// the session already know it exists.
	return stream, nil
}

// ListAudit is not available on local agentd (fleet-only governance surface).
func (c *Client) ListAudit(ctx context.Context) ([]backend.AuditEntry, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	return nil, backend.ErrNotSupported
}

// HasCapability reports whether helloOk advertised name (e.g. agent_control_v1).
func (c *Client) HasCapability(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, x := range c.capsList {
		if x == name {
			return true
		}
	}
	return false
}

// Capabilities implements backend.Backend.
// Standalone local mode is first-class: full paddock without orchestrator or SSH.
func (c *Client) Capabilities() backend.Caps {
	return backend.Caps{
		Mode:           "local",
		MultiNode:      false, // this machine only (agentd); no SSH required
		Launch:         true,  // OpenSession creates agent and shell sessions
		Git:            true,  // local os/exec git in session cwd
		Files:          true,  // local filesystem browser
		Handoff:        true,  // bootstrap seed into a newly launched local session
		ShellDrawer:    true,  // CreateShell secondary PTY
		Chat:           true,  // event/chat panel projection (thin without ACP stream)
		Audit:          false, // no orchestrator audit log on standalone
		Cost:           false, // agentd status frames carry no cost field
		StructuredChat: false, // ACP event stream not required for standalone
		AgentControl:   c.HasCapability("agent_control_v1") || c.HasCapability("screendetect_v1"),
	}
}

// Close implements backend.Backend.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	for _, w := range c.waiters {
		close(w.ch)
	}
	c.waiters = nil
	// The WatchStatus fan-out reads statusCh: without this it parks forever on a
	// client nobody holds any more. dispatchControl checks closed under the same
	// lock, so nothing can send after the close.
	close(c.statusCh)
	return c.conn.Close()
}

func (c *Client) sendControl(ctrl proto.Control) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return fmt.Errorf("agentd client closed")
	}
	return proto.WriteControl(c.conn, ctrl)
}

func (c *Client) writePty(sid string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return fmt.Errorf("agentd client closed")
	}
	return proto.WriteFrame(c.conn, proto.TypePtyInput, proto.EncodeData(sid, data))
}

// requestControl registers its response matcher before sending, so a fast local
// daemon cannot reply between the write and waiter registration.
func (c *Client) requestControl(ctx context.Context, control proto.Control, match func(proto.Control) bool) (proto.Control, error) {
	ch := make(chan proto.Control, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return proto.Control{}, fmt.Errorf("agentd client closed")
	}
	c.waiters = append(c.waiters, controlWaiter{match: match, ch: ch})
	c.mu.Unlock()
	if err := c.sendControl(control); err != nil {
		c.removeWaiter(ch)
		return proto.Control{}, err
	}

	select {
	case <-ctx.Done():
		c.removeWaiter(ch)
		// If delivery raced with cancel, prefer the successful control.
		select {
		case ctrl, ok := <-ch:
			if ok {
				return ctrl, nil
			}
		default:
		}
		return proto.Control{}, ctx.Err()
	case ctrl, ok := <-ch:
		if !ok {
			return proto.Control{}, fmt.Errorf("agentd connection closed")
		}
		return ctrl, nil
	}
}

func (c *Client) removeWaiter(ch chan proto.Control) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, w := range c.waiters {
		if w.ch == ch {
			c.waiters = append(c.waiters[:i], c.waiters[i+1:]...)
			return
		}
	}
}

func (c *Client) readLoop() {
	defer func() {
		_ = c.Close()
	}()
	for {
		typ, payload, err := proto.ReadFrame(c.conn)
		if err != nil {
			if err != io.EOF {
				// connection dropped
			}
			return
		}
		switch typ {
		case proto.TypeControl:
			ctrl, err := proto.DecodeControl(payload)
			if err != nil {
				continue
			}
			c.dispatchControl(ctrl)
		case proto.TypePtyOutput:
			sid, data, err := proto.DecodeData(payload)
			if err != nil {
				continue
			}
			c.mu.Lock()
			h := c.dataHandlers[sid]
			c.mu.Unlock()
			if h != nil {
				h(data)
			}
		}
	}
}

func (c *Client) dispatchControl(ctrl proto.Control) {
	if ctrl.Op == "status" && ctrl.ID != "" {
		u := backend.StatusUpdate{
			SessionID: ctrl.ID,
			Status:    domain.ParseStatus(ctrl.State),
			Telemetry: domain.Telemetry{
				Model:         ctrl.Model,
				Tool:          ctrl.Tool,
				Tokens:        ctrl.Tokens,
				ContextTokens: ctrl.ContextTokens,
				ContextLimit:  ctrl.ContextLimit,
				PlanJSON:      ctrl.Plan,
			},
		}
		c.mu.Lock()
		if !c.closed {
			select {
			case c.statusCh <- u:
			default:
				// drop if UI is slow; never block the read loop
			}
		}
		c.mu.Unlock()
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	// Match at most one waiter per frame (first from the end = most recent),
	// same as the orchestrator TS client, so concurrent awaits stay isolated.
	for i := len(c.waiters) - 1; i >= 0; i-- {
		w := c.waiters[i]
		if !w.match(ctrl) {
			continue
		}
		c.waiters = append(c.waiters[:i], c.waiters[i+1:]...)
		select {
		case w.ch <- ctrl:
		default:
		}
		return
	}
}

// Ensure Client implements backend.Backend.
var _ backend.Backend = (*Client)(nil)
