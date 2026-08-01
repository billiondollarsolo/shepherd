package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/billiondollarsolo/shep-tui/internal/backend"
	"github.com/billiondollarsolo/shep-tui/internal/backend/dial"
	"github.com/billiondollarsolo/shep-tui/internal/config"
	"github.com/billiondollarsolo/shep-tui/internal/domain"
	"github.com/billiondollarsolo/shep-tui/internal/launch"
)

// sessions dispatches `shep-tui sessions <sub>`.
func sessions(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: shep-tui sessions list|spawn|launch|wait|send|export|explain|prompt …")
	}
	switch args[0] {
	case "list":
		return sessionsList()
	case "spawn":
		return sessionsSpawn(args[1:])
	case "launch":
		return sessionsLaunch(args[1:])
	case "wait":
		return sessionsWait(args[1:])
	case "send":
		return sessionsSend(args[1:])
	case "export":
		return sessionsExport(args[1:])
	case "explain":
		return sessionsExplain(args[1:])
	case "prompt":
		return sessionsPrompt(args[1:])
	case "help", "--help", "-h":
		fmt.Fprintln(os.Stdout, sessionsHelpText())
		return nil
	default:
		return fmt.Errorf("unknown sessions subcommand %q (try: shep-tui sessions help)", args[0])
	}
}

// sessionsHelpText is the sessions subcommand usage (also asserted in tests).
func sessionsHelpText() string {
	return `usage:
  shep-tui sessions list
  shep-tui sessions spawn [name]
  shep-tui sessions launch --agent claude|codex|opencode|gemini|grok|shell [--cwd DIR] [--id ID]
  shep-tui sessions wait <id> --for idle|done|needs-you [--timeout 30s]
  shep-tui sessions explain <id>
  shep-tui sessions prompt <id> --text <payload>
  shep-tui sessions send <id> --text <payload>
  shep-tui sessions export <id>

Agent control (when agentd advertises agent_control_v1):
  explain  statusExplain — matched rule / why status is what it is
  prompt   session.prompt — inject text+Enter without raw PTY attach
  wait     session.wait_status server-side when capable; else poll status`
}

func sessionsList() error {
	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := be.ListSessions(ctx)
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}

	if len(list) == 0 {
		fmt.Println("(no sessions)")
		return nil
	}
	for _, s := range list {
		kind := string(s.AgentType)
		if kind == "" {
			kind = "-"
		}
		cwd := s.Cwd
		if cwd == "" {
			cwd = "-"
		}
		st := string(s.Status)
		if st == "" {
			st = "-"
		}
		fmt.Printf("%-28s %-10s %-14s %s\n", s.ID, kind, st, cwd)
	}
	return nil
}

// sessionsLaunch: shep-tui sessions launch --agent claude [--cwd DIR] [--id ID]
func sessionsLaunch(args []string) error {
	agentStr := ""
	cwd := ""
	id := ""
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--agent", "-a":
			if i+1 >= len(args) {
				return fmt.Errorf("sessions launch: --agent requires a value")
			}
			i++
			agentStr = args[i]
		case "--cwd", "-C":
			if i+1 >= len(args) {
				return fmt.Errorf("sessions launch: --cwd requires a value")
			}
			i++
			cwd = args[i]
		case "--id":
			if i+1 >= len(args) {
				return fmt.Errorf("sessions launch: --id requires a value")
			}
			i++
			id = args[i]
		case "--help", "-h":
			fmt.Fprintln(os.Stdout, "usage: shep-tui sessions launch --agent claude|codex|opencode|gemini|grok|shell [--cwd DIR] [--id ID]")
			return nil
		default:
			if !strings.HasPrefix(args[i], "-") && agentStr == "" {
				agentStr = args[i]
			} else {
				return fmt.Errorf("sessions launch: unknown arg %q", args[i])
			}
		}
	}
	if agentStr == "" {
		return fmt.Errorf("sessions launch: --agent is required (claude|codex|opencode|gemini|grok|shell)")
	}
	agent, err := launch.ParseAgent(agentStr)
	if err != nil {
		return err
	}
	res, err := launch.Build(launch.Spec{Agent: agent, Cwd: cwd, SessionID: id})
	if err != nil {
		return err
	}

	be, err := openBackend(15 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := be.LaunchAgent(ctx, res.ID, res.Kind, res.Cwd, res.Command, res.Cols, res.Rows); err != nil {
		if errors.Is(err, backend.ErrNotSupported) {
			return fmt.Errorf("sessions launch: not supported on this backend (standalone local agentd required): %w", err)
		}
		return fmt.Errorf("sessions launch: %w", err)
	}
	fmt.Println(res.ID)
	return nil
}

func sessionsSpawn(args []string) error {
	id := ""
	if len(args) > 0 {
		id = args[0]
	}
	if id == "" {
		id = fmt.Sprintf("shep-tui-shell-%d", time.Now().UnixNano())
	}

	be, err := openBackend(15 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := be.CreateShell(ctx, id, "", 80, 24); err != nil {
		if errors.Is(err, backend.ErrNotSupported) {
			return fmt.Errorf("spawn shell: not supported by this backend (fleet create not wired yet)")
		}
		return fmt.Errorf("spawn shell: %w", err)
	}
	fmt.Println(id)
	return nil
}

// sessionsWait waits until session matches --for.
// Prefer server-side session.wait_status when backend implements AgentController
// with agent_control_v1; otherwise poll list / status watch.
//
//	shep-tui sessions wait <id> --for idle|done|needs-you [--timeout 30s]
func sessionsWait(args []string) error {
	id, want, timeout, err := parseWaitArgs(args)
	if err != nil {
		return err
	}

	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()
	return sessionsWaitOn(be, id, want, timeout)
}

// sessionsWaitOn is the testable wait path (real CLI opens backend then calls this).
func sessionsWaitOn(be backend.Backend, id, want string, timeout time.Duration) error {
	// Prefer agentd server-side wait when capable (H2.4).
	if ac, ok := be.(backend.AgentController); ok && ac.HasAgentControl() {
		until := waitUntilWire(want)
		ctx, cancel := context.WithTimeout(context.Background(), timeout+5*time.Second)
		defer cancel()
		state, err := ac.SessionWaitStatus(ctx, id, until, timeout)
		if err == nil {
			fmt.Printf("%s\t%s\n", id, state)
			return nil
		}
		if !errors.Is(err, backend.ErrNotSupported) {
			// Real server error / timeout — do not silently switch dialects.
			return err
		}
		// Cap claimed but wait not supported: fall through to poll.
	}

	// Prefer live status stream when available; fall back to list polling.
	watchCtx, watchCancel := context.WithTimeout(context.Background(), timeout)
	defer watchCancel()
	statusCh, watchErr := be.WatchStatus(watchCtx)
	if watchErr != nil {
		statusCh = nil
	}

	// Seed from list.
	if st, ok, err := sessionStatus(be, id); err != nil {
		return err
	} else if ok && statusMatches(st, want) {
		fmt.Printf("%s\t%s\n", id, st)
		return nil
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-watchCtx.Done():
			return waitTimeoutErr(id, want, timeout)
		case u, ok := <-statusCh:
			// When statusCh is nil, this case is disabled by the Go select rules.
			if !ok {
				statusCh = nil
				continue
			}
			if u.SessionID == id && statusMatches(u.Status, want) {
				fmt.Printf("%s\t%s\n", id, u.Status)
				return nil
			}
		case <-ticker.C:
			if st, ok, err := sessionStatus(be, id); err != nil {
				return err
			} else if ok && statusMatches(st, want) {
				fmt.Printf("%s\t%s\n", id, st)
				return nil
			}
		}
	}
}

// waitUntilWire maps CLI --for tokens to agentd wait_status wire states.
func waitUntilWire(want string) []string {
	switch strings.ToLower(strings.TrimSpace(want)) {
	case "idle":
		return []string{"idle"}
	case "done":
		return []string{"done"}
	case "needs-you", "needs_you", "awaiting_input", "awaiting-input":
		return []string{"awaiting_input"}
	default:
		return []string{want}
	}
}

// sessionsExplain prints statusExplain JSON for a session (agent_control / screendetect).
//
//	shep-tui sessions explain <id>
func sessionsExplain(args []string) error {
	id, err := parseExplainArgs(args)
	if err != nil {
		return err
	}
	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()
	return sessionsExplainOn(be, id)
}

func sessionsExplainOn(be backend.Backend, id string) error {
	ac, ok := be.(backend.AgentController)
	if !ok {
		return fmt.Errorf("sessions explain: backend does not support agent control (need local agentd with agent_control_v1/screendetect_v1)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := ac.SessionExplain(ctx, id)
	if err != nil {
		return fmt.Errorf("sessions explain: %w", err)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}

func parseExplainArgs(args []string) (id string, err error) {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--help" || a == "-h":
			return "", fmt.Errorf("usage: shep-tui sessions explain <id>")
		case strings.HasPrefix(a, "-"):
			return "", fmt.Errorf("sessions explain: unknown flag %q", a)
		default:
			if id == "" {
				id = a
			} else {
				return "", fmt.Errorf("sessions explain: unexpected arg %q", a)
			}
		}
	}
	if id == "" {
		return "", fmt.Errorf("usage: shep-tui sessions explain <id>")
	}
	return id, nil
}

// sessionsPrompt injects text+Enter via session.prompt when capable.
//
//	shep-tui sessions prompt <id> --text <payload>
func sessionsPrompt(args []string) error {
	id, text, err := parsePromptArgs(args)
	if err != nil {
		return err
	}
	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()
	return sessionsPromptOn(be, id, text)
}

func sessionsPromptOn(be backend.Backend, id, text string) error {
	ac, ok := be.(backend.AgentController)
	if !ok {
		return fmt.Errorf("sessions prompt: backend does not support agent control (try: sessions send <id> --text … for raw PTY)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := ac.SessionPrompt(ctx, id, text); err != nil {
		return fmt.Errorf("sessions prompt: %w", err)
	}
	fmt.Printf("prompted %s (%d bytes)\n", id, len(text))
	return nil
}

func parsePromptArgs(args []string) (id, text string, err error) {
	var textSet bool
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--help" || a == "-h":
			return "", "", fmt.Errorf("usage: shep-tui sessions prompt <id> --text <payload>")
		case a == "--text" && i+1 < len(args):
			i++
			text = args[i]
			textSet = true
		case strings.HasPrefix(a, "--text="):
			text = strings.TrimPrefix(a, "--text=")
			textSet = true
		case strings.HasPrefix(a, "-"):
			return "", "", fmt.Errorf("sessions prompt: unknown flag %q", a)
		default:
			if id == "" {
				id = a
			} else {
				return "", "", fmt.Errorf("sessions prompt: unexpected arg %q", a)
			}
		}
	}
	if id == "" || !textSet {
		return "", "", fmt.Errorf("usage: shep-tui sessions prompt <id> --text <payload>")
	}
	return id, text, nil
}

func waitTimeoutErr(id, want string, timeout time.Duration) error {
	return fmt.Errorf("sessions wait: timeout after %s waiting for %s to be %s", timeout, id, want)
}

func sessionStatus(be backend.Backend, id string) (domain.Status, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	list, err := be.ListSessions(ctx)
	if err != nil {
		return "", false, fmt.Errorf("list sessions: %w", err)
	}
	for _, s := range list {
		if s.ID == id {
			return s.Status, true, nil
		}
	}
	return "", false, nil
}

// statusMatches maps --for tokens to domain.Status values.
func statusMatches(st domain.Status, want string) bool {
	switch strings.ToLower(strings.TrimSpace(want)) {
	case "idle":
		return st == domain.StatusIdle
	case "done":
		return st == domain.StatusDone
	case "needs-you", "needs_you", "awaiting_input", "awaiting-input":
		return st == domain.StatusAwaitingInput
	default:
		return string(st) == want
	}
}

func parseWaitArgs(args []string) (id, want string, timeout time.Duration, err error) {
	timeout = 30 * time.Second
	want = "idle"
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--for" && i+1 < len(args):
			i++
			want = args[i]
		case strings.HasPrefix(a, "--for="):
			want = strings.TrimPrefix(a, "--for=")
		case a == "--timeout" && i+1 < len(args):
			i++
			timeout, err = time.ParseDuration(args[i])
			if err != nil {
				return "", "", 0, fmt.Errorf("sessions wait: bad --timeout: %w", err)
			}
		case strings.HasPrefix(a, "--timeout="):
			timeout, err = time.ParseDuration(strings.TrimPrefix(a, "--timeout="))
			if err != nil {
				return "", "", 0, fmt.Errorf("sessions wait: bad --timeout: %w", err)
			}
		case strings.HasPrefix(a, "-"):
			return "", "", 0, fmt.Errorf("sessions wait: unknown flag %q", a)
		default:
			if id == "" {
				id = a
			} else {
				return "", "", 0, fmt.Errorf("sessions wait: unexpected arg %q", a)
			}
		}
	}
	if id == "" {
		return "", "", 0, fmt.Errorf("usage: shep-tui sessions wait <id> --for idle|done|needs-you [--timeout 30s]")
	}
	switch strings.ToLower(want) {
	case "idle", "done", "needs-you", "needs_you", "awaiting_input", "awaiting-input":
		// ok
	default:
		return "", "", 0, fmt.Errorf("sessions wait: --for must be idle|done|needs-you (got %q)", want)
	}
	if timeout <= 0 {
		return "", "", 0, fmt.Errorf("sessions wait: --timeout must be positive")
	}
	return id, want, timeout, nil
}

// sessionsSend writes text to the session PTY then closes the stream.
//
//	shep-tui sessions send <id> --text 'y'
func sessionsSend(args []string) error {
	id, text, err := parseSendArgs(args)
	if err != nil {
		return err
	}

	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pty, err := be.OpenPty(ctx, id, 80, 24)
	if err != nil {
		return fmt.Errorf("sessions send: open pty: %w", err)
	}
	defer pty.Close()

	payload := []byte(text)
	if n, err := pty.Write(payload); err != nil {
		return fmt.Errorf("sessions send: write: %w", err)
	} else if n != len(payload) {
		return fmt.Errorf("sessions send: short write %d/%d", n, len(payload))
	}
	fmt.Printf("sent %d bytes to %s\n", len(payload), id)
	return nil
}

func parseSendArgs(args []string) (id, text string, err error) {
	var textSet bool
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--text" && i+1 < len(args):
			i++
			text = args[i]
			textSet = true
		case strings.HasPrefix(a, "--text="):
			text = strings.TrimPrefix(a, "--text=")
			textSet = true
		case strings.HasPrefix(a, "-"):
			return "", "", fmt.Errorf("sessions send: unknown flag %q", a)
		default:
			if id == "" {
				id = a
			} else {
				return "", "", fmt.Errorf("sessions send: unexpected arg %q", a)
			}
		}
	}
	if id == "" || !textSet {
		return "", "", fmt.Errorf("usage: shep-tui sessions send <id> --text <payload>")
	}
	return id, text, nil
}

// sessionsExport dumps last scrollback if available, else a JSON events placeholder.
//
//	shep-tui sessions export <id>
func sessionsExport(args []string) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("usage: shep-tui sessions export <id>")
	}
	id := args[0]

	be, err := openBackend(10 * time.Second)
	if err != nil {
		return err
	}
	defer be.Close()

	// Best-effort: attach briefly and capture any immediate scrollback replay.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pty, err := be.OpenPty(ctx, id, 80, 24)
	if err != nil {
		// Placeholder events JSON when attach is unavailable.
		return writeExportPlaceholder(id, err)
	}
	defer pty.Close()

	var buf strings.Builder
	timer := time.NewTimer(400 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case chunk, ok := <-pty.Output():
			if !ok {
				goto done
			}
			buf.Write(chunk)
			if buf.Len() > 1<<20 {
				goto done
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(200 * time.Millisecond)
		case <-timer.C:
			goto done
		case <-ctx.Done():
			goto done
		}
	}
done:
	scrollback := buf.String()
	if scrollback == "" {
		return writeExportPlaceholder(id, nil)
	}
	// Text dump of captured scrollback.
	fmt.Fprint(os.Stdout, scrollback)
	if !strings.HasSuffix(scrollback, "\n") {
		fmt.Fprintln(os.Stdout)
	}
	return nil
}

func writeExportPlaceholder(id string, attachErr error) error {
	type event struct {
		Type    string `json:"type"`
		Session string `json:"session"`
		Note    string `json:"note,omitempty"`
		Error   string `json:"error,omitempty"`
		At      string `json:"at"`
	}
	note := "scrollback not available; events export placeholder"
	ev := event{
		Type:    "export.placeholder",
		Session: id,
		Note:    note,
		At:      time.Now().UTC().Format(time.RFC3339),
	}
	if attachErr != nil {
		ev.Error = attachErr.Error()
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode([]event{ev}); err != nil {
		return err
	}
	return nil
}

func openBackend(timeout time.Duration) (backend.Backend, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	be, err := dial.Open(ctx, cfg)
	if err != nil {
		if cfg.Active().Mode == config.ModeFleet {
			return nil, fmt.Errorf("open backend: %w (try: shep-tui auth login / doctor)", err)
		}
		return nil, fmt.Errorf("open backend: %w (try: shep-tui up)", err)
	}
	return be, nil
}
