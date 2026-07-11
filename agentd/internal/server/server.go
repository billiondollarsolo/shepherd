// Package server wires the agentd protocol to the session manager over a single
// framed, multiplexed connection (one per orchestrator↔node link). It is
// transport-agnostic: HandleConn takes any net.Conn, so the same code serves the
// local unix socket and a remote SSH direct-tcpip channel.
package server

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"flock-agentd/internal/controlauth"
	"flock-agentd/internal/identity"
	"flock-agentd/internal/metrics"
	"flock-agentd/internal/proto"
	"flock-agentd/internal/session"
)

// writeTimeout bounds every frame write. A client whose TCP receive window fills
// (frozen tab / dead half-open tunnel) must not block the connection's writer —
// and thus, via wmu, every other session on this link — indefinitely. On timeout
// the write errors and we tear the connection down.
const writeTimeout = 30 * time.Second

// Server holds shared daemon state.
type Server struct {
	mgr     *session.Manager
	version string
	nodeID  string
	secret  string
	layout  LayoutStore
	runtime *identity.Runtime
}

// LayoutStore persists per-workspace pane layouts (implemented in task #22).
type LayoutStore interface {
	Get(workspace string) []byte
	Set(workspace string, tree []byte) error
}

func New(mgr *session.Manager, version, nodeID, secret string, layout LayoutStore, runtime *identity.Runtime) *Server {
	return &Server{mgr: mgr, version: version, nodeID: nodeID, secret: secret, layout: layout, runtime: runtime}
}

var controlCapabilities = []string{"pty", "resize", "scrollback", "status", "node-info", "layout", "acp"}

// conn is the per-connection state.
type conn struct {
	s         *Server
	raw       net.Conn
	wmu       sync.Mutex // serializes frame writes
	smu       sync.Mutex
	subs      map[string]*session.Subscription
	statusSub *session.StatusSub
	authed    bool
	challenge *authChallenge
}

type authChallenge struct {
	clientNonce string
	serverNonce string
}

// HandleConn services one connection until it closes.
func (s *Server) HandleConn(raw net.Conn) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[flock-agentd] connection handler panic: %v\n", r)
		}
	}()
	c := &conn{s: s, raw: raw, subs: make(map[string]*session.Subscription)}
	defer c.cleanup()
	for {
		typ, payload, err := proto.ReadFrame(raw)
		if err != nil {
			return
		}
		switch typ {
		case proto.TypeControl:
			ctrl, derr := proto.DecodeControl(payload)
			if derr != nil {
				continue
			}
			c.handleControl(ctrl)
		case proto.TypePtyInput:
			sid, data, derr := proto.DecodeData(payload)
			if derr != nil || !c.authed {
				continue
			}
			if sess := s.mgr.Get(sid); sess != nil {
				_ = sess.Write(data)
			}
		}
	}
}

func (c *conn) handleControl(ctrl proto.Control) {
	// The v2 handshake authenticates the daemon first, then the client. The fresh
	// server nonce makes a captured authenticate frame useless on a new link.
	if ctrl.Op == "hello" {
		if c.challenge != nil || c.authed || ctrl.ProtocolVersion != proto.ProtocolVersion {
			c.reject("unsupported agentd protocol version")
			return
		}
		if ctrl.NodeID != c.s.nodeID {
			c.reject("node identity mismatch")
			return
		}
		if !controlauth.ValidNonce(ctrl.ClientNonce) {
			c.reject("invalid client nonce")
			return
		}
		serverNonce, err := controlauth.Nonce()
		if err != nil {
			c.reject("authentication unavailable")
			return
		}
		c.challenge = &authChallenge{clientNonce: ctrl.ClientNonce, serverNonce: serverNonce}
		c.sendControl(proto.Control{
			Op:              "challenge",
			ProtocolVersion: proto.ProtocolVersion,
			DaemonVersion:   c.s.version,
			NodeID:          c.s.nodeID,
			ClientNonce:     ctrl.ClientNonce,
			ServerNonce:     serverNonce,
			Capabilities:    controlCapabilities,
			ServerMAC: controlauth.MAC(c.s.secret, "server", c.s.nodeID,
				ctrl.ClientNonce, serverNonce, c.s.version, controlCapabilities),
		})
		return
	}
	if ctrl.Op == "authenticate" {
		challenge := c.challenge
		if challenge == nil || c.authed || ctrl.NodeID != c.s.nodeID ||
			ctrl.ClientNonce != challenge.clientNonce || ctrl.ServerNonce != challenge.serverNonce {
			c.reject("invalid authentication state")
			return
		}
		expected := controlauth.MAC(c.s.secret, "client", c.s.nodeID,
			challenge.clientNonce, challenge.serverNonce, c.s.version, controlCapabilities)
		if !controlauth.Verify(expected, ctrl.ClientMAC) {
			c.reject("unauthorized")
			return
		}
		c.challenge = nil
		c.authed = true
		c.sendControl(proto.Control{
			Op:              "helloOk",
			ProtocolVersion: proto.ProtocolVersion,
			DaemonVersion:   c.s.version,
			NodeID:          c.s.nodeID,
			Capabilities:    controlCapabilities,
		})
		c.startStatusForwarder()
		return
	}
	if !c.authed {
		c.reject("authentication required")
		return
	}
	switch ctrl.Op {
	case "open":
		_, err := c.s.mgr.Open(session.Spec{
			ID: ctrl.ID, Kind: ctrl.Kind, Cwd: ctrl.Cwd, Env: ctrl.Env,
			Command: ctrl.Command, Mode: ctrl.Mode, Cols: ctrl.Cols, Rows: ctrl.Rows,
			ConfigDirEnv: ctrl.ConfigDirEnv, ConfigFiles: ctrl.ConfigFiles,
			ConfigBaseSubdir: ctrl.ConfigBaseSubdir,
			Sandbox:          ctrl.Sandbox,
			SandboxAllow:     ctrl.SandboxAllow,
			ActivityStatus:   ctrl.ActivityStatus,
			Identity:         c.s.runtime,
		})
		if err != nil {
			c.sendControl(proto.Control{Op: "error", ID: ctrl.ID, Message: err.Error()})
			return
		}
		c.sendControl(proto.Control{Op: "opened", ID: ctrl.ID})
	case "subscribe":
		sess := c.s.mgr.Get(ctrl.ID)
		if sess == nil {
			c.sendControl(proto.Control{Op: "error", ID: ctrl.ID, Message: "no such session"})
			return
		}
		sub := sess.Subscribe()
		c.smu.Lock()
		if old := c.subs[ctrl.ID]; old != nil {
			old.Close()
		}
		c.subs[ctrl.ID] = sub
		c.smu.Unlock()
		go c.stream(ctrl.ID, sess, sub)
	case "unsubscribe":
		c.dropSub(ctrl.ID)
	case "resize":
		if sess := c.s.mgr.Get(ctrl.ID); sess != nil {
			_ = sess.Resize(ctrl.Cols, ctrl.Rows)
		}
	case "close":
		c.s.mgr.Close(ctrl.ID)
	case "list":
		specs := c.s.mgr.List()
		infos := make([]proto.SessionInfo, 0, len(specs))
		for _, sp := range specs {
			infos = append(infos, proto.SessionInfo{ID: sp.ID, Kind: sp.Kind, Cwd: sp.Cwd})
		}
		c.sendControl(proto.Control{Op: "sessions", Sessions: infos})
	case "nodeInfo":
		// Host snapshot + per-session resident memory + CPU%, so the UI can
		// attribute a node's RAM/CPU to specific sessions (not just the host total).
		combined := struct {
			metrics.NodeInfo
			Processes map[string]session.ProcStat `json:"processes,omitempty"`
		}{metrics.Snapshot(), c.s.mgr.ProcessStats()}
		if blob, err := json.Marshal(combined); err == nil {
			c.sendControl(proto.Control{Op: "nodeInfo", NodeInfo: blob})
		}
	case "getLayout":
		if c.s.layout != nil {
			c.sendControl(proto.Control{Op: "layout", Workspace: ctrl.Workspace, Layout: c.s.layout.Get(ctrl.Workspace)})
		}
	case "setLayout":
		if c.s.layout != nil {
			_ = c.s.layout.Set(ctrl.Workspace, ctrl.Layout)
		}
	}
}

func (c *conn) reject(message string) {
	c.sendControl(proto.Control{Op: "error", Message: message})
	_ = c.raw.Close()
}

// stream replays scrollback then forwards live PTY output for one session.
func (c *conn) stream(sid string, sess *session.Session, sub *session.Subscription) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[flock-agentd] stream panic (%s): %v\n", sid, r)
			_ = c.raw.Close()
		}
	}()
	if len(sub.Replay) > 0 {
		c.sendData(sid, sub.Replay)
	}
	for chunk := range sub.Output {
		c.sendData(sid, chunk)
	}
	// Output closed: either the process exited (announce it) or we unsubscribed.
	if exited, code := sess.Exited(); exited {
		c.sendControl(proto.Control{Op: "exit", ID: sid, Code: code})
	}
	c.smu.Lock()
	if c.subs[sid] == sub {
		delete(c.subs, sid)
	}
	c.smu.Unlock()
}

func (c *conn) dropSub(sid string) {
	c.smu.Lock()
	sub := c.subs[sid]
	delete(c.subs, sid)
	c.smu.Unlock()
	if sub != nil {
		sub.Close()
	}
}

// startStatusForwarder relays manager status (snapshot + live) to this client as
// `status` control frames. Started once per connection after the handshake.
func (c *conn) startStatusForwarder() {
	sub := c.s.mgr.SubscribeStatus()
	c.statusSub = sub
	for _, ev := range sub.Snapshot {
		c.sendControl(statusControl(ev))
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintf(os.Stderr, "[flock-agentd] status forwarder panic: %v\n", r)
				_ = c.raw.Close()
			}
		}()
		for ev := range sub.Events {
			c.sendControl(statusControl(ev))
		}
	}()
}

// statusControl converts a manager StatusEvent into the wire `status` frame. One
// place to map the telemetry snapshot → Control (was two identical literals).
func statusControl(ev session.StatusEvent) proto.Control {
	return proto.Control{
		Op: "status", ID: ev.ID,
		State: ev.State, Tokens: ev.Tokens, Tool: ev.Tool,
		Model: ev.Model, ContextTokens: ev.ContextTokens, ContextLimit: ev.ContextLimit, Plan: ev.Plan,
	}
}

func (c *conn) cleanup() {
	if c.statusSub != nil {
		c.statusSub.Close()
	}
	c.smu.Lock()
	subs := c.subs
	c.subs = map[string]*session.Subscription{}
	c.smu.Unlock()
	for _, sub := range subs {
		sub.Close()
	}
	_ = c.raw.Close()
}

func (c *conn) sendControl(ctrl proto.Control) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.raw.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := proto.WriteControl(c.raw, ctrl); err != nil {
		_ = c.raw.Close() // unblocks the read loop → HandleConn returns → cleanup
	}
}

func (c *conn) sendData(sid string, data []byte) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.raw.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := proto.WriteFrame(c.raw, proto.TypePtyOutput, proto.EncodeData(sid, data)); err != nil {
		_ = c.raw.Close()
	}
}
