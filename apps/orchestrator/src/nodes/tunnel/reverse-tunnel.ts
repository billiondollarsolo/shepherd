/**
 * ReverseTunnel — the loopback-bound `ssh -R` reverse tunnel that carries agent
 * hook callbacks from a remote SSH node back to the orchestrator's hook endpoint
 * (US-9, spec §9 US-9; FR-N3; PRD §6.2 "reverse tunnel uses the connection we
 * already own"; NFR-SEC4 "reverse tunnels bound to node loopback only — no
 * GatewayPorts").
 *
 * How it works (all orchestrator-side; the node stays a DUMB COURIER, spec
 * §4.3/§5.1 — it only runs sshd + `curl`):
 *   - It rides the SAME managed ssh2 connection that {@link SupervisedSshConnection}
 *     already owns (no second `ssh` process, no extra inbound port on the node).
 *   - `start()` asks the node's sshd to listen on `127.0.0.1:<remotePort>` via the
 *     SSH `tcpip-forward` global request (ssh2 `Client.forwardIn`). Because the
 *     bind address is the LOOPBACK address, OpenSSH never applies `GatewayPorts`
 *     (which only ever widens a `0.0.0.0`/empty bind to external interfaces). The
 *     forwarded port is therefore reachable ONLY from the node itself — exactly
 *     what NFR-SEC4 requires.
 *   - When something on the node connects to that loopback port (the agent's hook
 *     `curl localhost:<remotePort>/api/hooks/<sessionId>`), sshd opens a
 *     `forwarded-tcpip` channel back over the existing connection. The tunnel
 *     accepts it and pipes the bytes to the orchestrator's hook endpoint
 *     (`target.host:target.port`, default loopback) — so `curl localhost` on the
 *     node reaches the orchestrator.
 *
 * The concrete ssh2 `Client` is reached through an injectable {@link TunnelHost}
 * seam (mirroring the {@link SshConnector}/{@link ManagedClient} pattern in
 * ssh-connection.ts) so the loopback-binding and channel-piping logic is
 * unit-testable with a fake host; the real-ssh path is covered by the int test.
 */
import { connect as netConnect, type Socket } from 'node:net';

/**
 * The orchestrator endpoint a forwarded hook connection is piped to. Defaults to
 * the orchestrator's own loopback HTTP listener (the hook endpoint,
 * `POST /api/hooks/:sessionId`, spec §8.1).
 */
export interface HookEndpointTarget {
  /** Host to dial for the orchestrator hook endpoint. Default `127.0.0.1`. */
  host: string;
  /** Port the orchestrator hook HTTP server listens on. */
  port: number;
}

/**
 * A forwarded `forwarded-tcpip` channel surfaced by the SSH layer. It is a
 * duplex byte stream (the subset of an ssh2 `ServerChannel`/`Channel` the tunnel
 * needs): it can be piped to/from a {@link Socket}.
 */
export interface ForwardedChannel {
  pipe<T extends NodeJS.WritableStream>(destination: T): T;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  end(): void;
  destroy(): void;
}

/** Details of an inbound forwarded connection (from ssh2's `tcp connection`). */
export interface ForwardedConnectionInfo {
  /** The bind address the node listened on — MUST be loopback for US-9. */
  destIP: string;
  /** The forwarded (loopback) port on the node. */
  destPort: number;
  srcIP: string;
  srcPort: number;
}

/**
 * The subset of an ssh2 `Client` the reverse tunnel needs. The real ssh2 Client
 * satisfies this; unit tests inject a fake. Keeping it minimal confines the
 * concrete ssh2 type to {@link SupervisedSshConnection}/the real host adapter.
 */
export interface TunnelHost {
  /**
   * Request that the node's sshd listen on `bindAddr:bindPort` (SSH
   * `tcpip-forward`). `bindPort` 0 lets sshd choose; the chosen port is returned
   * to the callback. Returns false on backpressure (channel could not be opened).
   */
  forwardIn(
    bindAddr: string,
    bindPort: number,
    callback: (err: Error | undefined, port: number) => void,
  ): boolean;

  /** Cancel a previously-established remote forward. */
  unforwardIn(bindAddr: string, bindPort: number, callback?: (err?: Error) => void): void;

  /**
   * Subscribe to inbound forwarded connections. `accept()` yields the duplex
   * channel to pipe to the orchestrator; `reject()` refuses the connection.
   */
  on(
    event: 'tcp connection',
    listener: (
      info: ForwardedConnectionInfo,
      accept: () => ForwardedChannel,
      reject: () => void,
    ) => void,
  ): this;

  /** Remove a previously-added `tcp connection` listener. */
  off(
    event: 'tcp connection',
    listener: (
      info: ForwardedConnectionInfo,
      accept: () => ForwardedChannel,
      reject: () => void,
    ) => void,
  ): this;
}

/** Opens a TCP connection to the orchestrator hook endpoint (injectable for tests). */
export type HookDialer = (target: HookEndpointTarget) => Socket;

const defaultHookDialer: HookDialer = (target) =>
  netConnect({ host: target.host, port: target.port });

/**
 * THE loopback bind address. Hard-coded, never configurable: binding the remote
 * forward to loopback is the entire NFR-SEC4 guarantee. Using `0.0.0.0` or `''`
 * would (with `GatewayPorts yes`) expose the hook port on the node's external
 * interfaces — which this product must never do.
 */
export const TUNNEL_LOOPBACK_BIND_ADDRESS = '127.0.0.1';

export interface ReverseTunnelOptions {
  /**
   * Loopback port to request on the node. Default 0 → sshd assigns a free port,
   * read back via {@link ReverseTunnel.remotePort}. The node curls this port.
   */
  remotePort?: number;
  /** Injectable dialer to the orchestrator hook endpoint (tests). */
  dialer?: HookDialer;
}

/**
 * A loopback-bound reverse tunnel over one managed SSH connection (US-9).
 *
 * Lifecycle: `start()` establishes the remote forward and begins piping inbound
 * hook connections to the orchestrator; `stop()`/`dispose()` cancel the forward
 * and tear down any live channels. Re-establishment after an autossh reconnect is
 * handled by the owner that re-`start()`s the tunnel on the supervised
 * connection's `connected` transition (see ssh-connection integration, US-8).
 */
export class ReverseTunnel {
  private readonly bindAddress = TUNNEL_LOOPBACK_BIND_ADDRESS;
  private readonly requestedPort: number;
  private readonly dialer: HookDialer;

  private _remotePort: number | null = null;
  private started = false;
  private disposed = false;
  private readonly liveChannels = new Set<ForwardedChannel>();
  private readonly liveSockets = new Set<Socket>();

  private connectionListener:
    | ((info: ForwardedConnectionInfo, accept: () => ForwardedChannel, reject: () => void) => void)
    | null = null;

  constructor(
    private readonly host: TunnelHost,
    private readonly target: HookEndpointTarget,
    options: ReverseTunnelOptions = {},
  ) {
    this.requestedPort = options.remotePort ?? 0;
    this.dialer = options.dialer ?? defaultHookDialer;
  }

  /** The loopback bind address the node listens on (always `127.0.0.1`). */
  get bindAddr(): string {
    return this.bindAddress;
  }

  /**
   * The loopback port assigned on the node (the `<port>` a node `curl
   * localhost:<port>` targets). Null until {@link start} resolves.
   */
  get remotePort(): number | null {
    return this._remotePort;
  }

  /** Whether the remote forward is currently established. */
  get isActive(): boolean {
    return this.started && !this.disposed;
  }

  /**
   * Establish the loopback-bound remote forward and start piping inbound hook
   * connections to the orchestrator. Resolves with the assigned loopback port.
   */
  async start(): Promise<number> {
    if (this.disposed) throw new Error('ReverseTunnel has been disposed.');
    if (this.started) return this._remotePort as number;

    const port = await new Promise<number>((resolve, reject) => {
      // SECURITY (NFR-SEC4): bind to LOOPBACK only. ssh2/OpenSSH apply
      // GatewayPorts only when the bind address is `0.0.0.0`/empty; a 127.0.0.1
      // bind is unreachable from off-host regardless of the node's GatewayPorts.
      const ok = this.host.forwardIn(this.bindAddress, this.requestedPort, (err, assignedPort) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(assignedPort);
      });
      if (!ok) {
        reject(
          new Error('Reverse tunnel forwardIn failed: global request could not be sent (backpressure).'),
        );
      }
    });

    if (this.disposed) {
      // Raced with dispose(): undo the forward we just created.
      this.host.unforwardIn(this.bindAddress, port);
      throw new Error('ReverseTunnel has been disposed.');
    }

    this._remotePort = port;
    this.connectionListener = (info, accept, reject) => this.handleForwardedConnection(info, accept, reject);
    this.host.on('tcp connection', this.connectionListener);
    this.started = true;
    return port;
  }

  /**
   * Bridge one inbound forwarded connection (a hook `curl` on the node) to the
   * orchestrator hook endpoint. Connections to a port OTHER than our forwarded
   * loopback port are ignored (another tunnel on the same client owns them).
   */
  private handleForwardedConnection(
    info: ForwardedConnectionInfo,
    accept: () => ForwardedChannel,
    reject: () => void,
  ): void {
    if (this.disposed || this._remotePort === null) {
      reject();
      return;
    }
    if (info.destPort !== this._remotePort || info.destIP !== this.bindAddress) {
      // Not ours — leave it for whoever owns that forward.
      return;
    }

    const channel = accept();
    const socket = this.dialer(this.target);
    this.liveChannels.add(channel);
    this.liveSockets.add(socket);

    const cleanup = (): void => {
      this.liveChannels.delete(channel);
      this.liveSockets.delete(socket);
    };

    // Bidirectional pipe: node-side hook request → orchestrator endpoint, and the
    // HTTP response back to the curl caller on the node.
    socket.on('connect', () => {
      channel.pipe(socket);
      socket.pipe(channel as unknown as NodeJS.WritableStream);
    });

    socket.on('error', () => {
      try {
        channel.destroy();
      } catch {
        // ignore
      }
      cleanup();
    });
    socket.on('close', () => {
      try {
        channel.end();
      } catch {
        // ignore
      }
      cleanup();
    });
    channel.on('error', () => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      cleanup();
    });
    channel.on('close', () => {
      try {
        socket.end();
      } catch {
        // ignore
      }
      cleanup();
    });
  }

  /** Cancel the remote forward and tear down live channels. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.connectionListener) {
      this.host.off('tcp connection', this.connectionListener);
      this.connectionListener = null;
    }

    const port = this._remotePort;
    if (port !== null) {
      await new Promise<void>((resolve) => {
        this.host.unforwardIn(this.bindAddress, port, () => resolve());
      });
    }
    this._remotePort = null;

    for (const socket of [...this.liveSockets]) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.liveSockets.clear();
    for (const channel of [...this.liveChannels]) {
      try {
        channel.destroy();
      } catch {
        // ignore
      }
    }
    this.liveChannels.clear();
  }

  /**
   * Permanent teardown. After dispose the tunnel cannot be re-started. The
   * underlying SSH connection is NOT closed here — {@link SupervisedSshConnection}
   * owns the connection lifecycle (one connection backs the transport AND the
   * tunnel).
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
  }
}
