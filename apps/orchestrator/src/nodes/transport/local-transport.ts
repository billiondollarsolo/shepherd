/**
 * LocalTransport — a {@link NodeTransport} that runs against the orchestrator
 * host/container itself (US-7). It is the `local` node kind: no SSH hop, just
 * `child_process` for `exec` and `node-pty` for `openPty` ("local = SSH minus
 * the hop", spec §3).
 *
 * It is a DUMB COURIER (spec §4.3, §5.1): it carries commands and PTY streams;
 * it holds no status model, no daemon, no agent logic.
 */
import { spawn as spawnChild } from 'node:child_process';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

import { spawn as spawnPty, type IPty } from 'node-pty';

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

/** Wraps a node-pty {@link IPty} in the transport-agnostic {@link PtyHandle}. */
class LocalPtyHandle implements PtyHandle {
  private exited: PtyExit | null = null;
  private readonly exitListeners = new Set<(e: PtyExit) => void>();
  private killed = false;

  constructor(private readonly pty: IPty) {
    pty.onExit(({ exitCode, signal }) => {
      // node-pty gives a numeric signal; normalise to a string|null for parity
      // with child_process and the SSH transport (US-8).
      this.exited = {
        exitCode: exitCode ?? null,
        signal: signal != null ? `SIG${signal}` : null,
      };
      for (const listener of [...this.exitListeners]) {
        listener(this.exited);
      }
      this.exitListeners.clear();
    });
  }

  onData(listener: (chunk: string) => void): () => void {
    const disposable = this.pty.onData(listener);
    return () => disposable.dispose();
  }

  onExit(listener: (event: PtyExit) => void): () => void {
    if (this.exited) {
      // Already exited: replay the recorded result asynchronously so late
      // subscribers still fire (contract: "late onExit subscribers").
      const recorded = this.exited;
      queueMicrotask(() => listener(recorded));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void {
    if (this.exited) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.pty.resize(Math.max(1, cols), Math.max(1, rows));
  }

  kill(signal?: string): void {
    if (this.killed || this.exited) return;
    this.killed = true;
    try {
      this.pty.kill(signal);
    } catch {
      // Already gone; the onExit handler will (or already did) fire.
    }
  }
}

export class LocalTransport implements NodeTransport {
  readonly kind = 'local' as const;

  private disposed = false;
  private readonly live = new Set<LocalPtyHandle>();
  /** Underlying node-pty instances, so dispose can force-kill them. */
  private readonly livePtys = new Set<IPty>();

  async dialTcp(port: number, host: '127.0.0.1' | '::1' = '127.0.0.1'): Promise<Duplex> {
    if (this.disposed) throw new TransportDisposedError(this.kind);
    return await new Promise<Duplex>((resolve, reject) => {
      const socket = connect({ host, port });
      const onError = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve(socket);
      });
    });
  }

  async exec(command: string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (this.disposed) throw new TransportDisposedError(this.kind);
    if (command.length === 0) throw new TransportInvalidCommandError();

    const [file, ...args] = command;

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawnChild(file as string, args, {
        cwd: options.cwd,
        env: mergeEnv(options.env),
        // We capture explicitly; never inherit the orchestrator's tty.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so a timeout can kill the WHOLE tree (e.g. a
        // `sh -c 'sleep 5'` whose `sleep` would otherwise keep the stdout pipe
        // open and prevent the `close` event from firing).
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const killTree = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          // Negative pid → signal the whole process group.
          process.kill(-child.pid, signal);
        } catch {
          // Group already gone; try the direct pid as a fallback.
          try {
            child.kill(signal);
          } catch {
            // already dead
          }
        }
      };

      const timer =
        options.timeoutMs && options.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              killTree('SIGKILL');
            }, options.timeoutMs)
          : undefined;

      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          exitCode: code,
          signal: signal ?? null,
          stdout,
          stderr,
          timedOut,
        });
      });

      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      } else {
        child.stdin?.end();
      }
    });
  }

  async openPty(options: OpenPtyOptions = {}): Promise<PtyHandle> {
    if (this.disposed) throw new TransportDisposedError(this.kind);

    const command = options.command ?? [defaultShell()];
    if (command.length === 0) throw new TransportInvalidCommandError();

    const [file, ...args] = command;

    const pty = spawnPty(file as string, args, {
      name: DEFAULT_TERM,
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      cwd: options.cwd,
      env: mergeEnv(options.env) as { [key: string]: string },
    });

    this.livePtys.add(pty);
    const handle = new LocalPtyHandle(pty);
    this.live.add(handle);

    pty.onExit(() => {
      this.livePtys.delete(pty);
      this.live.delete(handle);
    });

    return handle;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of [...this.live]) {
      handle.kill('SIGKILL');
    }
    // Belt-and-braces: force-kill any underlying pty that ignored the handle.
    for (const pty of [...this.livePtys]) {
      try {
        pty.kill('SIGKILL');
      } catch {
        // already dead
      }
    }
    this.live.clear();
    this.livePtys.clear();
  }
}

/** Merges extra vars over the orchestrator's env, dropping undefined values. */
function mergeEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete base[k];
      else base[k] = v;
    }
  }
  return base;
}

/** Resolves the node's default login shell. */
function defaultShell(): string {
  return process.env.SHELL ?? '/bin/sh';
}
