package session

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"flock-agentd/internal/acp"
	"flock-agentd/internal/status"
)

// acp_session.go — an interactive session over the structured Agent Client
// Protocol transport (roadmap F6) instead of a raw PTY. The agent runs as a
// JSON-RPC-over-stdio subprocess; its streamed output is rendered into the same
// scrollback/subscriber broadcast the PTY path uses (so the terminal pane shows
// the conversation), and its status/telemetry flow through the manager via
// statusPush. Typed input is line-edited and sent as a `session/prompt` turn —
// or, while the agent is blocked on approval, a `y`/`n` answers the prompt
// (so the existing RespondBar drives ACP approvals with no extra plumbing).
//
// PTY remains the universal default (Invariant 1); this path is only taken for
// Spec.Mode == "acp".

// acpState holds the per-session ACP runtime (nil for PTY sessions).
type acpState struct {
	conn      *acp.Conn
	mu        sync.Mutex
	sessionID string
	line      []byte      // the in-progress input line (local echo + edit)
	pending   chan string // non-nil while an approval is awaiting an answer
	options   []acp.PermissionOption
	// Structured-chat forwarding: whole messages are POSTed to Flock's hook
	// endpoint (persistent, addressable event log → the web Chat tab), NOT the
	// status hot path. hookURL already contains the session path segment.
	hookURL   string
	hookToken string
	assistant []byte // accumulated assistant text for the current turn (flush on boundary)
}

// OpenACP starts an ACP-mode session. statusPush wires derived status to the
// manager. spec.Command must be the ACP launch argv (the orchestrator sets it
// from acp.LaunchCommand).
func OpenACP(spec Spec, statusPush func(status.Update)) (*Session, error) {
	if len(spec.Command) == 0 {
		return nil, fmt.Errorf("acp session %s: no launch command", spec.ID)
	}
	s := &Session{
		spec:       spec,
		ring:       newRing(defaultScrollbackBytes),
		subs:       make(map[int]chan []byte),
		closeCh:    make(chan struct{}),
		done:       make(chan struct{}),
		statusPush: statusPush,
	}
	go s.runACP(append([]string(nil), spec.Command...))
	return s, nil
}

func (s *Session) pushStatus(u status.Update) {
	if s.statusPush != nil {
		s.statusPush(u)
	}
}

// runACP spawns the agent, performs the ACP handshake, and pumps events until the
// process exits. Prompts are driven by acpInput (typed via Write).
func (s *Session) runACP(argv []string) {
	defer s.finalize()
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "[flock-agentd] acp session panic (%s): %v\n", s.spec.ID, r)
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
		s.acpFail(err)
		return
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		s.acpFail(err)
		return
	}
	// Drain stderr so the agent never blocks on a full pipe (its logs are noise here).
	if errPipe, perr := cmd.StderrPipe(); perr == nil {
		go func() { _, _ = bufio.NewReader(errPipe).WriteTo(discardWriter{}) }()
	}

	hookURL, hookToken := hookEndpointFromEnv(s.spec.Env)
	ast := &acpState{hookURL: hookURL, hookToken: hookToken}
	conn := acp.NewConn(stdout, stdin, acp.Handlers{
		OnUpdate:     s.renderACPEvent,
		OnPermission: func(req acp.PermissionRequest) string { return s.acpAwaitPermission(ast, req) },
	})
	ast.conn = conn

	s.mu.Lock()
	s.acp = ast
	s.cmd = cmd
	s.mu.Unlock()

	if err := cmd.Start(); err != nil {
		s.acpFail(err)
		return
	}
	go func() { _ = conn.Run(ctx) }()

	s.broadcast([]byte("\x1b[2mConnecting to agent over ACP…\x1b[0m\r\n"))
	if err := conn.Initialize(ctx); err != nil {
		s.acpFail(err)
		return
	}
	// Give the ACP agent the flock orchestration tools (auto-discovered via MCP).
	sid, err := conn.NewSession(
		ctx,
		s.spec.Cwd,
		acpFlockMcpServers(hookURL, hookToken, homeForSpec(s.spec), s.spec.Identity),
	)
	if err != nil {
		s.acpFail(err)
		return
	}
	ast.mu.Lock()
	ast.sessionID = sid
	ast.mu.Unlock()
	s.broadcast([]byte("\x1b[2mReady — type a message and press Enter to prompt the agent.\x1b[0m\r\n\r\n"))
	s.pushStatus(status.Update{State: status.StateIdle})

	err = cmd.Wait()
	s.mu.Lock()
	s.exited = true
	s.exitCode = exitCodeOf(err)
	s.mu.Unlock()
}

func (s *Session) acpFail(err error) {
	s.broadcast([]byte("\r\n\x1b[31m[acp] " + err.Error() + "\x1b[0m\r\n"))
	s.pushStatus(status.Update{State: status.StateError})
	s.mu.Lock()
	s.exited = true
	s.mu.Unlock()
}

// renderACPEvent renders a structured event into the terminal stream + pushes
// derived status/telemetry.
func (s *Session) renderACPEvent(e acp.Event) {
	ast := s.acp
	switch e.Kind {
	case acp.EventContentDelta:
		text := toCRLF(e.Text)
		if e.StreamKind == "reasoning_text" {
			text = "\x1b[2m" + text + "\x1b[0m"
		} else if ast != nil {
			// Accumulate assistant prose for the structured Chat tab (flushed as a
			// whole message on a tool/turn boundary — never per-delta, to keep the
			// event log low-volume).
			ast.mu.Lock()
			ast.assistant = append(ast.assistant, e.Text...)
			ast.mu.Unlock()
		}
		s.broadcast([]byte(text))
	case acp.EventToolStarted:
		if ast != nil {
			s.flushAssistantChat(ast)
			if e.ToolName != "" {
				s.postChat(ast, "tool", e.ToolName)
			}
		}
		if e.ToolName != "" {
			s.broadcast([]byte("\r\n\x1b[36m• " + e.ToolName + "\x1b[0m\r\n"))
		}
	case acp.EventTurnCompleted:
		if ast != nil {
			s.flushAssistantChat(ast)
		}
		s.broadcast([]byte("\r\n"))
	}
	if u, ok := acpEventToUpdate(e); ok {
		s.pushStatus(u)
	}
}

// acpAwaitPermission flips the session to awaiting_input and blocks until the
// user answers (via acpInput) or the session closes.
func (s *Session) acpAwaitPermission(ast *acpState, req acp.PermissionRequest) string {
	ch := make(chan string, 1)
	ast.mu.Lock()
	ast.pending = ch
	ast.options = req.Options
	ast.mu.Unlock()

	title := req.Title
	if title == "" {
		title = "approval"
	}
	s.broadcast([]byte("\r\n\x1b[33m⚠ Agent needs approval: " + title + " — reply 'y' to allow, 'n' to deny\x1b[0m\r\n"))
	s.pushStatus(status.Update{State: status.StateAwaiting})

	var decision string
	select {
	case decision = <-ch:
	case <-s.closeCh:
	}
	ast.mu.Lock()
	ast.pending = nil
	ast.options = nil
	ast.mu.Unlock()
	s.pushStatus(status.Update{State: status.StateRunning})
	return decision
}

// acpInput applies one input chunk: local line editing + echo, then on Enter
// either answers a pending approval (y/n) or sends the line as a prompt turn.
func (s *Session) acpInput(p []byte) error {
	s.mu.Lock()
	ast := s.acp
	s.mu.Unlock()
	if ast == nil {
		return nil
	}
	for _, b := range p {
		switch b {
		case '\r', '\n':
			s.broadcast([]byte("\r\n"))
			ast.mu.Lock()
			line := strings.TrimSpace(string(ast.line))
			ast.line = nil
			pending := ast.pending
			opts := ast.options
			sid := ast.sessionID
			ast.mu.Unlock()
			if pending != nil {
				decision := ""
				if len(opts) > 0 && strings.HasPrefix(strings.ToLower(line), "y") {
					decision = opts[0].OptionID
				}
				select {
				case pending <- decision:
				default:
				}
				continue
			}
			if line == "" {
				continue
			}
			s.postChat(ast, "user", line)
			go s.acpPrompt(ast.conn, sid, line)
		case 0x7f, 0x08: // backspace / delete
			ast.mu.Lock()
			if n := len(ast.line); n > 0 {
				ast.line = ast.line[:n-1]
				s.broadcast([]byte("\b \b"))
			}
			ast.mu.Unlock()
		default:
			ast.mu.Lock()
			ast.line = append(ast.line, b)
			ast.mu.Unlock()
			s.broadcast([]byte{b}) // local echo
		}
	}
	return nil
}

func (s *Session) acpPrompt(conn *acp.Conn, sessionID, text string) {
	s.pushStatus(status.Update{State: status.StateRunning})
	err := conn.Prompt(context.Background(), sessionID, text)
	// The turn ends when Prompt RETURNS (the response), not via a session/update —
	// so flush the accumulated assistant prose here (the EventTurnCompleted update
	// many agents never send). This is what lands the assistant's reply in Chat.
	if ast := s.acp; ast != nil {
		s.flushAssistantChat(ast)
	}
	if err != nil {
		s.broadcast([]byte("\r\n\x1b[31m[acp] " + err.Error() + "\x1b[0m\r\n"))
		s.pushStatus(status.Update{State: status.StateError})
		return
	}
	s.pushStatus(status.Update{State: status.StateIdle})
}

// flushAssistantChat posts the accumulated assistant prose for the turn as one
// chat message, then clears the buffer. Lock-safe: the buffer is appended from the
// ACP read goroutine (renderACPEvent) and flushed from the prompt goroutine.
func (s *Session) flushAssistantChat(ast *acpState) {
	ast.mu.Lock()
	if len(ast.assistant) == 0 {
		ast.mu.Unlock()
		return
	}
	text := string(ast.assistant)
	ast.assistant = nil
	ast.mu.Unlock()
	s.postChat(ast, "assistant", text)
}

func (s *Session) postChat(ast *acpState, role, text string) {
	postChatEvent(ast.hookURL, ast.hookToken, role, text)
}

// postChatEvent forwards one whole chat message to Flock's hook endpoint, where it
// is persisted in the per-session event log (addressable → the web Chat tab). Off
// the status hot path; fire-and-forget so it never blocks the agent stream. Used by
// BOTH the ACP session and the transcript watchers (claude/codex), so a native
// session gets the same structured Chat log without ACP.
func postChatEvent(hookURL, hookToken, role, text string) {
	if hookURL == "" || text == "" {
		return
	}
	body, err := json.Marshal(map[string]any{
		"chat": map[string]string{"role": role, "text": text},
	})
	if err != nil {
		return
	}
	go func() {
		req, rerr := http.NewRequest(http.MethodPost, hookURL, bytes.NewReader(body))
		if rerr != nil {
			return
		}
		req.Header.Set("content-type", "application/json")
		if hookToken != "" {
			req.Header.Set("authorization", "Bearer "+hookToken)
		}
		client := &http.Client{Timeout: 5 * time.Second}
		if resp, derr := client.Do(req); derr == nil {
			_ = resp.Body.Close()
		}
	}()
}

// hookEndpointFromEnv pulls FLOCK_HOOK_URL / FLOCK_HOOK_TOKEN out of the session
// env (the same vars the agent itself gets), so the daemon can post chat events.
func hookEndpointFromEnv(env []string) (url, token string) {
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "FLOCK_HOOK_URL="); ok {
			url = v
		} else if v, ok := strings.CutPrefix(kv, "FLOCK_HOOK_TOKEN="); ok {
			token = v
		}
	}
	return url, token
}

// toCRLF makes agent text safe for a terminal (bare LF → CRLF).
func toCRLF(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\n", "\r\n")
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
