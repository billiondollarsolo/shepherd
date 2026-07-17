// Package proto is the public flock-agentd wire contract: length-prefixed frames carrying
// either a JSON control message or session-tagged binary PTY data. The TS
// orchestrator mirrors this (see apps/orchestrator/src/nodes/agentd/protocol.ts). One framed,
// multiplexed stream runs over an SSH direct-tcpip channel (remote) or a unix
// socket (local).
//
// Frame: [uint32 len][len bytes], where byte 0 of the body is the type and the
// rest is the payload. `len` = 1 (type) + len(payload).
package proto

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const ProtocolVersion = 2

// Frame types.
const (
	TypeControl   byte = 0x01 // payload = JSON Control
	TypePtyOutput byte = 0x02 // payload = [u16 sidLen][sid][bytes]  (daemon→client)
	TypePtyInput  byte = 0x03 // payload = [u16 sidLen][sid][bytes]  (client→daemon)
	TypeTCPOutput byte = 0x04 // payload = raw tunnel bytes (daemon→client, operation link)
	TypeTCPInput  byte = 0x05 // payload = raw tunnel bytes (client→daemon, operation link)
)

const maxFrame = 16 << 20 // 16 MiB hard cap per frame

// Control is the JSON control message. A single flat struct keeps framing simple;
// `op` selects the meaning of the optional fields.
type Control struct {
	Op string `json:"op"`

	// hello / helloOk
	ProtocolVersion int      `json:"protocolVersion,omitempty"`
	DaemonVersion   string   `json:"daemonVersion,omitempty"`
	NodeID          string   `json:"nodeId,omitempty"`
	ClientNonce     string   `json:"clientNonce,omitempty"`
	ServerNonce     string   `json:"serverNonce,omitempty"`
	ServerMAC       string   `json:"serverMac,omitempty"`
	ClientMAC       string   `json:"clientMac,omitempty"`
	Capabilities    []string `json:"capabilities,omitempty"`
	CredentialID    string   `json:"credentialId,omitempty"`
	NewCredential   string   `json:"newCredential,omitempty"`
	ConnectionRole  string   `json:"connectionRole,omitempty"`

	// session open / close / subscribe / resize / exit
	ID      string   `json:"id,omitempty"`
	Kind    string   `json:"kind,omitempty"`
	Cwd     string   `json:"cwd,omitempty"`
	Env     []string `json:"env,omitempty"`
	Command []string `json:"command,omitempty"`
	// Mode selects the session transport: "" / "pty" (default), "acp" (F6), or
	// "claude-stream" (Claude's structured stream-json transport).
	Mode   string `json:"mode,omitempty"`
	Cols   uint16 `json:"cols,omitempty"`
	Rows   uint16 `json:"rows,omitempty"`
	Code   int    `json:"code,omitempty"`
	Signal string `json:"signal,omitempty"`

	// exec_v1: bounded non-interactive command execution.
	Input           string `json:"input,omitempty"`
	TimeoutMS       int    `json:"timeoutMs,omitempty"`
	StdoutLimit     int    `json:"stdoutLimit,omitempty"`
	StderrLimit     int    `json:"stderrLimit,omitempty"`
	Stdout          string `json:"stdout,omitempty"`
	Stderr          string `json:"stderr,omitempty"`
	TimedOut        bool   `json:"timedOut,omitempty"`
	StdoutTruncated bool   `json:"stdoutTruncated,omitempty"`
	StderrTruncated bool   `json:"stderrTruncated,omitempty"`

	// tcp_tunnel_v1: dedicated authenticated loopback tunnel connection.
	TargetHost string `json:"targetHost,omitempty"`
	TargetPort int    `json:"targetPort,omitempty"`

	// Native hook-config injection (US-19), seeded on the node by Open.
	ConfigFiles      map[string]string `json:"configFiles,omitempty"`
	ConfigBaseSubdir string            `json:"configBaseSubdir,omitempty"`
	// T17 — Landlock FS sandbox for autonomous sessions (open: client→daemon).
	Sandbox      bool     `json:"sandbox,omitempty"`
	SandboxAllow []string `json:"sandboxAllow,omitempty"`
	// T61 — derive status from PTY activity (agents with no transcript/hook, e.g. gemini).
	ActivityStatus bool `json:"activityStatus,omitempty"`

	// error
	Message string `json:"message,omitempty"`

	// list
	Sessions []SessionInfo `json:"sessions,omitempty"`

	// listeningPorts: bounded loopback/wildcard TCP listener discovery.
	ListeningPorts []ListeningPort `json:"listeningPorts,omitempty"`
	ObservedAt     string          `json:"observedAt,omitempty"`
	DiscoveryError string          `json:"discoveryError,omitempty"`

	// layout
	Workspace string          `json:"workspace,omitempty"`
	Layout    json.RawMessage `json:"layout,omitempty"`

	// nodeInfo (daemon→client): host metrics + detected agents (JSON blob).
	NodeInfo json.RawMessage `json:"nodeInfo,omitempty"`

	// status (daemon→client): derived agent status for session ID.
	State  string `json:"state,omitempty"`
	Tokens int    `json:"tokens,omitempty"`
	Tool   string `json:"tool,omitempty"`
	// T19 — richer telemetry: model name + current context-window occupancy.
	Model         string `json:"model,omitempty"`
	ContextTokens int    `json:"contextTokens,omitempty"`
	ContextLimit  int    `json:"contextLimit,omitempty"` // T60: agent-reported context window
	Plan          string `json:"plan,omitempty"`         // T62: JSON [{content,status}] task list
}

// SessionInfo is a session summary for `list`.
type SessionInfo struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Cwd  string `json:"cwd"`
}

// ListeningPort is safe process metadata for one node-local TCP listener.
// It deliberately excludes argv, environment, socket payloads, and connections.
type ListeningPort struct {
	ObservationKey string `json:"observationKey"`
	Address        string `json:"address"`
	TargetHost     string `json:"targetHost"`
	Port           int    `json:"port"`
	PID            int    `json:"pid,omitempty"`
	Process        string `json:"process,omitempty"`
	Cwd            string `json:"cwd,omitempty"`
	SessionID      string `json:"sessionId,omitempty"`
}

// WriteFrame writes one framed message.
func WriteFrame(w io.Writer, typ byte, payload []byte) error {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)+1))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if _, err := w.Write([]byte{typ}); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// ReadFrame reads one framed message, returning the type and payload.
func ReadFrame(r io.Reader) (byte, []byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > maxFrame {
		return 0, nil, fmt.Errorf("proto: bad frame length %d", n)
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		return 0, nil, err
	}
	return body[0], body[1:], nil
}

// WriteControl encodes + writes a control frame.
func WriteControl(w io.Writer, c Control) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return WriteFrame(w, TypeControl, b)
}

// DecodeControl parses a control payload.
func DecodeControl(payload []byte) (Control, error) {
	var c Control
	err := json.Unmarshal(payload, &c)
	return c, err
}

// EncodeData builds a session-tagged data payload: [u16 sidLen][sid][data].
func EncodeData(sid string, data []byte) []byte {
	out := make([]byte, 2+len(sid)+len(data))
	binary.BigEndian.PutUint16(out[:2], uint16(len(sid)))
	copy(out[2:], sid)
	copy(out[2+len(sid):], data)
	return out
}

// DecodeData splits a data payload into its session id and bytes.
func DecodeData(payload []byte) (sid string, data []byte, err error) {
	if len(payload) < 2 {
		return "", nil, fmt.Errorf("proto: short data frame")
	}
	l := int(binary.BigEndian.Uint16(payload[:2]))
	if 2+l > len(payload) {
		return "", nil, fmt.Errorf("proto: data sid length overflow")
	}
	return string(payload[2 : 2+l]), payload[2+l:], nil
}
