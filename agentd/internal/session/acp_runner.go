package session

import (
	"context"
	"os/exec"

	"flock-agentd/internal/acp"
	"flock-agentd/internal/status"
)

// runACPOverConn drives one turn of an already-connected ACP session and pushes
// the lifecycle status: handshake → new session → running → prompt → idle. The
// caller must already be pumping conn.Run in a goroutine. Pure of process
// management, so it is unit-tested against a mock agent over pipes.
func runACPOverConn(
	ctx context.Context,
	conn *acp.Conn,
	cwd, prompt string,
	push func(status.Update),
) error {
	if err := conn.Initialize(ctx); err != nil {
		return err
	}
	sessionID, err := conn.NewSession(ctx, cwd, nil)
	if err != nil {
		return err
	}
	push(status.Update{State: status.StateRunning})
	if err := conn.Prompt(ctx, sessionID, prompt); err != nil {
		push(status.Update{State: status.StateError})
		return err
	}
	push(status.Update{State: status.StateIdle})
	return nil
}

// RunACPSession spawns an agent in ACP (structured) mode and runs a turn,
// pushing status/telemetry through `push` (wire it to the manager's status
// Emitter) and answering approval prompts via `respond`. This is the structured
// alternative to the raw-PTY transport; the PTY path remains the universal
// default (Invariant 1). `argv` comes from acp.LaunchCommand(agentType).
//
// NOTE: this is the spawn wrapper around the unit-tested runACPOverConn; the
// remaining F6 step is to register it as an "acp" session mode in Manager.Open
// and validate end-to-end against a live ACP agent on a node (the flagged gate).
func RunACPSession(
	ctx context.Context,
	argv []string,
	cwd, prompt string,
	push func(status.Update),
	respond func(acp.PermissionRequest) string,
) error {
	if len(argv) == 0 {
		return exec.ErrNotFound
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = cwd
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	conn := acp.NewConn(stdout, stdin, newACPHandlers(push, respond))
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = conn.Run(ctx) }()
	runErr := runACPOverConn(ctx, conn, cwd, prompt, push)
	_ = stdin.Close()
	waitErr := cmd.Wait()
	if runErr != nil {
		return runErr
	}
	return waitErr
}
