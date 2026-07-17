package session

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/billiondollarsolo/flock/agentd/internal/acp"
	"github.com/billiondollarsolo/flock/agentd/internal/claudestream"
	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

// claudestream_session.go — an interactive session over Claude Code's STRUCTURED
// stream-json transport (`claude --print --input-format stream-json
// --output-format stream-json --verbose`) instead of a raw PTY. Claude runs as a
// PERSISTENT subprocess whose stdin stays OPEN: each user turn is written as one
// {"type":"user",…} line and the process streams back ndjson events for the whole
// turn. Those lines are parsed by internal/claudestream.ParseLine into the SAME
// canonical acp.Event taxonomy the ACP client emits, so this driver REUSES the
// existing ACP bridge wholesale: renderACPEvent (scrollback render + chat forward)
// and acpEventToUpdate (status frames). Chat + status therefore flow through the
// identical downstream pipeline as the ACP path — nothing new is invented here.
//
// This is the foundation transport. Real audited approvals ride Claude's stream-json
// CONTROL protocol: launched with `--permission-prompt-tool stdio`, Claude routes each
// permission-gated tool to a {"type":"control_request",…,"subtype":"can_use_tool"} line
// on stdout; the driver flips the session to awaiting_input, posts a request.opened
// approval event (rendered by the web's RequestCard), and the operator's y/n answer is
// written back as a {"type":"control_response",…} line on stdin. This MIRRORS the ACP
// permission path (acp_session.go: acpAwaitPermission + acpInput) — same awaiting_input
// + RequestCard + stdin-answer pattern, no new orchestrator endpoint.
//
// PTY remains the universal default (Invariant 1); this path is only taken for
// Spec.Mode == "claude-stream".

// claudeState holds the per-session claude-stream runtime (nil for other sessions).
// It reuses acpState (via the session's s.acp handle) for chat forwarding + the
// assistant-prose accumulator, so renderACPEvent works unchanged; this struct only
// adds the stdin pipe + local line-edit buffer that replace the ACP conn/prompt.
type claudeState struct {
	mu    sync.Mutex
	stdin io.WriteCloser // the persistent process stdin (kept OPEN for multi-turn)
	line  []byte         // the in-progress input line (local echo + edit)
	// FIFO queue of can_use_tool approvals awaiting a y/n answer. A single turn can
	// issue MULTIPLE gated tools (parallel tool calls), each with its own request_id;
	// every one must get a control_response or Claude hangs/denies it. Answers are
	// consumed oldest-first.
	pending []*claudePending
}

// claudePending is the state for an in-flight can_use_tool approval: the control
// request_id to answer against, and the ORIGINAL tool input echoed back verbatim as
// updatedInput on allow (Claude may reject an allow with no updatedInput).
type claudePending struct {
	requestID string
	input     json.RawMessage
}

// OpenClaudeStream starts a claude-stream-mode session. statusPush wires derived
// status to the manager (analog of OpenACP). spec.Command must be the full claude
// stream-json launch argv (the orchestrator builds it via claudeStreamLaunchCommand).
func OpenClaudeStream(spec Spec, statusPush func(status.Update)) (*Session, error) {
	if len(spec.Command) == 0 {
		return nil, fmt.Errorf("claude-stream session %s: no launch command", spec.ID)
	}
	s := &Session{
		spec:       spec,
		ring:       newRing(defaultScrollbackBytes),
		subs:       make(map[int]chan []byte),
		closeCh:    make(chan struct{}),
		done:       make(chan struct{}),
		statusPush: statusPush,
	}
	tempDir, err := seedSessionTemp(spec)
	if err != nil {
		return nil, fmt.Errorf("create private session temp directory: %w", err)
	}
	s.tempDir = tempDir
	s.spec.Env = append(s.spec.Env, "TMPDIR="+tempDir, "TMP="+tempDir, "TEMP="+tempDir)
	go s.runClaudeStream(append([]string(nil), spec.Command...))
	return s, nil
}

// runClaudeStream spawns the persistent claude process, keeps stdin OPEN, and pumps
// its ndjson stdout through the ACP bridge until the process exits. Mirrors runACP:
// same cwd/env/identity, stderr drained to /dev/null, ctx cancelled on Close().
func (s *Session) runClaudeStream(argv []string) {
	defer s.finalize()
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[flock-agentd] claude-stream session panic (%s): %v\n", s.spec.ID, r)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-s.closeCh:
			cancel()
		case <-ctx.Done():
		}
	}()

	// Resolve argv[0] to an ABSOLUTE path against the agent's augmented bin dirs
	// (same as the PTY path in session.go): exec.LookPath uses the DAEMON's minimal
	// $PATH and ignores cmd.Env, so a userland-installed CLI (~/.local/bin/claude on
	// a fresh node) would otherwise fail with "not found" here.
	cmd := exec.CommandContext(ctx, resolveExecutable(argv[0], homeForSpec(s.spec)), argv[1:]...)
	cmd.Dir = s.spec.Cwd
	cmd.Env = agentEnvironment(s.spec)
	if s.spec.Identity != nil {
		s.spec.Identity.Apply(cmd)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.claudeFail(err)
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.claudeFail(err)
		return
	}
	// Drain stderr so the process never blocks on a full pipe (its logs are noise here).
	if errPipe, perr := cmd.StderrPipe(); perr == nil {
		go func() { _, _ = bufio.NewReader(errPipe).WriteTo(discardWriter{}) }()
	}

	hookURL, hookToken := hookEndpointFromEnv(s.spec.Env)
	// Reuse acpState for chat forwarding + the assistant-prose accumulator so
	// renderACPEvent (the ACP path's renderer) works unchanged for us too.
	ast := &acpState{hookURL: hookURL, hookToken: hookToken}
	cst := &claudeState{stdin: stdin}

	s.mu.Lock()
	s.acp = ast
	s.claude = cst
	s.cmd = cmd
	s.mu.Unlock()

	if err := cmd.Start(); err != nil {
		s.claudeFail(err)
		return
	}

	s.broadcast([]byte("\x1b[2mReady — type a message and press Enter to prompt Claude.\x1b[0m\r\n\r\n"))
	s.pushStatus(status.Update{State: status.StateIdle})

	// Read loop: one JSON object per line. Assistant lines can be large, so give the
	// scanner a big buffer (the 64 KB default would truncate a long tool_use/result).
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		// CONTROL protocol first: a can_use_tool (or other) control_request is NOT part
		// of ParseLine's taxonomy (assistant/user/system/result), so intercept it here.
		// The cheap Contains guard avoids unmarshaling every large assistant line.
		if bytes.Contains(line, []byte(`"control_request"`)) && s.claudeHandleControl(cst, ast, line) {
			continue
		}
		// Map the line to canonical events and drive the SAME render + status + chat
		// path the ACP transport uses. (The current model rides in on the init line's
		// EventUsageUpdated, so no separate ParseInit push is needed.)
		for _, e := range claudestream.ParseLine(line) {
			if e.Kind == acp.EventError {
				// A turn-level error result (API overload / refusal / max-tokens). The
				// PERSISTENT process stays ALIVE and idle, so — unlike renderACPEvent's
				// fatal handling — flush any partial assistant prose (else it's lost
				// from Chat AND bleeds into the next turn's message), surface the error,
				// and return to idle so the session is immediately usable again.
				s.flushAssistantChat(ast)
				if e.Message != "" {
					s.broadcast([]byte("\r\n\x1b[31m[claude] " + toCRLF(e.Message) + "\x1b[0m\r\n"))
				}
				s.pushStatus(status.Update{State: status.StateIdle})
				continue
			}
			s.renderACPEvent(e)
		}
	}

	err = cmd.Wait()
	s.mu.Lock()
	s.exited = true
	s.exitCode = exitCodeOf(err)
	s.mu.Unlock()
}

func (s *Session) claudeFail(err error) {
	s.broadcast([]byte("\r\n\x1b[31m[claude-stream] " + err.Error() + "\x1b[0m\r\n"))
	s.pushStatus(status.Update{State: status.StateError})
	s.mu.Lock()
	s.exited = true
	s.mu.Unlock()
}

// claudeInput applies one input chunk: local line editing + echo, then on Enter
// EITHER answers a pending can_use_tool approval (y/n → control_response) or frames
// the line as one {"type":"user",…} turn on the persistent stdin. Mirrors acpInput
// (whose pending-approval path answers a y/n before it can be a prompt). The turn's
// assistant reply streams back on stdout and is flushed to Chat on the `result`
// boundary (renderACPEvent).
func (s *Session) claudeInput(p []byte) error {
	s.mu.Lock()
	cst := s.claude
	ast := s.acp
	s.mu.Unlock()
	if cst == nil {
		return nil
	}
	for _, b := range p {
		switch b {
		case '\r', '\n':
			s.broadcast([]byte("\r\n"))
			cst.mu.Lock()
			line := strings.TrimSpace(string(cst.line))
			cst.line = nil
			// Pop the OLDEST pending approval (if any) atomically under the lock.
			var pending *claudePending
			if len(cst.pending) > 0 {
				pending = cst.pending[0]
				cst.pending = cst.pending[1:]
			}
			remaining := len(cst.pending)
			cst.mu.Unlock()
			// A pending approval consumes this line as the y/n answer (never a prompt).
			if pending != nil {
				s.claudeAnswerApproval(cst, ast, pending, line, remaining)
				continue
			}
			if line == "" {
				continue
			}
			if ast != nil {
				s.postChat(ast, "user", line)
			}
			s.pushStatus(status.Update{State: status.StateRunning})
			if err := s.claudeSendTurn(cst, line); err != nil {
				s.broadcast([]byte("\r\n\x1b[31m[claude-stream] " + err.Error() + "\x1b[0m\r\n"))
				s.pushStatus(status.Update{State: status.StateError})
			}
		case 0x7f, 0x08: // backspace / delete
			cst.mu.Lock()
			if n := len(cst.line); n > 0 {
				cst.line = cst.line[:n-1]
				s.broadcast([]byte("\b \b"))
			}
			cst.mu.Unlock()
		default:
			cst.mu.Lock()
			cst.line = append(cst.line, b)
			cst.mu.Unlock()
			s.broadcast([]byte{b}) // local echo
		}
	}
	return nil
}

// claudeUserTurn is the stream-json user-turn frame written to claude's stdin.
type claudeUserTurn struct {
	Type    string             `json:"type"`
	Message claudeUserTurnBody `json:"message"`
}

type claudeUserTurnBody struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// claudeSendTurn JSON-encodes the text safely and writes exactly one turn line to
// the persistent stdin (serialized against concurrent turns via cst.mu).
func (s *Session) claudeSendTurn(cst *claudeState, text string) error {
	frame, err := json.Marshal(claudeUserTurn{
		Type:    "user",
		Message: claudeUserTurnBody{Role: "user", Content: text},
	})
	if err != nil {
		return err
	}
	frame = append(frame, '\n')
	cst.mu.Lock()
	defer cst.mu.Unlock()
	if cst.stdin == nil {
		return fmt.Errorf("process stdin closed")
	}
	_, err = cst.stdin.Write(frame)
	return err
}

// claudeControlRequest is a TOLERANT sniff of an inbound control_request line: only
// the fields we act on (type, request_id, request.subtype/tool_name/input). input is
// kept as json.RawMessage so it can be echoed back verbatim as updatedInput on allow.
// VERIFIED LIVE (claude 2.1.212): `--permission-prompt-tool stdio` makes Claude emit
//
//	{"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool",
//	  "tool_name":"Write","input":{…},"description":"…","permission_suggestions":[…],
//	  "tool_use_id":"…"}}
//
// on stdout for each gated tool; safe tools (e.g. Bash `echo`) are still auto-allowed
// by Claude's own engine and never reach us. No client `initialize` handshake is
// needed — the flag alone routes gated tools here.
type claudeControlRequest struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	Request   struct {
		Subtype  string          `json:"subtype"`
		ToolName string          `json:"tool_name"`
		Input    json.RawMessage `json:"input"`
	} `json:"request"`
}

// claudeHandleControl intercepts a control_request line. For can_use_tool it stores a
// PENDING approval (mirroring acpAwaitPermission: flip to awaiting_input, post the
// request.opened event the web's RequestCard renders, echo an approval prompt to
// scrollback) and returns; the operator's y/n later answers it via claudeInput. Any
// OTHER subtype gets a benign error control_response so Claude never hangs waiting.
// Returns true when the line was a control_request (so the read loop skips ParseLine).
func (s *Session) claudeHandleControl(cst *claudeState, ast *acpState, line []byte) bool {
	var ctrl claudeControlRequest
	if err := json.Unmarshal(line, &ctrl); err != nil || ctrl.Type != "control_request" {
		return false
	}
	if ctrl.Request.Subtype != "can_use_tool" {
		// Unsupported control subtype (mcp_message / hook_callback / etc.): reply with a
		// benign error so Claude never blocks — do NOT surface it to the user.
		if err := s.claudeSendControl(cst, claudeControlErrorFrame(ctrl.RequestID, "unsupported")); err != nil {
			fmt.Fprintf(os.Stderr, "[flock-agentd] claude-stream control reply (%s): %v\n", s.spec.ID, err)
		}
		return true
	}
	tool := ctrl.Request.ToolName
	if tool == "" {
		tool = "tool"
	}
	cst.mu.Lock()
	cst.pending = append(cst.pending, &claudePending{requestID: ctrl.RequestID, input: ctrl.Request.Input})
	cst.mu.Unlock()

	if ast != nil {
		body := map[string]any{
			"kind":        "request.opened",
			"requestId":   ctrl.RequestID,
			"requestKind": "permission",
			"title":       tool,
		}
		// json.RawMessage marshals verbatim, so the web gets the real tool input object
		// (capped well under the hook body limit, like tool.started's toolInput).
		if len(ctrl.Request.Input) > 0 && len(ctrl.Request.Input) <= maxToolFieldBytes {
			body["toolInput"] = ctrl.Request.Input
		}
		postAgentEvent(ast.hookURL, ast.hookToken, body)
	}
	s.broadcast([]byte("\r\n\x1b[33m⚠ Approve " + tool + "? reply 'y' to allow, 'n' to deny\x1b[0m\r\n"))
	s.pushStatus(status.Update{State: status.StateAwaiting})
	return true
}

// claudeAnswerApproval writes the control_response for a pending approval, clears the
// pending state, posts request.resolved, and returns the session to running. 'y'/'yes'/
// 'allow' (case-insensitive) allow; anything else (incl. an empty line) denies.
// The pending approval is already popped from the queue by the caller; `remaining`
// is the number of approvals still queued (so status stays awaiting_input while more
// are pending, else returns to running).
func (s *Session) claudeAnswerApproval(cst *claudeState, ast *acpState, pending *claudePending, line string, remaining int) {
	allow := claudeIsAllow(line)
	var frame claudeControlResponse
	if allow {
		frame = claudeAllowFrame(pending.requestID, pending.input)
	} else {
		frame = claudeDenyFrame(pending.requestID)
	}
	if err := s.claudeSendControl(cst, frame); err != nil {
		s.broadcast([]byte("\r\n\x1b[31m[claude-stream] " + err.Error() + "\x1b[0m\r\n"))
	}
	if ast != nil {
		postAgentEvent(ast.hookURL, ast.hookToken, map[string]any{
			"kind":      "request.resolved",
			"requestId": pending.requestID,
		})
	}
	verb := "denied"
	if allow {
		verb = "allowed"
	}
	s.broadcast([]byte("\x1b[2m" + verb + "\x1b[0m\r\n"))
	if remaining > 0 {
		s.pushStatus(status.Update{State: status.StateAwaiting}) // more approvals still queued
	} else {
		s.pushStatus(status.Update{State: status.StateRunning})
	}
}

// claudeIsAllow reports whether an operator answer means allow.
func claudeIsAllow(line string) bool {
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes", "allow":
		return true
	default:
		return false
	}
}

// claudeControlResponse is the stream-json control_response frame written to stdin.
// Response is the inner {subtype, request_id, response|error} object; it's an `any`
// because the success-decision and error variants differ in shape.
type claudeControlResponse struct {
	Type     string `json:"type"`
	Response any    `json:"response"`
}

// claudeAllowFrame builds the allow control_response, echoing the original tool input
// back as updatedInput (an allow with no updatedInput may be rejected).
func claudeAllowFrame(requestID string, input json.RawMessage) claudeControlResponse {
	return claudeControlResponse{
		Type: "control_response",
		Response: map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response": map[string]any{
				"behavior":     "allow",
				"updatedInput": input,
			},
		},
	}
}

// claudeDenyFrame builds the deny control_response.
func claudeDenyFrame(requestID string) claudeControlResponse {
	return claudeControlResponse{
		Type: "control_response",
		Response: map[string]any{
			"subtype":    "success",
			"request_id": requestID,
			"response": map[string]any{
				"behavior": "deny",
				"message":  "Denied by the operator.",
			},
		},
	}
}

// claudeControlErrorFrame builds an error control_response for an unsupported control
// subtype, so Claude never hangs waiting on a reply.
func claudeControlErrorFrame(requestID, msg string) claudeControlResponse {
	return claudeControlResponse{
		Type: "control_response",
		Response: map[string]any{
			"subtype":    "error",
			"request_id": requestID,
			"error":      msg,
		},
	}
}

// claudeSendControl JSON-encodes a control_response and writes exactly one line to the
// persistent stdin, serialized against turns via cst.mu (same lock as claudeSendTurn).
func (s *Session) claudeSendControl(cst *claudeState, frame claudeControlResponse) error {
	b, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	cst.mu.Lock()
	defer cst.mu.Unlock()
	if cst.stdin == nil {
		return fmt.Errorf("process stdin closed")
	}
	_, err = cst.stdin.Write(b)
	return err
}
