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
import { randomUUID } from 'node:crypto';
import { Duplex } from 'node:stream';

import type { NodeControlIdentity } from './node-control-credentials.js';
import {
  controlCredentialId,
  controlMac,
  controlNonce,
  validControlNonce,
  verifyControlMac,
} from './control-auth.js';

import {
  AGENTD_PROTOCOL_VERSION,
  FrameType,
  FrameDecoder,
  decodeDataPayload,
  encodeControl,
  encodePtyInput,
  encodeTcpInput,
  type AgentdControl,
  type AgentdListeningPort,
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
  // Native hook-config injection (US-19), seeded on the node by the daemon.
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

export interface AuthenticatedAgentdIdentity {
  daemonVersion: string;
  protocolVersion: number;
  capabilities: string[];
}

export interface AgentdListeningPortsSnapshot {
  ports: AgentdListeningPort[];
  observedAt: string;
  degradedReason: string | null;
}

export interface AgentdExecRequest {
  command: string[];
  cwd?: string;
  env?: string[];
  input?: string;
  timeoutMs?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
}

export interface AgentdExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export class AgentdCapabilityUnavailableError extends Error {
  constructor(public readonly capability: string) {
    super(`agentd capability unavailable: ${capability}`);
    this.name = 'AgentdCapabilityUnavailableError';
  }
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
  private authenticatedIdentity: AuthenticatedAgentdIdentity | null = null;
  private openBlockedReason: string | null = null;
  private tcpTunnel: AgentdTcpDuplex | null = null;

  constructor(private readonly sock: Duplex) {
    sock.on('data', (chunk: Buffer) => this.onChunk(chunk));
    sock.on('close', () => this.onClose(new Error('agentd connection closed')));
    sock.on('error', (err: Error) => this.onClose(err));
  }

  private onChunk(chunk: Buffer): void {
    try {
      this.decoder.push(chunk, (type, payload) => {
        if (type === FrameType.TcpOutput) {
          this.tcpTunnel?.receive(payload);
          return;
        }
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
          if (ctrl.op === 'tcpClosed') {
            this.tcpTunnel?.remoteClose(ctrl.message);
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
    this.tcpTunnel?.disconnect(err);
    this.tcpTunnel = null;
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

  private writeFrame(frame: Buffer, callback?: (error?: Error | null) => void): void {
    if (this.closed) {
      callback?.(new Error('agentd connection closed'));
      return;
    }
    try {
      this.sock.write(frame, callback);
    } catch (error) {
      callback?.(error instanceof Error ? error : new Error('agentd write failed'));
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

  /** Observe the underlying control-link lifecycle without exposing the socket. */
  onLinkClose(fn: () => void): void {
    this.sock.on('close', fn);
  }

  /** Mutual nonce/MAC handshake. No plaintext credential crosses the channel. */
  async hello(
    identity: NodeControlIdentity,
    protocolVersion = AGENTD_PROTOCOL_VERSION,
    connectionRole: 'control' | 'operation' = 'control',
  ): Promise<AuthenticatedAgentdIdentity> {
    const clientNonce = controlNonce();
    const credentialId = controlCredentialId(identity.credential);
    this.send({
      op: 'hello',
      protocolVersion,
      nodeId: identity.nodeId,
      clientNonce,
      credentialId,
      connectionRole,
    });
    const challenge = await this.await(
      (c) => c.op === 'challenge' || c.op === 'helloOk' || c.op === 'error',
    );
    if (challenge.op === 'error') throw new Error(`agentd hello failed: ${challenge.message}`);
    if (challenge.op === 'helloOk') {
      throw new Error('agentd sent an unauthenticated handshake response');
    }
    const capabilities = challenge.capabilities ?? [];
    if (
      challenge.protocolVersion !== protocolVersion ||
      challenge.nodeId !== identity.nodeId ||
      challenge.credentialId !== credentialId ||
      challenge.clientNonce !== clientNonce ||
      !challenge.serverNonce ||
      !validControlNonce(challenge.serverNonce) ||
      !challenge.daemonVersion ||
      !challenge.serverMac
    ) {
      throw new Error('agentd returned an invalid authentication challenge');
    }
    if (connectionRole === 'operation' && challenge.connectionRole !== 'operation') {
      throw new Error('agentd does not support authenticated operation connections');
    }
    const expected = controlMac({
      credential: identity.credential,
      role: 'server',
      nodeId: identity.nodeId,
      clientNonce,
      serverNonce: challenge.serverNonce,
      daemonVersion: challenge.daemonVersion,
      capabilities,
    });
    if (!verifyControlMac(expected, challenge.serverMac)) {
      throw new Error('agentd daemon authentication failed');
    }
    this.send({
      op: 'authenticate',
      nodeId: identity.nodeId,
      clientNonce,
      serverNonce: challenge.serverNonce,
      clientMac: controlMac({
        credential: identity.credential,
        role: 'client',
        nodeId: identity.nodeId,
        clientNonce,
        serverNonce: challenge.serverNonce,
        daemonVersion: challenge.daemonVersion,
        capabilities,
      }),
    });
    const ok = await this.await((c) => c.op === 'helloOk' || c.op === 'error');
    if (ok.op === 'error') throw new Error(`agentd authentication failed: ${ok.message}`);
    if (
      ok.protocolVersion !== protocolVersion ||
      ok.nodeId !== identity.nodeId ||
      ok.daemonVersion !== challenge.daemonVersion ||
      JSON.stringify(ok.capabilities ?? []) !== JSON.stringify(capabilities)
    ) {
      throw new Error('agentd authenticated identity changed during handshake');
    }
    if (connectionRole === 'operation' && ok.connectionRole !== 'operation') {
      throw new Error('agentd operation connection role changed during handshake');
    }
    this.authenticatedIdentity = {
      daemonVersion: challenge.daemonVersion,
      protocolVersion,
      capabilities: [...capabilities],
    };
    return this.authenticatedIdentity;
  }

  /** Authenticated daemon facts; null until mutual authentication completes. */
  identity(): AuthenticatedAgentdIdentity | null {
    return this.authenticatedIdentity ? { ...this.authenticatedIdentity } : null;
  }

  supports(capability: string): boolean {
    return this.authenticatedIdentity?.capabilities.includes(capability) === true;
  }

  /** Keep existing sessions attachable while preventing work on a mandatory-old daemon. */
  blockNewSessions(reason: string | null): void {
    this.openBlockedReason = reason;
  }

  /** Rotate this node's key over an already authenticated control connection. */
  async rotateCredential(newCredential: string): Promise<void> {
    if (newCredential.length < 32) throw new Error('new agentd credential is too short');
    this.send({ op: 'rotateCredential', newCredential });
    const response = await this.await(
      (control) => control.op === 'credentialRotated' || control.op === 'error',
    );
    if (response.op === 'error') {
      throw new Error(`agentd credential rotation failed: ${response.message}`);
    }
    if (response.credentialId !== controlCredentialId(newCredential)) {
      throw new Error('agentd acknowledged the wrong rotated credential');
    }
  }

  /** Open (or re-attach to) a session. Idempotent on the daemon side. */
  async open(spec: AgentdSessionSpec): Promise<void> {
    if (this.openBlockedReason) throw new Error(this.openBlockedReason);
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

  /** Bounded node-local TCP listener discovery (no argv/env/payload data). */
  async listeningPorts(): Promise<AgentdListeningPortsSnapshot> {
    if (!this.supports('listening_ports_v1')) {
      throw new AgentdCapabilityUnavailableError('listening_ports_v1');
    }
    this.send({ op: 'listeningPorts' });
    const response = await this.await((control) => control.op === 'listeningPorts');
    const ports = (response.listeningPorts ?? [])
      .slice(0, 256)
      .filter(
        (port): port is AgentdListeningPort =>
          Number.isInteger(port.port) &&
          port.port >= 1024 &&
          port.port <= 65_535 &&
          (port.targetHost === '127.0.0.1' || port.targetHost === '::1'),
      )
      .map((port) => ({
        ...port,
        observationKey: port.observationKey?.slice(0, 256) ?? `tcp:${port.targetHost}:${port.port}`,
        process: port.process?.slice(0, 128),
        cwd: port.cwd?.slice(0, 1024),
        sessionId: port.sessionId?.slice(0, 128),
      }));
    return {
      ports,
      observedAt:
        response.observedAt && Number.isFinite(Date.parse(response.observedAt))
          ? new Date(response.observedAt).toISOString()
          : new Date().toISOString(),
      degradedReason: response.discoveryError?.slice(0, 512) || null,
    };
  }

  /** Execute one bounded command over a dedicated authenticated operation link. */
  async exec(request: AgentdExecRequest): Promise<AgentdExecResult> {
    if (!this.supports('exec_v1')) throw new AgentdCapabilityUnavailableError('exec_v1');
    const id = randomUUID();
    this.send({ op: 'exec', id, ...request });
    const response = await this.await(
      (control) => control.id === id && (control.op === 'execResult' || control.op === 'error'),
      Math.max(10_000, Math.min((request.timeoutMs ?? 30_000) + 5_000, 125_000)),
    );
    if (response.op === 'error') {
      throw new Error(`agentd exec failed: ${response.message ?? 'unknown error'}`);
    }
    return {
      exitCode: response.signal ? null : (response.code ?? 0),
      signal: response.signal ?? null,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      timedOut: response.timedOut === true,
      stdoutTruncated: response.stdoutTruncated === true,
      stderrTruncated: response.stderrTruncated === true,
    };
  }

  /** Dial runtime loopback over a dedicated authenticated operation link. */
  async dialTcp(port: number, host: '127.0.0.1' | '::1' = '127.0.0.1'): Promise<Duplex> {
    if (!this.supports('tcp_tunnel_v1')) {
      throw new AgentdCapabilityUnavailableError('tcp_tunnel_v1');
    }
    if (this.tcpTunnel) throw new Error('agentd operation link already owns a TCP tunnel');
    const id = randomUUID();
    const tunnel = new AgentdTcpDuplex({
      write: (data, callback) => this.writeFrame(encodeTcpInput(data), callback),
      closeWrite: () => this.send({ op: 'tcpCloseWrite', id }),
      dispose: () => this.dispose(),
      pause: () => this.sock.pause(),
      resume: () => this.sock.resume(),
    });
    this.tcpTunnel = tunnel;
    this.send({ op: 'dialTcp', id, targetHost: host, targetPort: port });
    const response = await this.await(
      (control) => control.id === id && (control.op === 'tcpConnected' || control.op === 'error'),
      5_000,
    );
    if (response.op === 'error') {
      this.tcpTunnel = null;
      tunnel.destroy();
      throw new Error(`agentd TCP tunnel failed: ${response.message ?? 'unknown error'}`);
    }
    return tunnel;
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

interface AgentdTcpDuplexDeps {
  write(data: Buffer, callback: (error?: Error | null) => void): void;
  closeWrite(): void;
  dispose(): void;
  pause(): void;
  resume(): void;
}

/** Backpressure-aware stream facade for one dedicated agentd TCP tunnel. */
class AgentdTcpDuplex extends Duplex {
  private remoteEnded = false;
  private disposed = false;

  constructor(private readonly deps: AgentdTcpDuplexDeps) {
    super({ readableHighWaterMark: 64 << 10, writableHighWaterMark: 64 << 10 });
  }

  receive(data: Buffer): void {
    if (this.remoteEnded || this.destroyed) return;
    if (!this.push(data)) this.deps.pause();
  }

  remoteClose(message?: string): void {
    if (this.remoteEnded) return;
    this.remoteEnded = true;
    if (message) {
      this.destroy(new Error(message));
    } else {
      this.push(null);
    }
  }

  disconnect(error: Error): void {
    if (this.destroyed) return;
    this.destroy(this.remoteEnded ? undefined : error);
  }

  override _read(): void {
    this.deps.resume();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.deps.write(data, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.deps.closeWrite();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.disposed) {
      this.disposed = true;
      this.deps.dispose();
    }
    callback(error);
  }
}
