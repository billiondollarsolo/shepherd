/**
 * NodeConnectionManager — the orchestrator-level owner of live node connections
 * (the piece that makes an `ssh` node actually CONNECT, not just sit in the DB).
 *
 * For each node it resolves a {@link NodeTransport}:
 *   - `local` → a shared {@link LocalTransport} (no hop).
 *   - `ssh`   → a {@link SupervisedSshConnection} (managed ssh2 + autossh-style
 *               reconnect, US-8). It decrypts the node's private key via the
 *               {@link SecretStore} (US-3), connects, and mirrors the live
 *               connection status onto `nodes.connection_status` in Postgres so
 *               the sidebar reflects reality.
 *
 * This is the central brain; nodes stay dumb couriers (spec §6.4). It is wired
 * into `index.ts` so adding an SSH node in the UI triggers a real connection, and
 * session-create/diff/pty obtain the right transport through `transportFor`.
 */
import { eq } from 'drizzle-orm';

import type { ConnectionStatus, Node as SharedNode } from '@flock/shared';
import { SECRET_NONCE_BYTES } from '@flock/shared';

import type { Database } from '../db/client.js';
import { nodes, secrets } from '../db/schema.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { LocalTransport } from './transport/local-transport.js';
import type { NodeTransport } from './transport/transport.js';
import { SupervisedSshConnection, type SshConnectionConfig } from './transport/ssh-connection.js';
import type { HookEndpointTarget } from './tunnel/reverse-tunnel.js';
import type { AgentdHost } from './agentd/ssh-agentd-host.js';
import { DEFAULT_SSH_PORT, parseCredential } from './node-service.js';

export interface NodeConnectionManagerDeps {
  db: Database;
  secrets: SecretStore;
  /** Reconnect policy override (tests use fast backoff). */
  reconnect?: SshConnectionConfig['reconnect'];
  logger?: { warn(msg: string, err?: unknown): void; info?(msg: string): void };
  /**
   * Fired on every SSH node connectivity change (after the DB mirror). Used to
   * drive reconcile (down→re-probe on reconnect, FR-N4). `prev` is the prior
   * status (undefined on the first transition).
   */
  onConnectivityChange?: (
    nodeId: string,
    status: ConnectionStatus,
    prev: ConnectionStatus | undefined,
  ) => void;
  /**
   * When set, every SSH node gets a loopback reverse tunnel (US-9): agents on the
   * node POST hook callbacks to `127.0.0.1:<remotePort>` and they are forwarded
   * over the managed connection to `target` (the orchestrator's hook endpoint).
   * Omit to disable hook tunnels entirely.
   */
  hookTunnel?: {
    /** The orchestrator hook endpoint forwarded connections are piped to. */
    target: HookEndpointTarget;
    /** Loopback port to request on the node (0/undefined → sshd-assigned). */
    remotePort?: number;
  };
}

export class NodeConnectionManager {
  private readonly db: Database;
  private readonly secrets: SecretStore;
  private readonly reconnect?: SshConnectionConfig['reconnect'];
  private readonly logger: { warn(msg: string, err?: unknown): void; info?(msg: string): void };
  private readonly onConnectivityChange?: NodeConnectionManagerDeps['onConnectivityChange'];
  private readonly hookTunnel?: NodeConnectionManagerDeps['hookTunnel'];

  /** One shared local transport for all local-node work. */
  private readonly local = new LocalTransport();
  /** Live SSH connections by node id. */
  private readonly ssh = new Map<string, SupervisedSshConnection>();
  /** In-flight connectNode() per node id — coalesces concurrent connects so a
   *  node-edit reconnect racing connectAll / a session launch can't build two
   *  SSH connections + hook tunnels and leak one. Cleared on settle. */
  private readonly connecting = new Map<string, Promise<void>>();

  constructor(deps: NodeConnectionManagerDeps) {
    this.db = deps.db;
    this.secrets = deps.secrets;
    this.reconnect = deps.reconnect;
    this.logger = deps.logger ?? { warn: (m, e) => console.warn(`[node-conn] ${m}`, e ?? '') };
    this.onConnectivityChange = deps.onConnectivityChange;
    this.hookTunnel = deps.hookTunnel;
  }

  /**
   * Connect to every `ssh` node in the registry (called on boot). Best-effort:
   * a node that fails to connect is left in `error`/`disconnected` and the others
   * still come up. Local nodes need no connection.
   */
  async connectAll(): Promise<void> {
    const rows = await this.db.select().from(nodes).where(eq(nodes.kind, 'ssh'));
    await Promise.all(rows.map((r) => this.connectNode(r.id).catch(() => undefined)));
  }

  /**
   * Establish (or re-establish) the supervised SSH connection for a node id.
   * Decrypts the key, connects, and mirrors status transitions to Postgres.
   * Resolves once the initial connect succeeds; rejects if it fails (status is
   * persisted as `error` either way). Idempotent: a second call for an already
   * managed node is a no-op.
   */
  async connectNode(nodeId: string): Promise<void> {
    if (this.ssh.has(nodeId)) return;
    const inflight = this.connecting.get(nodeId);
    if (inflight) return inflight;
    const p = this.doConnectNode(nodeId).finally(() => this.connecting.delete(nodeId));
    this.connecting.set(nodeId, p);
    return p;
  }

  /** The actual connect — serialized per node by {@link connectNode}'s in-flight map. */
  private async doConnectNode(nodeId: string): Promise<void> {
    if (this.ssh.has(nodeId)) return;

    const [row] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!row) throw new Error(`Node ${nodeId} not found.`);
    if (row.kind !== 'ssh') return; // local needs no connection
    if (!row.host || !row.sshUser || !row.sshKeyRef) {
      throw new Error(`Node ${nodeId} is missing host/user/key.`);
    }

    // Decrypt the private key (US-3). The secrets row stores nonce||authTag.
    const [secret] = await this.db
      .select()
      .from(secrets)
      .where(eq(secrets.id, row.sshKeyRef))
      .limit(1);
    if (!secret) throw new Error(`SSH key secret for node ${nodeId} not found.`);

    const nonceBytes = new Uint8Array(secret.nonce);
    // The secrets row stores nonce(SECRET_NONCE_BYTES) || authTag(trailing 16).
    const credText = await this.secrets.decryptToString(
      {
        ciphertext: new Uint8Array(secret.ciphertext),
        nonce: nonceBytes.slice(0, SECRET_NONCE_BYTES),
        authTag: nonceBytes.slice(SECRET_NONCE_BYTES),
        keyVersion: secret.keyVersion,
      },
      { secretId: secret.id },
    );
    // The secret is a bundled credential envelope ({privateKey,passphrase,password})
    // — or a legacy raw key string. `sshAuthMethod` picks which fields to use.
    const cred = parseCredential(credText);
    const authMethod = (row.sshAuthMethod as 'key' | 'password' | null) ?? 'key';
    const authConfig: Pick<SshConnectionConfig, 'privateKey' | 'passphrase' | 'password'> =
      authMethod === 'password'
        ? { password: cred.password }
        : { privateKey: cred.privateKey, passphrase: cred.passphrase };

    // T7 — host-key pin (trust-on-first-use). `pinned` starts from the DB row;
    // the first connect with no pin records the presented key, and every later
    // connect (incl. reconnects, which reuse this same closure) must match it or
    // be rejected as a possible MITM. Closure state survives reconnects because
    // SupervisedSshConnection captures this config object once.
    let pinned = row.sshHostKey ?? null;
    const verifyHostKey = async (fingerprint: string): Promise<boolean> => {
      if (!pinned) {
        pinned = fingerprint;
        try {
          await this.db.update(nodes).set({ sshHostKey: fingerprint }).where(eq(nodes.id, nodeId));
        } catch (err) {
          this.logger.warn(`Failed to persist SSH host key for node ${nodeId}`, err);
        }
        this.logger.info?.(`Pinned SSH host key for node ${nodeId}: ${fingerprint}`);
        return true;
      }
      if (pinned === fingerprint) return true;
      this.logger.warn(
        `SSH host key mismatch for node ${nodeId}: expected ${pinned}, got ${fingerprint} — rejecting (possible MITM). Clear nodes.ssh_host_key to re-pin.`,
      );
      return false;
    };

    const conn = new SupervisedSshConnection(
      {
        host: row.host,
        port: row.port ?? DEFAULT_SSH_PORT,
        username: row.sshUser,
        ...authConfig,
        verifyHostKey,
        reconnect: this.reconnect,
        tunnel: this.hookTunnel,
      },
      undefined,
      this.reconnect,
    );

    // Mirror every status change onto the DB row so the UI reflects reality, and
    // notify the connectivity hook (drives reconcile on reconnect, FR-N4).
    let prevStatus: ConnectionStatus | undefined;
    conn.onStatusChange((status) => {
      void this.persistStatus(nodeId, status);
      try {
        this.onConnectivityChange?.(nodeId, status, prevStatus);
      } catch {
        /* connectivity observers are best-effort */
      }
      prevStatus = status;
    });
    this.ssh.set(nodeId, conn);

    try {
      await conn.connect();
    } catch (err) {
      this.logger.warn(`SSH connect failed for node ${nodeId}`, err);
      // status already persisted as 'error' via onStatusChange; keep the managed
      // connection so its supervisor can retry, but surface the failure.
      throw err;
    }
  }

  /** Resolve a transport for a node id (local → shared; ssh → live connection). */
  async transportFor(nodeId: string): Promise<NodeTransport> {
    const [row] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!row) throw new Error(`Node ${nodeId} not found.`);
    if (row.kind === 'local') return this.local;

    let conn = this.ssh.get(nodeId);
    if (!conn) {
      await this.connectNode(nodeId);
      conn = this.ssh.get(nodeId);
    }
    if (!conn) throw new Error(`No SSH connection for node ${nodeId}.`);
    return conn.transport();
  }

  /** Current managed status for a node (falls back to the DB row when unmanaged). */
  statusOf(nodeId: string): ConnectionStatus | undefined {
    return this.ssh.get(nodeId)?.status;
  }

  /**
   * Wait until an ssh node's link is `connected` (kicking a connect if none is
   * managed yet), up to timeoutMs. Lets a session launched right after an
   * orchestrator restart ride out the brief (re)connect window instead of failing
   * with a dead/blank session. Returns true if connected within the timeout.
   */
  async waitForConnected(nodeId: string, timeoutMs = 8000): Promise<boolean> {
    if (!this.ssh.get(nodeId)) {
      try {
        await this.connectNode(nodeId);
      } catch {
        /* keep polling — the supervisor may still bring it up */
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.statusOf(nodeId) === 'connected') return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.statusOf(nodeId) === 'connected';
  }

  /**
   * An {@link AgentdHost} over the node's live SSH connection (direct-tcpip + sftp
   * + exec) for the flock-agentd remote path. Connects the node if needed. Throws
   * for a local node (use the unix socket) or if the connection isn't ready.
   */
  async agentdHostFor(nodeId: string): Promise<AgentdHost> {
    const [row] = await this.db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!row) throw new Error(`Node ${nodeId} not found.`);
    if (row.kind === 'local') throw new Error(`Node ${nodeId} is local; use the unix socket.`);
    let conn = this.ssh.get(nodeId);
    if (!conn) {
      await this.connectNode(nodeId);
      conn = this.ssh.get(nodeId);
    }
    if (!conn) throw new Error(`No SSH connection for node ${nodeId}.`);
    return conn.agentdHost();
  }

  /**
   * The loopback port an agent on `nodeId` curls for hook callbacks — the live
   * reverse-tunnel port (US-9). Null for local nodes, an unmanaged node, or while
   * the tunnel is not established. Used to build `FLOCK_HOOK_URL` for SSH nodes.
   */
  hookTunnelPort(nodeId: string): number | null {
    return this.ssh.get(nodeId)?.hookTunnelPort() ?? null;
  }

  /** Tear down a node's connection (on delete). Idempotent. */
  async disconnectNode(nodeId: string): Promise<void> {
    const conn = this.ssh.get(nodeId);
    if (!conn) return;
    this.ssh.delete(nodeId);
    await conn.dispose();
  }

  /** Dispose every managed connection (shutdown). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.ssh.values()].map((c) => c.dispose().catch(() => undefined)));
    this.ssh.clear();
    await this.local.dispose().catch(() => undefined);
  }

  private async persistStatus(nodeId: string, status: ConnectionStatus): Promise<void> {
    try {
      await this.db
        .update(nodes)
        .set({
          connectionStatus: status,
          lastSeenAt: status === 'connected' ? new Date() : undefined,
        })
        .where(eq(nodes.id, nodeId));
    } catch (err) {
      this.logger.warn(`failed to persist status ${status} for node ${nodeId}`, err);
    }
  }
}

/** Map a {@link SharedNode} to a one-line connection summary (debug/logging). */
export function nodeConnDescription(node: SharedNode): string {
  return node.kind === 'ssh'
    ? `${node.sshUser}@${node.host}:${node.port ?? DEFAULT_SSH_PORT}`
    : 'local';
}
