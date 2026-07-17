package session

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/billiondollarsolo/flock/agentd/internal/codexappserver"
	"github.com/billiondollarsolo/flock/agentd/internal/status"
)

// codexappserver_session.go — an interactive session over Codex's `codex app-server`
// structured transport instead of a raw PTY. Codex runs as a PERSISTENT JSON-RPC
// subprocess: the driver performs the handshake (initialize → thread/start), then each
// user turn is a turn/start request and the server streams item/* notifications
// (assistant messages, tool calls, reasoning) ending with turn/completed.
//
// Those notifications are mapped by codexappserver.codexItemToEvents onto the SAME
// canonical acp.Event taxonomy the ACP + claude-stream paths emit, so this driver
// REUSES the existing bridge wholesale: renderACPEvent (scrollback render + structured
// tool.started/tool.updated + chat forward) and acpEventToUpdate (status frames).
// Chat + tool cards + status therefore flow through the identical downstream pipeline
// — nothing new is invented here. Like the claude driver, it sets s.acp (reused for
// chat forwarding + the assistant-prose accumulator) so renderACPEvent works unchanged.
//
// Approvals ride Codex's server-REQUESTS (e.g. item/commandExecution/requestApproval,
// execCommandApproval): the read loop enqueues a pending approval + flips the session
// to awaiting_input + posts a request.opened event (the web's RequestCard), and the
// operator's y/n later REPLIES the server-request with the exact decision enum. This
// mirrors the claude-stream can_use_tool queue (claudeState.pending) exactly — same
// awaiting_input + RequestCard + queued-answer model, no new orchestrator endpoint.
//
// PTY remains the universal default (Invariant 1); this path is only taken for
// Spec.Mode == "codex-app-server".

// codexState holds the per-session codex-app-server runtime (nil for other sessions).
// It reuses acpState (via s.acp) for chat forwarding + the assistant-prose accumulator,
// so renderACPEvent works unchanged; this struct adds the JSON-RPC conn, the thread id,
// the local line-edit buffer, and the FIFO approval queue.
type codexState struct {
	mu       sync.Mutex
	conn     *codexappserver.Conn
	threadID string
	line     []byte // the in-progress input line (local echo + edit)
	// FIFO queue of approval server-requests awaiting a y/n answer. A single turn can
	// issue MULTIPLE gated actions; every one must get a Reply or the server hangs.
	// Answers are consumed oldest-first.
	pending []*codexPending
}

// codexPending is an in-flight approval: the server-request id to Reply against, the
// decision family (which enum to use), and a human label for the prompt.
type codexPending struct {
	serverRequestID int64
	family          approvalFamily
	label           string
}

// approvalFamily selects the decision enum shape for an approval reply. Codex exposes
// two families across its approval server-requests (verified against the version-exact
// schema): the v2 item/*/requestApproval methods use accept/decline; the legacy
// exec/patch approval methods use a ReviewDecision (approved/denied).
type approvalFamily int

const (
	familyV2 approvalFamily = iota // {"decision":"accept"|"decline"}
	familyV1                       // {"decision":"approved"|"denied"}
)

// OpenCodexAppServer starts a codex-app-server-mode session. statusPush wires derived
// status to the manager (analog of OpenACP / OpenClaudeStream). spec.Command must be
// the codex app-server launch argv (e.g. {"codex","app-server"}).
func OpenCodexAppServer(spec Spec, statusPush func(status.Update)) (*Session, error) {
	if len(spec.Command) == 0 {
		return nil, fmt.Errorf("codex-app-server session %s: no launch command", spec.ID)
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
	go s.runCodexAppServer(append([]string(nil), spec.Command...))
	return s, nil
}

// runCodexAppServer spawns the persistent codex process, wires the JSON-RPC Conn, runs
// the handshake, and pumps notifications through the ACP bridge until the process
// exits. Mirrors runClaudeStream: same cwd/env/identity, stderr drained (the
// app-server logs a harmless bubblewrap warning there), ctx cancelled on Close().
func (s *Session) runCodexAppServer(argv []string) {
	defer s.finalize()
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[flock-agentd] codex-app-server session panic (%s): %v\n", s.spec.ID, r)
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

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = s.spec.Cwd
	cmd.Env = agentEnvironment(s.spec)
	if s.spec.Identity != nil {
		s.spec.Identity.Apply(cmd)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.codexFail(err)
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.codexFail(err)
		return
	}
	// Drain stderr so the process never blocks on a full pipe (bubblewrap warning + logs).
	if errPipe, perr := cmd.StderrPipe(); perr == nil {
		go func() { _, _ = bufio.NewReader(errPipe).WriteTo(discardWriter{}) }()
	}

	hookURL, hookToken := hookEndpointFromEnv(s.spec.Env)
	// Reuse acpState for chat forwarding + the assistant-prose accumulator so
	// renderACPEvent (the ACP path's renderer) works unchanged for us too.
	ast := &acpState{hookURL: hookURL, hookToken: hookToken}
	cst := &codexState{}
	conn := codexappserver.NewConn(stdout, stdin, codexappserver.Handlers{
		OnNotification: s.codexNotification,
		OnServerRequest: func(id int64, method string, params json.RawMessage) {
			s.codexServerRequest(cst, ast, id, method, params)
		},
	})
	cst.conn = conn

	s.mu.Lock()
	s.acp = ast
	s.codex = cst
	s.cmd = cmd
	s.mu.Unlock()

	if err := cmd.Start(); err != nil {
		s.codexFail(err)
		return
	}
	go func() { _ = conn.Run(ctx) }()

	s.broadcast([]byte("\x1b[2mConnecting to Codex over app-server…\x1b[0m\r\n"))
	if err := conn.Initialize(ctx); err != nil {
		s.codexFail(err)
		return
	}
	threadID, err := conn.ThreadStart(ctx, s.spec.Cwd)
	if err != nil {
		s.codexFail(err)
		return
	}
	cst.mu.Lock()
	cst.threadID = threadID
	cst.mu.Unlock()

	s.broadcast([]byte("\x1b[2mReady — type a message and press Enter to prompt Codex.\x1b[0m\r\n\r\n"))
	s.pushStatus(status.Update{State: status.StateIdle})

	err = cmd.Wait()
	s.mu.Lock()
	s.exited = true
	s.exitCode = exitCodeOf(err)
	s.mu.Unlock()
}

func (s *Session) codexFail(err error) {
	s.broadcast([]byte("\r\n\x1b[31m[codex-app-server] " + err.Error() + "\x1b[0m\r\n"))
	s.pushStatus(status.Update{State: status.StateError})
	s.mu.Lock()
	s.exited = true
	s.mu.Unlock()
}

// codexNotification maps one streaming notification to canonical events and drives the
// SAME render + status + chat path the ACP/claude transports use. Unhandled methods
// yield no events (tolerant).
func (s *Session) codexNotification(method string, params json.RawMessage) {
	// A turn ERROR with an approval still queued means codex abandoned that gated action
	// (a normal turn/completed only arrives AFTER approvals are answered, so the queue is
	// already empty then). Drain the stale approvals — reply decline so the server isn't
	// left waiting, resolve the card — so the operator's next line is a prompt, not
	// silently eaten as a y/n answer for a dead request.
	if method == "error" {
		s.codexDrainStaleApprovals()
	}
	for _, e := range codexappserver.CodexItemToEvents(method, params) {
		s.renderACPEvent(e)
	}
}

// codexDrainStaleApprovals declines + resolves every still-queued approval (used when a
// turn ends without them being answered).
func (s *Session) codexDrainStaleApprovals() {
	s.mu.Lock()
	cst := s.codex
	ast := s.acp
	s.mu.Unlock()
	if cst == nil {
		return
	}
	cst.mu.Lock()
	stale := cst.pending
	cst.pending = nil
	cst.mu.Unlock()
	for _, p := range stale {
		cst.conn.Reply(p.serverRequestID, codexDecision(p.family, false), nil)
		if ast != nil {
			postAgentEvent(ast.hookURL, ast.hookToken, map[string]any{
				"kind":      "request.resolved",
				"requestId": fmt.Sprintf("%d", p.serverRequestID),
			})
		}
	}
}

// codexInput applies one input chunk: local line editing + echo, then on Enter EITHER
// answers the oldest pending approval (y/n → Reply) or submits the line as a turn/start.
// Mirrors claudeInput.
func (s *Session) codexInput(p []byte) error {
	s.mu.Lock()
	cst := s.codex
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
			threadID := cst.threadID
			// Pop the OLDEST pending approval (if any) atomically under the lock.
			var pending *codexPending
			if len(cst.pending) > 0 {
				pending = cst.pending[0]
				cst.pending = cst.pending[1:]
			}
			remaining := len(cst.pending)
			cst.mu.Unlock()
			// A pending approval consumes this line as the y/n answer (never a prompt).
			if pending != nil {
				s.codexAnswerApproval(cst, ast, pending, line, remaining)
				continue
			}
			if line == "" {
				continue
			}
			if ast != nil {
				s.postChat(ast, "user", line)
			}
			s.pushStatus(status.Update{State: status.StateRunning})
			// turn/start blocks until the server acknowledges (and may span the whole
			// turn), so submit it off the input path; status returns to idle on the
			// turn/completed notification (renderACPEvent).
			go s.codexSendTurn(cst, threadID, line)
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

// codexSendTurn submits one user turn over the JSON-RPC conn.
func (s *Session) codexSendTurn(cst *codexState, threadID, text string) {
	if threadID == "" {
		s.broadcast([]byte("\r\n\x1b[31m[codex-app-server] no thread started yet\x1b[0m\r\n"))
		s.pushStatus(status.Update{State: status.StateError})
		return
	}
	if err := cst.conn.TurnStart(context.Background(), threadID, text); err != nil {
		s.broadcast([]byte("\r\n\x1b[31m[codex-app-server] " + err.Error() + "\x1b[0m\r\n"))
		s.pushStatus(status.Update{State: status.StateError})
	}
}

// codexServerRequest handles an inbound server-REQUEST. Approval methods enqueue a
// pending approval (flip to awaiting_input + post the request.opened the RequestCard
// renders) and defer the Reply until the operator answers via codexInput. Every other
// server-request (tool user-input, mcp elicitation, permissions, …) gets an immediate
// benign default Reply so the server never hangs on a method we don't drive.
func (s *Session) codexServerRequest(cst *codexState, ast *acpState, id int64, method string, params json.RawMessage) {
	family, isApproval := codexApprovalFamily(method)
	if !isApproval {
		// Benign default for server-requests we don't drive (elicitation, tool input,
		// dynamic tool calls): reply the SCHEMA-VALID "grant nothing / decline" shape so
		// the server proceeds without blocking OR erroring on a malformed reply. Not
		// surfaced to the user.
		cst.conn.Reply(id, codexBenignReply(method), nil)
		return
	}
	label := codexApprovalLabel(method, params)
	cst.mu.Lock()
	cst.pending = append(cst.pending, &codexPending{serverRequestID: id, family: family, label: label})
	cst.mu.Unlock()

	if ast != nil {
		body := map[string]any{
			"kind":        "request.opened",
			"requestId":   fmt.Sprintf("%d", id),
			"requestKind": "permission",
			"title":       label,
		}
		// Echo the real approval params as the card's tool input (capped under the hook
		// body limit, like claude's can_use_tool input / tool.started's toolInput).
		if len(params) > 0 && len(params) <= maxToolFieldBytes {
			body["toolInput"] = params
		}
		postAgentEvent(ast.hookURL, ast.hookToken, body)
	}
	s.broadcast([]byte("\r\n\x1b[33m⚠ Approve " + label + "? reply 'y' to allow, 'n' to deny\x1b[0m\r\n"))
	s.pushStatus(status.Update{State: status.StateAwaiting})
}

// codexAnswerApproval replies the pending approval server-request with the exact
// decision enum for its family, posts request.resolved, and returns the session to
// running (or stays awaiting while more approvals are queued). 'y'/'yes'/'allow'
// allow; anything else (incl. empty) denies. Mirrors claudeAnswerApproval.
func (s *Session) codexAnswerApproval(cst *codexState, ast *acpState, pending *codexPending, line string, remaining int) {
	allow := claudeIsAllow(line) // shared allow-word check (y/yes/allow)
	cst.conn.Reply(pending.serverRequestID, codexDecision(pending.family, allow), nil)

	if ast != nil {
		postAgentEvent(ast.hookURL, ast.hookToken, map[string]any{
			"kind":      "request.resolved",
			"requestId": fmt.Sprintf("%d", pending.serverRequestID),
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

// codexBenignReply returns a schema-valid "no-op" reply for a server-request we don't
// drive, so codex neither blocks nor errors on a malformed response. item/permissions/
// requestApproval requires a `permissions` array (grant nothing → []); everything else
// accepts an empty object.
func codexBenignReply(method string) json.RawMessage {
	switch method {
	case "item/permissions/requestApproval":
		return json.RawMessage(`{"permissions":[]}`)
	default:
		return json.RawMessage(`{}`)
	}
}

// codexDecision builds the {"decision":…} reply body for an approval, choosing the
// enum value from the family + allow/deny. Verified against the version-exact schema:
// familyV2 (item/*/requestApproval) → accept/decline; familyV1 (exec/patch approval,
// ReviewDecision) → approved/denied.
func codexDecision(family approvalFamily, allow bool) map[string]any {
	var decision string
	switch family {
	case familyV1:
		decision = "denied"
		if allow {
			decision = "approved"
		}
	default: // familyV2
		decision = "decline"
		if allow {
			decision = "accept"
		}
	}
	return map[string]any{"decision": decision}
}

// codexApprovalFamily reports whether a server-request method is an approval we route
// to the operator, and which decision enum it expects.
func codexApprovalFamily(method string) (approvalFamily, bool) {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		return familyV2, true
	case "execCommandApproval", "applyPatchApproval":
		return familyV1, true
	default:
		return familyV2, false
	}
}

// codexApprovalLabel derives a short human label for the approval prompt from the
// request params (the command being run, or a generic fallback per method).
func codexApprovalLabel(method string, params json.RawMessage) string {
	var p struct {
		Command any    `json:"command"` // string (v2) or []string (v1)
		Reason  string `json:"reason"`
	}
	_ = json.Unmarshal(params, &p)
	switch cmd := p.Command.(type) {
	case string:
		if cmd != "" {
			return cmd
		}
	case []any:
		parts := make([]string, 0, len(cmd))
		for _, c := range cmd {
			if str, ok := c.(string); ok {
				parts = append(parts, str)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, " ")
		}
	}
	switch method {
	case "item/fileChange/requestApproval", "applyPatchApproval":
		return "file change"
	default:
		return "command"
	}
}
