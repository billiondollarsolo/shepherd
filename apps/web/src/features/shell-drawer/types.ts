/**
 * Shell drawer feature — session-id derivation for the second shell.
 *
 * US-35 (spec §9, PRD §12.2): a *second* user shell, distinct from the agent's
 * terminal, scoped to the session's working directory. The AppShell (US-30)
 * mounts the drawer into its bottom `Cmd+J` slot.
 *
 * The terminal feature opens the agent PTY at `/ws/pty/<sessionId>` (the
 * `usePtyWebSocket` hook builds that URL from the session id alone). To get a
 * *separate* PTY — a plain shell `cd`'d into the working dir, NOT a re-attach of
 * the agent's tmux pane (PRD §12.2) — the drawer opens the PTY for a derived
 * shell session id `<sessionId>:shell`. The orchestrator routes the `:shell`
 * suffix to a fresh login shell in the session working dir.
 *
 * Keeping this a pure function makes the distinctness an assertable invariant
 * (see `shellChannel.test.ts`, `ShellDrawer.test.tsx`, and e2e `shell.spec.ts`).
 */

/** The agent terminal's PTY session id (spec §8.2 channel `pty:<sessionId>`). */
export function agentTerminalSessionId(sessionId: string): string {
  return sessionId;
}

/**
 * The drawer's second-shell PTY session id: a dedicated derivative of the same
 * session, guaranteed distinct from {@link agentTerminalSessionId}, so the
 * drawer's PTY never collides with the agent's pane.
 */
export function shellSessionId(sessionId: string): string {
  return `${sessionId}:shell`;
}
