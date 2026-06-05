/**
 * NodeTransport — the seam that lets local and SSH nodes share one test suite
 * (US-7, spec §3 "Node transport", §5 architecture, spec note §15:
 * "NodeTransport is the seam that lets local and SSH share one test suite —
 * write the contract suite once, run twice").
 *
 * A transport is a DUMB COURIER (PRD §6.4, spec §4.3, §5.1): it runs commands
 * and opens PTYs on a node on the orchestrator's behalf. It holds NO product
 * logic, NO status model, NO daemon — just `exec`, `openPty`, `dispose`.
 *   - LocalTransport (US-7) runs against the orchestrator host/container.
 *   - SshTransport (US-8) runs the SAME operations over a managed ssh2 hop;
 *     "local = SSH minus the hop".
 *
 * The interface intentionally deals in LIVE handles (an exec result, a PTY
 * handle), not serializable wire types — wire framing for the PTY ⇄ WebSocket
 * bridge (US-11) lives elsewhere. Keeping this orchestrator-internal avoids
 * leaking node-pty/ssh2 shapes into `packages/shared`.
 */

/** Options for a one-shot command execution. */
export interface ExecOptions {
  /** Working directory for the command. Defaults to the transport's home/cwd. */
  cwd?: string;
  /** Extra environment variables, merged over the node's environment. */
  env?: Record<string, string | undefined>;
  /**
   * Max time (ms) before the command is killed and the promise rejects.
   * Omit / 0 to disable. A killed command surfaces `timedOut: true`.
   */
  timeoutMs?: number;
  /** Optional stdin written to the process, then closed. */
  input?: string;
}

/** Result of a completed {@link NodeTransport.exec}. */
export interface ExecResult {
  /** Process exit code (0 on success). `null` when killed by a signal. */
  exitCode: number | null;
  /** Terminating signal name, if any (e.g. 'SIGTERM'). */
  signal: string | null;
  /** Captured stdout (utf-8). */
  stdout: string;
  /** Captured stderr (utf-8). */
  stderr: string;
  /** True when the command was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
}

/** Options for opening an interactive pseudo-terminal. */
export interface OpenPtyOptions {
  /**
   * Command to run as the PTY's program (e.g. the agent CLI, US-10). When omitted
   * the node's default login shell is launched.
   */
  command?: string[];
  /** Working directory for the PTY. */
  cwd?: string;
  /** Extra environment variables, merged over the node's environment. */
  env?: Record<string, string | undefined>;
  /** Terminal columns (default 80). */
  cols?: number;
  /** Terminal rows (default 24). */
  rows?: number;
}

/**
 * A live PTY handle. Mirrors the subset of node-pty / ssh2 stream behaviour the
 * orchestrator needs for the PTY ⇄ WebSocket bridge (US-11), so both transports
 * expose ONE handle shape the rest of the orchestrator can program against.
 */
export interface PtyHandle {
  /** Subscribe to PTY output. Returns an unsubscribe disposer. */
  onData(listener: (chunk: string) => void): () => void;
  /**
   * Subscribe to PTY exit. Returns an unsubscribe disposer. Fires at most once;
   * late subscribers (after exit) are invoked with the recorded result.
   */
  onExit(listener: (event: PtyExit) => void): () => void;
  /** Write input to the PTY. */
  write(data: string): void;
  /** Resize the PTY viewport. */
  resize(cols: number, rows: number): void;
  /** Terminate the PTY (default SIGTERM). Idempotent. */
  kill(signal?: string): void;
}

/** Payload delivered to {@link PtyHandle.onExit} listeners. */
export interface PtyExit {
  exitCode: number | null;
  signal: string | null;
  /**
   * True when this is NOT a real process exit but a transient loss of the
   * orchestrator↔node link (e.g. the SSH/daemon channel dropped). The agent is
   * still alive on the persistent daemon; the client should RECONNECT and resume,
   * not declare the session dead. False/undefined = a genuine terminal exit.
   */
  transient?: boolean;
}

/**
 * NodeTransport — `exec`, `openPty`, `dispose` (US-7 acceptance criteria).
 *
 * Implementations MUST be safe to `dispose()` more than once and MUST clean up
 * any spawned PTYs / connections on dispose.
 */
export interface NodeTransport {
  /** How this transport reaches the node (informational; matches NodeKind). */
  readonly kind: 'local' | 'ssh';

  /** Run a command to completion and capture its output. */
  exec(command: string[], options?: ExecOptions): Promise<ExecResult>;

  /** Open an interactive PTY (e.g. to attach a flock-agentd session). */
  openPty(options?: OpenPtyOptions): Promise<PtyHandle>;

  /**
   * Release all resources: kill outstanding PTYs, close connections. After
   * dispose the transport must reject further `exec`/`openPty` calls. Idempotent.
   */
  dispose(): Promise<void>;
}

/** Thrown when a transport is used after {@link NodeTransport.dispose}. */
export class TransportDisposedError extends Error {
  constructor(kind: string) {
    super(`NodeTransport (${kind}) has been disposed and can no longer be used.`);
    this.name = 'TransportDisposedError';
  }
}

/** Thrown when `exec`/`openPty` is given an empty command. */
export class TransportInvalidCommandError extends Error {
  constructor() {
    super('A non-empty command (argv) is required.');
    this.name = 'TransportInvalidCommandError';
  }
}
