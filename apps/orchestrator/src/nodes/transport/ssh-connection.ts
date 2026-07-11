/**
 * SupervisedSshConnection — the managed, autossh-style SSH connection that backs
 * an `ssh` node (US-8, spec §3 "Node transport", §4.1 "managed SSH connections,
 * autossh-style supervision"). It owns the ssh2 {@link Client} lifecycle and
 * hands out {@link SshTransport} instances that ride the live client.
 *
 * Responsibilities (all on the ORCHESTRATOR — nodes stay dumb, spec §4.3/§5.1):
 *   - connect() opens a managed connection: status connecting → connected;
 *   - an UNEXPECTED transport drop flips status to `disconnected` and the
 *     supervisor auto-reconnects with exponential backoff → connecting →
 *     connected (the autossh behaviour);
 *   - an auth/connect FAILURE surfaces status `error` (e.g. a bad key, spec §10);
 *   - dispose() is an INTENTIONAL shutdown: status `disconnected`, the client is
 *     ended, and NO reconnect is attempted.
 *
 * The status vocabulary is the SHARED {@link ConnectionStatus} from
 * `@flock/shared` (connected | connecting | disconnected | error) — the same
 * enum stored on `nodes.connection_status` (spec §6). It is never redefined here.
 *
 * The ssh2 client is reached through an injectable {@link SshConnector} so the
 * supervision state machine is unit-testable without a real sshd; the default
 * connector dials a real server with ssh2.
 */
import { createHash } from 'node:crypto';

import { Client, type ConnectConfig } from 'ssh2';

import {
  ReverseTunnel,
  type HookEndpointTarget,
  type TunnelHost,
} from '../tunnel/reverse-tunnel.js';
import { sshTunnelHost } from '../tunnel/ssh-tunnel-host.js';
import { sshAgentdHost, type AgentdHost } from '../agentd/ssh-agentd-host.js';
import type { ConnectionStatus } from '@flock/shared';

import { SshTransport } from './ssh-transport.js';

/**
 * The subset of an ssh2 Client the supervisor needs. Real ssh2 `Client`
 * instances satisfy this; the unit test injects a fake.
 */
export interface ManagedClient {
  /** Subscribe to the underlying connection closing. Returns an unsubscribe. */
  onClose(listener: (hadError: boolean) => void): () => void;
  /** Close the connection (intentional shutdown). */
  end(): void;
  /**
   * Build a {@link SshTransport} over THIS live connection. Implemented by the
   * real ssh2-backed client; the unit-test fake throws (those tests exercise the
   * supervision state machine, not the transport, which is covered by the int
   * test against a real sshd). Keeping construction here confines the concrete
   * ssh2 `Client` type to one place.
   */
  makeTransport(): SshTransport;
  /**
   * Build a {@link TunnelHost} over THIS live connection so the owner can run a
   * loopback reverse tunnel for agent hook callbacks (US-9). Optional: the
   * unit-test fake omits it (those tests don't exercise the tunnel). Confines the
   * concrete ssh2 reverse-forward API to the real client.
   */
  makeTunnelHost?(): TunnelHost;
  /**
   * Build an {@link AgentdHost} over THIS live connection so the owner can reach
   * the node's flock-agentd daemon: a direct-tcpip channel to its loopback addr,
   * plus sftp/exec for bootstrap. Optional: the unit-test fake omits it. Confines
   * the concrete ssh2 outbound APIs (forwardOut/sftp/exec) to the real client.
   */
  makeAgentdHost?(): AgentdHost;
}

/** Opens a fresh managed client, or rejects (auth failure, unreachable, …). */
export type SshConnector = (config: SshConnectionConfig) => Promise<ManagedClient>;

/** Exponential-backoff policy for autossh-style reconnection. */
export interface ReconnectPolicy {
  /** Delay before the first reconnect attempt (ms). */
  initialDelayMs: number;
  /** Upper bound on the backoff delay (ms). */
  maxDelayMs: number;
  /** Multiplier applied after each failed attempt. */
  factor: number;
  /**
   * Max reconnect attempts before giving up and going to `error`. Omit for
   * unlimited (the production default: keep trying like autossh).
   */
  maxRetries?: number;
}

const DEFAULT_RECONNECT: ReconnectPolicy = {
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  factor: 2,
};

/** Connection parameters for an SSH node (spec §6 nodes: host/port/user/key). */
export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  /** Decrypted private key material (from the SecretStore, US-3). Omit for
   * password auth. */
  privateKey?: Buffer | string;
  /** Optional passphrase for an encrypted key. */
  passphrase?: string;
  /** Decrypted password for password auth (mutually exclusive with privateKey). */
  password?: string;
  /** Optional reconnect policy override. */
  reconnect?: Partial<ReconnectPolicy>;
  /**
   * T7 — host-key pinning. Called with the server's host-key fingerprint
   * (`SHA256:<base64>`, OpenSSH style) before the handshake completes. Return
   * `true` to accept (first-use → pin it; later → it matched the pin) or `false`
   * to reject (a changed key = possible MITM). Omit to skip verification.
   */
  verifyHostKey?: (fingerprint: string) => boolean | Promise<boolean>;
  /**
   * When set, a loopback reverse tunnel is established (and re-established on each
   * reconnect) over this connection so agents on the node can POST hook callbacks
   * to `127.0.0.1:<remotePort>` and have them forwarded to the orchestrator's hook
   * endpoint at `target` (US-9, NFR-SEC4). Omit (local nodes) for no tunnel.
   */
  tunnel?: {
    /** The orchestrator hook endpoint forwarded connections are piped to. */
    target: HookEndpointTarget;
    /** Loopback port to request on the node (0 → sshd-assigned). */
    remotePort?: number;
  };
}

/**
 * OpenSSH-style host-key fingerprint: `SHA256:<base64(sha256(key))>` with the
 * trailing base64 padding stripped (matching `ssh-keygen -lf`). Used by the
 * host-key pin (T7) so stored/compared values are human-recognisable.
 */
export function sshHostKeyFingerprint(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

/** A live ssh2 Client wrapped to satisfy {@link ManagedClient}. */
class RealManagedClient implements ManagedClient {
  constructor(
    private readonly client: Client,
    private readonly closeListeners: Set<(hadError: boolean) => void>,
  ) {}

  makeTransport(): SshTransport {
    return new SshTransport(this.client);
  }

  makeTunnelHost(): TunnelHost {
    return sshTunnelHost(this.client);
  }

  makeAgentdHost(): AgentdHost {
    return sshAgentdHost(this.client);
  }

  onClose(listener: (hadError: boolean) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  end(): void {
    this.client.end();
  }
}

/**
 * The default, real ssh2 connector. Resolves once the client is `ready`;
 * rejects on `error` BEFORE ready (auth/connect failure). After ready, `close`
 * is surfaced through {@link ManagedClient.onClose} for the supervisor.
 */
export const defaultSshConnector: SshConnector = (config) =>
  new Promise<ManagedClient>((resolve, reject) => {
    const client = new Client();
    const closeListeners = new Set<(hadError: boolean) => void>();
    let ready = false;

    client.on('ready', () => {
      ready = true;
      resolve(new RealManagedClient(client, closeListeners));
    });
    client.on('error', (err: Error) => {
      if (!ready) {
        reject(err);
      }
      // Post-ready errors precede a 'close'; the supervisor handles close.
    });
    client.on('close', () => {
      // hadError isn't reliably passed by ssh2's 'close'; treat any post-ready
      // close as an unexpected drop unless dispose() ended it (the supervisor
      // distinguishes intentional vs unexpected via its own flag).
      for (const l of [...closeListeners]) l(true);
    });

    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      // Key auth (privateKey + optional passphrase) OR password auth — set only
      // the fields present so ssh2 picks the right method.
      ...(config.privateKey !== undefined
        ? { privateKey: config.privateKey, passphrase: config.passphrase }
        : {}),
      ...(config.password !== undefined ? { password: config.password } : {}),
      // Keepalives let us detect a dead link promptly (autossh-style probing).
      keepaliveInterval: 5000,
      keepaliveCountMax: 3,
      readyTimeout: 15_000,
    };
    // T7 — verify (and trust-on-first-use pin) the server's host key. ssh2 hands
    // us the raw host-key buffer; we present an OpenSSH-style SHA256 fingerprint
    // to the policy callback and reject the handshake if it returns false.
    if (config.verifyHostKey) {
      const verify = config.verifyHostKey;
      connectConfig.hostVerifier = (key: Buffer, cb: (ok: boolean) => void) => {
        const fp = sshHostKeyFingerprint(key);
        void Promise.resolve(verify(fp))
          .then((ok) => cb(ok))
          .catch(() => cb(false));
      };
    }
    client.connect(connectConfig);
  });

export class SupervisedSshConnection {
  private _status: ConnectionStatus = 'disconnected';
  private client: ManagedClient | null = null;
  private offClose: (() => void) | null = null;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private readonly policy: ReconnectPolicy;
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  /** Live reverse tunnel for hook callbacks (US-9); re-created on each connect. */
  private tunnel: ReverseTunnel | null = null;
  /** Pending tunnel-rebind retry (the tunnel is best-effort; the transport is up). */
  private tunnelRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: SshConnectionConfig,
    private readonly connector: SshConnector = defaultSshConnector,
    policy?: Partial<ReconnectPolicy>,
  ) {
    this.policy = { ...DEFAULT_RECONNECT, ...config.reconnect, ...policy };
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  /** Subscribe to status changes. Returns an unsubscribe disposer. */
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(next: ConnectionStatus): void {
    if (this._status === next) return;
    this._status = next;
    for (const l of [...this.statusListeners]) l(next);
  }

  /**
   * Open the managed connection. Resolves once connected; rejects (and sets
   * status `error`) if the INITIAL connect fails — but still schedules the
   * autossh-style reconnect loop so a node that was offline at boot can come
   * online later without an orchestrator restart. After a successful connect,
   * later drops are handled by the supervisor, not by this promise.
   */
  async connect(): Promise<void> {
    if (this.disposed) throw new Error('SupervisedSshConnection has been disposed.');
    this.setStatus('connecting');
    try {
      await this.openOnce();
    } catch (err) {
      this.setStatus('error');
      // Keep trying: VMs / networks often appear after the orchestrator boots.
      // Without this, a failed initial connect left the node stuck in `error`
      // forever (reconnect was only scheduled after a post-connected drop).
      this.scheduleReconnect();
      throw err;
    }
  }

  /** One connect attempt; wires up drop-handling on success. */
  private async openOnce(): Promise<void> {
    const client = await this.connector(this.config);
    if (this.disposed) {
      // Raced with dispose(): close immediately, do not adopt.
      client.end();
      return;
    }
    this.client = client;
    this.attempt = 0;
    this.offClose = client.onClose((hadError) => this.handleDrop(hadError));
    this.setStatus('connected');
    // Bring up the hook reverse tunnel over the fresh connection (US-9). Best
    // effort: a tunnel failure must NOT break the transport (the agent still
    // runs; only loopback hook callbacks would be unavailable).
    this.startTunnel(client);
  }

  /**
   * (Re)establish the loopback reverse tunnel for hook callbacks over `client`
   * (US-9). No-op when no tunnel is configured (local nodes) or the managed
   * client cannot surface a tunnel host (the unit-test fake). Fire-and-forget so
   * a tunnel failure never blocks or fails the connect.
   */
  private startTunnel(client: ManagedClient, attempt = 0): void {
    const cfg = this.config.tunnel;
    if (!cfg || !client.makeTunnelHost) return;
    // Bail if a drop/dispose superseded this client between scheduling and now —
    // the next connect's startTunnel owns the fresh tunnel.
    if (this.disposed || this.client !== client) return;
    const tunnel = new ReverseTunnel(client.makeTunnelHost(), cfg.target, {
      remotePort: cfg.remotePort,
    });
    this.tunnel = tunnel;
    void tunnel.start().catch((err) => {
      if (this.tunnel === tunnel) this.tunnel = null;
      if (this.disposed || this.client !== client) return; // dropped/superseded
      // The tunnel is best-effort (the agent still runs; only loopback hook
      // callbacks would be unavailable), so a bind failure must NOT touch the
      // transport — but DO retry with backoff before giving up, otherwise a
      // transient bind race after a reconnect silently kills this node's hooks
      // until the next full reconnect.
      const MAX_RETRIES = 5;
      if (attempt >= MAX_RETRIES) {
        console.warn(
          `[ssh-connection] hook reverse tunnel failed to start after ${MAX_RETRIES + 1} attempts; ` +
            `hook callbacks are DEGRADED for this node until the next reconnect: ${String(err)}`,
        );
        return;
      }
      const delay = Math.min(500 * 2 ** attempt, 10_000);
      console.warn(
        `[ssh-connection] hook reverse tunnel start failed ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${delay}ms: ${String(err)}`,
      );
      this.tunnelRetryTimer = setTimeout(() => {
        this.tunnelRetryTimer = null;
        this.startTunnel(client, attempt + 1);
      }, delay);
    });
  }

  /** The loopback port the node curls for hook callbacks, or null if no tunnel. */
  hookTunnelPort(): number | null {
    return this.tunnel?.remotePort ?? null;
  }

  /** Unexpected transport drop → disconnected, then schedule reconnect. */
  private handleDrop(_hadError: boolean): void {
    if (this.disposed) return;
    this.detachClient();
    this.setStatus('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;

    if (this.policy.maxRetries !== undefined && this.attempt >= this.policy.maxRetries) {
      this.setStatus('error');
      return;
    }

    const delay = Math.min(
      this.policy.initialDelayMs * this.policy.factor ** this.attempt,
      this.policy.maxDelayMs,
    );
    this.attempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.setStatus('connecting');
      this.openOnce().catch(() => {
        if (this.disposed) return;
        // Attempt failed: fall back to disconnected and try again (backoff).
        this.setStatus('disconnected');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private detachClient(): void {
    if (this.offClose) {
      this.offClose();
      this.offClose = null;
    }
    // The forward dies with the connection; abandon the tunnel (the dead client
    // would never fire unforwardIn's callback, so do NOT await stop() here). A
    // fresh tunnel is created by startTunnel() on the next successful connect.
    if (this.tunnelRetryTimer) {
      clearTimeout(this.tunnelRetryTimer);
      this.tunnelRetryTimer = null;
    }
    this.tunnel = null;
    this.client = null;
  }

  /**
   * Build a {@link NodeTransport} over the live connection. Throws if not
   * currently connected or after dispose. Cheap: many transports may share the
   * one underlying client.
   */
  transport(): SshTransport {
    if (this.disposed) throw new Error('SupervisedSshConnection has been disposed.');
    if (!this.client || this._status !== 'connected') {
      throw new Error(`SSH connection is not ready (status: ${this._status}).`);
    }
    return this.client.makeTransport();
  }

  /**
   * Build an {@link AgentdHost} over the live connection (direct-tcpip + sftp +
   * exec) for the flock-agentd remote path. Throws if not connected / disposed,
   * or if the managed client cannot surface one (the unit-test fake).
   */
  agentdHost(): AgentdHost {
    if (this.disposed) throw new Error('SupervisedSshConnection has been disposed.');
    if (!this.client || this._status !== 'connected') {
      throw new Error(`SSH connection is not ready (status: ${this._status}).`);
    }
    if (!this.client.makeAgentdHost) {
      throw new Error('This SSH connection does not support flock-agentd.');
    }
    return this.client.makeAgentdHost();
  }

  /** Test-only: force the underlying link down as if the socket died. */
  forceDropForTest(): void {
    // Ending the real client triggers ssh2's 'close', which the supervisor sees
    // as an unexpected drop (we have NOT set the disposed flag).
    this.client?.end();
  }

  /**
   * Intentional shutdown: stop supervision, end the client, go `disconnected`.
   * Idempotent. After dispose the supervisor never reconnects.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.tunnelRetryTimer) {
      clearTimeout(this.tunnelRetryTimer);
      this.tunnelRetryTimer = null;
    }
    // Capture before detach (detachClient nulls this.client) so we can end it.
    const client = this.client;
    if (this.offClose) {
      this.offClose();
      this.offClose = null;
    }
    // Cancel the remote forward while the client is STILL alive (so unforwardIn's
    // callback fires) before ending the connection. Best-effort.
    const tunnel = this.tunnel;
    this.tunnel = null;
    if (tunnel) {
      try {
        await tunnel.dispose();
      } catch {
        // ignore — we're ending the client next anyway
      }
    }
    this.client = null;
    try {
      client?.end();
    } catch {
      // ignore
    }
    // Set terminal status last so listeners observe `disconnected`.
    this.setStatus('disconnected');
  }
}
