/**
 * Pure binding between an xterm `Terminal` and the keystroke/resize sink of the
 * shared PTY WebSocket hook (`usePtyWebSocket`). PTY *output* is delivered to
 * the terminal by the hook's `onData` callback (wired in `ShellDrawer`), so this
 * helper only forwards the two *outbound* streams (input + resize) and sends an
 * initial size. No DOM, no socket — unit-testable with fakes.
 *
 * This is the seam that makes the drawer reuse "the same terminal ws client" the
 * agent terminal uses (US-35 implementation note), rather than a bespoke socket.
 */

/** The narrow slice of an xterm `Terminal` the drawer needs. */
export interface TerminalLike {
  onData(handler: (data: string) => void): { dispose(): void };
  onResize(handler: (size: { cols: number; rows: number }) => void): {
    dispose(): void;
  };
  readonly cols: number;
  readonly rows: number;
}

/** The outbound surface of `usePtyWebSocket`'s return value. */
export interface ShellPtySink {
  sendInput: (input: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

/**
 * Forwards user keystrokes and resize events from the terminal to the PTY, and
 * sends an initial resize so the remote shell matches the drawer on attach.
 * Returns a disposer that detaches the subscriptions.
 */
export function attachShellTerminal(term: TerminalLike, pty: ShellPtySink): () => void {
  const dataSub = term.onData((input) => {
    pty.sendInput(input);
  });

  const resizeSub = term.onResize(({ cols, rows }) => {
    pty.sendResize(cols, rows);
  });

  if (term.cols > 0 && term.rows > 0) {
    pty.sendResize(term.cols, term.rows);
  }

  return () => {
    dataSub.dispose();
    resizeSub.dispose();
  };
}
