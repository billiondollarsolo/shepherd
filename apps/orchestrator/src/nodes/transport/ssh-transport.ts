/**
 * SshTransport — a {@link NodeTransport} that runs the SAME operations as
 * LocalTransport but over a managed ssh2 hop (US-8, spec §3 "Node transport":
 * "local = SSH minus the hop"). It carries `exec`, `openPty`, `dispose` across an
 * already-established ssh2 {@link Client}; the connection lifecycle + autossh
 * supervision live in {@link SupervisedSshConnection} (ssh-connection.ts).
 *
 * It is a DUMB COURIER (spec §4.3, §5.1): no status model, no daemon, no agent
 * logic — just argv in, output/PTY out, over the wire.
 *
 * Parity notes (the shared contract suite, transport-contract.ts, asserts these):
 *   - exec captures stdout/stderr, exit code (3 on `exit 3`), signal, timedOut;
 *   - exec honours cwd / env / stdin input / timeoutMs;
 *   - openPty allocates a real PTY (so `cat` echoes typed input), streams onData,
 *     fires onExit once (with late-subscriber replay), supports write/resize/kill;
 *   - dispose kills outstanding PTYs and rejects further use.
 */
import type { Client, ClientChannel, PseudoTtyOptions } from 'ssh2';

import {
  TransportDisposedError,
  TransportInvalidCommandError,
  type ExecOptions,
  type ExecResult,
  type NodeTransport,
  type OpenPtyOptions,
  type PtyExit,
  type PtyHandle,
} from './transport.js';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_TERM = 'xterm-256color';
const NODE_ADMIN_HELPER = '/usr/local/sbin/flock-node-admin';

/**
 * Builds a single shell command line from an argv array, with optional cwd / env
 * prefixes. We always run through `sh -c` on the remote so behaviour matches
 * LocalTransport's `sh -c`-based contract assertions (redirection, `$VAR`, etc.).
 *
 * sshd typically refuses arbitrary `AcceptEnv`, so env is injected as inline
 * `KEY=value` assignments rather than relying on the ssh2 `env` channel option.
 */
function buildRemoteCommand(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): string {
  const quotedArgv = argv.map(shellQuote).join(' ');
  let prefix = '';
  if (options.env) {
    const assignments = Object.entries(options.env)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${shellQuote(String(v))}`);
    if (assignments.length > 0) prefix += `export ${assignments.join(' ')}; `;
  }
  if (options.cwd) prefix += `cd ${shellQuote(options.cwd)} && `;
  return `${prefix}${quotedArgv}`;
}

/**
 * Prepared Shepherd nodes authenticate SSH as the bootstrap-only control user,
 * while project files and provider credentials belong to the unprivileged
 * runtime user. The helper probe lets one transport support both shapes:
 * prepared nodes execute the payload as the runtime identity; legacy/direct
 * SSH nodes execute it as their login user. The probe never executes the
 * payload, so a failing command can never be retried under a second identity.
 */
export function runtimeAwareRemoteCommand(command: string): string {
  const encoded = Buffer.from(command, 'utf8').toString('base64');
  const probe = `sudo -n ${NODE_ADMIN_HELPER} runtime-exec-supported >/dev/null 2>&1`;
  const runtime = `sudo -n ${NODE_ADMIN_HELPER} runtime-exec ${shellQuote(encoded)}`;
  const direct = `exec /bin/sh -c ${shellQuote(command)}`;
  return `/bin/sh -c ${shellQuote(`if ${probe}; then exec ${runtime}; else ${direct}; fi`)}`;
}

/** POSIX single-quote escaping: wrap in '...' and escape embedded quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Normalises ssh2's signal name (e.g. 'TERM') to the 'SIGTERM' convention. */
function normaliseSignal(signal: string | null | undefined): string | null {
  if (!signal) return null;
  return signal.startsWith('SIG') ? signal : `SIG${signal}`;
}

/** Wraps an ssh2 {@link ClientChannel} in the transport-agnostic PtyHandle. */
class SshPtyHandle implements PtyHandle {
  private exited: PtyExit | null = null;
  private readonly exitListeners = new Set<(e: PtyExit) => void>();
  private readonly dataListeners = new Set<(c: string) => void>();
  private killed = false;
  private pendingExitCode: number | null = null;
  private pendingSignal: string | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly channel: ClientChannel) {
    channel.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const l of [...this.dataListeners]) l(text);
    });
    // ssh2 emits 'exit' (with code OR signal) before the stream 'close'. We
    // record the exit details on 'exit' and finalise on 'close' so onData has
    // drained, mirroring node-pty's single onExit semantics.
    channel.on('exit', (code: number | null, signal?: string) => {
      this.pendingExitCode = typeof code === 'number' ? code : null;
      this.pendingSignal = normaliseSignal(signal ?? null);
    });
    channel.on('close', () => this.finalize());
  }

  private finalize(): void {
    if (this.exited) return;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.exited = {
      exitCode: this.pendingExitCode,
      // If the channel closed without a clean code and we killed it, surface a
      // signal so callers can tell it was terminated (contract: kill => exited).
      signal:
        this.pendingSignal ?? (this.pendingExitCode === null && this.killed ? 'SIGKILL' : null),
    };
    for (const l of [...this.exitListeners]) l(this.exited);
    this.exitListeners.clear();
    this.dataListeners.clear();
  }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyExit) => void): () => void {
    if (this.exited) {
      const recorded = this.exited;
      queueMicrotask(() => listener(recorded));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    if (this.exited) return;
    this.channel.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      this.channel.setWindow(Math.max(1, rows), Math.max(1, cols), 0, 0);
    } catch {
      // channel already gone
    }
  }

  kill(signal?: string): void {
    if (this.killed || this.exited) return;
    this.killed = true;
    const sig = (signal ?? 'SIGTERM').replace(/^SIG/, '');
    try {
      // Best-effort signal; many sshd builds ignore SSH_MSG_CHANNEL_REQUEST
      // "signal" for the program, so we also tear the channel down.
      this.channel.signal(sig);
    } catch {
      // ignore
    }
    try {
      this.channel.close();
    } catch {
      // ignore
    }
    try {
      // Destroy the local stream so the client side stops regardless of whether
      // the server honours the request (e.g. a PTY-hosted `sleep`).
      this.channel.destroy();
    } catch {
      // ignore
    }
    // OpenSSH frequently neither delivers an 'exit' for a signalled PTY program
    // nor promptly emits the channel 'close'. Guarantee the PtyHandle contract
    // ("kill ⇒ onExit fires") with a short fallback that finalises if no real
    // close/exit has arrived. A genuine 'close' (see ctor) wins the race and
    // cancels nothing harmful since finalize() is idempotent.
    this.fallbackTimer = setTimeout(() => this.finalize(), 250);
    if (typeof this.fallbackTimer.unref === 'function') this.fallbackTimer.unref();
  }

  /** Forced, IMMEDIATE teardown used by SshTransport.dispose(). */
  forceClose(): void {
    if (!this.killed) this.kill('SIGKILL');
    // dispose() must terminate live PTYs synchronously; do not wait for the
    // fallback timer.
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.finalize();
  }
}

export class SshTransport implements NodeTransport {
  readonly kind = 'ssh' as const;

  private disposed = false;
  private readonly livePtys = new Set<SshPtyHandle>();

  /**
   * @param client A connected ssh2 Client (owned by SupervisedSshConnection).
   *   SshTransport does NOT close the client on dispose — the supervisor owns
   *   the connection lifecycle; dispose only tears down THIS transport's PTYs.
   */
  constructor(private readonly client: Client) {}

  async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (this.disposed) throw new TransportDisposedError(this.kind);
    if (command.length === 0) throw new TransportInvalidCommandError();

    const remote = runtimeAwareRemoteCommand(buildRemoteCommand(command, options));

    return new Promise<ExecResult>((resolve, reject) => {
      const ok = this.client.exec(remote, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let exitCode: number | null = null;
        let signal: string | null = null;
        let settled = false;

        const timer =
          options.timeoutMs && options.timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                try {
                  channel.signal('KILL');
                } catch {
                  /* ignore */
                }
                try {
                  channel.close();
                } catch {
                  /* ignore */
                }
              }, options.timeoutMs)
            : undefined;

        channel.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
        });
        channel.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        channel.on('exit', (code: number | null, sig?: string) => {
          exitCode = typeof code === 'number' ? code : null;
          signal = normaliseSignal(sig ?? null);
        });
        channel.on('close', () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({
            // A timed-out command did NOT complete: it was forcibly killed, so it
            // has no meaningful exit code (contract: exitCode must not be 0).
            // Some sshd builds still deliver a clean `exit 0` for the signalled
            // wrapper shell; ignore it when we know we killed the command.
            exitCode: timedOut ? null : exitCode,
            signal: timedOut ? (signal ?? 'SIGKILL') : signal,
            stdout,
            stderr,
            timedOut,
          });
        });
        channel.on('error', (e: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(e);
        });

        if (options.input !== undefined) {
          channel.write(options.input);
        }
        channel.end();
      });

      if (!ok) {
        reject(new Error('SSH exec failed: channel could not be opened (backpressure).'));
      }
    });
  }

  async openPty(options: OpenPtyOptions = {}): Promise<PtyHandle> {
    if (this.disposed) throw new TransportDisposedError(this.kind);

    const command = options.command;
    if (command !== undefined && command.length === 0) {
      throw new TransportInvalidCommandError();
    }

    const window: PseudoTtyOptions = {
      term: DEFAULT_TERM,
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
    };

    return new Promise<PtyHandle>((resolve, reject) => {
      const onChannel = (err: Error | undefined, channel: ClientChannel): void => {
        if (err) {
          reject(err);
          return;
        }
        const handle = new SshPtyHandle(channel);
        this.livePtys.add(handle);
        handle.onExit(() => this.livePtys.delete(handle));
        resolve(handle);
      };

      if (command === undefined) {
        // Default login shell with a PTY.
        this.client.shell(window, { env: ptyEnv(options.env) }, onChannel);
      } else {
        // Run a specific program under a PTY so it behaves like a terminal
        // (e.g. `cat` echoes input — required by the contract suite).
        const remote = runtimeAwareRemoteCommand(
          buildRemoteCommand(command, {
            cwd: options.cwd,
            env: options.env,
          }),
        );
        this.client.exec(remote, { pty: window, env: ptyEnv(options.env) }, onChannel);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of [...this.livePtys]) {
      handle.forceClose();
    }
    this.livePtys.clear();
    // NOTE: we intentionally do NOT end the ssh2 client here; the supervised
    // connection owns it (one client backs many transports across reconnects).
  }
}

/** ssh2 env channel option (best-effort; sshd may ignore unlisted vars). */
function ptyEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv | undefined {
  if (!extra) return undefined;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}
