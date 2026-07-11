/**
 * NodeAgentdClient — the orchestrator's client for one node's flock-agentd, over
 * a single multiplexed duplex stream (a unix socket for the local node; an SSH
 * `direct-tcpip` channel for a remote node — both are just `Duplex`es). It owns
 * one connection per node and routes PTY output/exit to per-session handlers.
 *
 * This is the seam the `/ws/pty` bridge will sit on: `subscribe()` gives the
 * scrollback replay (as the first data callbacks) then live output; `write()` /
 * `resize()` go straight to the daemon's raw PTY (no tmux).
 */
import type { Duplex } from 'node:stream';

import {
  AGENTD_PROTOCOL_VERSION,
  FrameType,
  FrameDecoder,
  decodeDataPayload,
  encodeControl,
  encodePtyInput,
  type AgentdControl,
  type AgentdStatusMeta,
} from './protocol.js';

export interface AgentdSessionSpec {
  id: string;
  kind?: 'agent' | 'shell' | string;
  cwd?: string;
  env?: string[];
  command?: string[];
  /** Session transport: "" / "pty" (default) or "acp" (structured, F6). */
  mode?: string;
  cols?: number;
  rows?: number;
  // scoped hook-config injection (US-19), seeded on the node by the daemon.
  configDirEnv?: string;
  configFiles?: Record<string, string>;
  configBaseSubdir?: string;
  // T17: Landlock FS sandbox for autonomous sessions (the daemon confines writes).
  sandbox?: boolean;
  sandboxAllow?: string[];
  // T61: derive status from PTY activity (agents with no transcript/hook, e.g. gemini).
  activityStatus?: boolean;
}

export interface AgentdSubscription {
  close(): void;
}

interface ControlWaiter {
  match: (c: AgentdControl) => boolean;
  resolve: (c: AgentdControl) => void;
  reject: (err: Error) => void;
}

export class NodeAgentdClient {
  private readonly decoder = new FrameDecoder();
  private readonly dataHandlers = new Map<string, (data: Buffer) => void>();
  private readonly exitHandlers = new Map<
    string,
    (code: number, reason: 'exit' | 'disconnect') => void
  >();
  private readonly waiters: ControlWaiter[] = [];
  private statusHandler?: (id: string, state: string, meta: AgentdStatusMeta) => void;
  private closed = false;

  constructor(private readonly sock: Duplex) {
    sock.on('data', (chunk: Buffer) => this.onChunk(chunk));
    sock.on('close', () => this.onClose(new Error('agentd connection closed')));
    sock.on('error', (err: Error) => this.onClose(err));
  }

  private onChunk(chunk: Buffer): void {
    try {
      this.decoder.push(chunk, (type, payload) => {
        if (type === FrameType.PtyOutput) {
          const { sid, data } = decodeDataPayload(payload);
          this.dataHandlers.get(sid)?.(data);
          return;
        }
        if (type === FrameType.Control) {
          let ctrl: AgentdControl;
          try {
            ctrl = JSON.parse(payload.toString('utf8')) as AgentdControl;
          } catch {
            return;
          }
          if (ctrl.op === 'exit' && ctrl.id) {
            this.exitHandlers.get(ctrl.id)?.(ctrl.code ?? 0, 'exit');
          }
          // Unsolicited derived-status push (daemon tails the agent transcript).
          // `ctrl` structurally satisfies AgentdStatusMeta (the handler reads only
          // the telemetry fields), so pass it through directly.
          if (ctrl.op === 'status' && ctrl.id) {
            this.statusHandler?.(ctrl.id, ctrl.state ?? '', ctrl);
          }
          for (let i = this.waiters.length - 1; i >= 0; i--) {
            if (this.waiters[i]!.match(ctrl)) {
              this.waiters.splice(i, 1)[0]!.resolve(ctrl);
            }
          }
        }
      });
    } catch (err) {
      // T25: an over-cap frame (FrameTooLargeError) means the stream is corrupt
      // or hostile — tear the link down instead of buffering unboundedly.
      this.onClose(err instanceof Error ? err : new Error('frame decode error'));
      this.sock.destroy();
    }
  }

  private onClose(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(err);
    // The LINK dropped (SSH/daemon channel), not the processes — the daemon
    // persists every session. Report a TRANSIENT disconnect so the client
    // reconnects + resumes, instead of declaring sessions dead ('exited').
    for (const [, h] of this.exitHandlers) h(-1, 'disconnect');
    this.dataHandlers.clear();
    this.exitHandlers.clear();
  }

  private send(c: AgentdControl): void {
    // T23: never write to a closed/dropped link (write-after-end throws an
    // unhandled 'error' on the stream). Swallow transient write failures — the
    // close handler already surfaces the disconnect to callers.
    if (this.closed) return;
    try {
      this.sock.write(encodeControl(c));
    } catch {
      /* link dropped mid-write; onClose handles reconnect/exit notification */
    }
  }

  private await(match: (c: AgentdControl) => boolean, timeoutMs = 10_000): Promise<AgentdControl> {
    return new Promise<AgentdControl>((resolve, reject) => {
      const w: ControlWaiter = { match, resolve, reject };
      this.waiters.push(w);
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('agentd control timeout'));
      }, timeoutMs);
      const orig = w.resolve;
      w.resolve = (c) => {
        clearTimeout(t);
        orig(c);
      };
    });
  }

  /**
   * Register a handler for derived agent-status pushes (daemon tails the agent's
   * transcript and emits running/awaiting_input/idle/error per session). Set once
   * per client; the daemon replays a snapshot right after `hello`.
   */
  onStatus(fn: (id: string, state: string, meta: AgentdStatusMeta) => void): void {
    this.statusHandler = fn;
  }

  /** Handshake: announce protocol/secret, get the daemon version. */
  async hello(secret?: string): Promise<AgentdControl> {
    this.send({ op: 'hello', protocolVersion: AGENTD_PROTOCOL_VERSION, secret });
    const ok = await this.await((c) => c.op === 'helloOk' || c.op === 'error');
    if (ok.op === 'error') throw new Error(`agentd hello failed: ${ok.message}`);
    return ok;
  }

  /** Open (or re-attach to) a session. Idempotent on the daemon side. */
  async open(spec: AgentdSessionSpec): Promise<void> {
    this.send({ op: 'open', ...spec });
    const r = await this.await((c) => (c.op === 'opened' || c.op === 'error') && c.id === spec.id);
    if (r.op === 'error') throw new Error(`agentd open ${spec.id} failed: ${r.message}`);
  }

  /** Subscribe to a session's output (scrollback replays first, then live). */
  subscribe(
    id: string,
    onData: (data: Buffer) => void,
    onExit?: (code: number, reason: 'exit' | 'disconnect') => void,
  ): AgentdSubscription {
    this.dataHandlers.set(id, onData);
    if (onExit) this.exitHandlers.set(id, onExit);
    this.send({ op: 'subscribe', id });
    return {
      close: () => {
        this.dataHandlers.delete(id);
        this.exitHandlers.delete(id);
        this.send({ op: 'unsubscribe', id });
      },
    };
  }

  write(id: string, data: Buffer): void {
    this.sock.write(encodePtyInput(id, data));
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ op: 'resize', id, cols, rows });
  }

  close(id: string): void {
    this.send({ op: 'close', id });
  }

  async list(): Promise<NonNullable<AgentdControl['sessions']>> {
    this.send({ op: 'list' });
    const r = await this.await((c) => c.op === 'sessions');
    return r.sessions ?? [];
  }

  /** Request the node's live host metrics + detected agents (NodeInfo JSON). */
  async nodeInfo(): Promise<unknown> {
    this.send({ op: 'nodeInfo' });
    const r = await this.await((c) => c.op === 'nodeInfo');
    return r.nodeInfo;
  }

  /**
   * Poll until a session id appears on the daemon, or `timeoutMs` elapses.
   * Used by the attach path to wait out the create/attach race with the launch
   * (the launch is the sole creator of agent/terminal sessions) without itself
   * creating a stray default-shell session.
   */
  async waitForSession(id: string, timeoutMs = 2500, intervalMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sessions = await this.list().catch(() => []);
      if (sessions.some((s) => s.id === id)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  dispose(): void {
    this.onClose(new Error('disposed'));
    this.sock.end();
  }
}
