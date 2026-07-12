/**
 * AgentdConnections — owns one {@link NodeAgentdClient} per node (the multiplexed
 * link to that node's flock-agentd), reused across all of the node's sessions.
 * LOCAL nodes connect over a unix socket; REMOTE nodes are bootstrapped over SSH
 * and reached via a direct-tcpip channel to the daemon's loopback addr.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { AgentdCompatibility } from '@flock/shared';

import { NodeAgentdClient } from './agentd-client.js';
import type { AgentdBootstrap } from './agentd-bootstrap.js';
import type { AgentdHost } from './ssh-agentd-host.js';
import type { NodeControlIdentity } from './node-control-credentials.js';
import { evaluateAgentdCompatibility } from './agentd-compatibility.js';
import type { AuthenticatedAgentdIdentity } from './agentd-client.js';
import { AGENTD_PROTOCOL_VERSION } from './protocol.js';

export type AgentdFailureCode = 'network' | 'authentication' | 'protocol' | 'enrollment';

export interface AgentdConnectionFailure {
  code: AgentdFailureCode;
  /** Stable, redacted operator guidance. Never the raw exception text. */
  message: string;
  at: string;
}

export interface AgentdUpgradeState {
  status: 'deferred' | 'rolled_back';
  installedVersion: string;
  expectedVersion: string;
  activeSessions: number;
  message: string;
  requirement: 'recommended' | 'required';
}

export class AgentdActiveSessionsError extends Error {
  constructor(readonly count: number) {
    super(`agentd upgrade requires ${count} active session(s) to finish`);
    this.name = 'AgentdActiveSessionsError';
  }
}

const FAILURE_MESSAGES: Record<AgentdFailureCode, string> = {
  network: 'The daemon control channel is unreachable.',
  authentication: 'The daemon rejected the node control credential.',
  protocol: 'The daemon and orchestrator control protocols are incompatible.',
  enrollment: 'The daemon could not be installed or upgraded safely.',
};

/** Convert internal failures to a stable, secret-free operator category. */
export function classifyAgentdFailure(error: unknown): AgentdFailureCode {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/credential|authentication|authenticate|\bmac\b|unauthenticated/.test(message)) {
    return 'authentication';
  }
  if (/protocol|version|challenge|capabilit/.test(message)) return 'protocol';
  if (/bootstrap|install|upgrade|checksum|architecture|service/.test(message)) return 'enrollment';
  return 'network';
}

export interface AgentdConnectionsDeps {
  /** Local daemon unix socket; defaults to the daemon's own default path. */
  socketPath?: string;
  /** Preferred-first protocol codecs retained by this orchestrator release. */
  supportedProtocolVersions?: readonly number[];
  /** Loads the unique encrypted-at-rest identity for exactly one node. */
  identityFor: (nodeId: string, kind: 'local' | 'ssh') => Promise<NodeControlIdentity>;
  /**
   * Derived agent-status push from any node's daemon (it tails the agent's
   * transcript). Wired into every client before the handshake so the daemon's
   * snapshot replay is captured. The caller feeds this into the live status map.
   */
  onStatus?: (sessionId: string, state: string, meta: { tokens?: number; tool?: string }) => void;
  /** Security audit seam. Payloads are stable categories and never raw errors. */
  onAudit?: (
    nodeId: string,
    event:
      | 'connected'
      | 'disconnected'
      | 'authentication_failed'
      | 'protocol_failed'
      | 'enrollment_failed',
  ) => void;
}

/** The daemon's default socket path (mirrors agentd/main.go defaultSocket). */
export function defaultLocalSocket(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return path.join(xdg, 'flock-agentd.sock');
  return path.join(os.tmpdir(), `flock-agentd-${process.getuid?.() ?? 0}.sock`);
}

export class AgentdConnections {
  private local: NodeAgentdClient | null = null;
  private localPending: Promise<NodeAgentdClient> | null = null;
  private readonly remotes = new Map<string, NodeAgentdClient>();
  private readonly remotePending = new Map<string, Promise<NodeAgentdClient>>();
  private readonly failures = new Map<string, AgentdConnectionFailure>();
  private readonly upgrades = new Map<string, AgentdUpgradeState>();
  private readonly compatibilities = new Map<string, AgentdCompatibility>();
  private readonly connectedNodes = new Set<string>();

  constructor(private readonly deps: AgentdConnectionsDeps) {}

  /**
   * Peek the cached client for a remote node WITHOUT connecting. A non-null
   * result means the multiplexed link is live (handshaked + channel open) — we
   * evict on channel close — so this doubles as the node's daemon link state for
   * health reporting.
   */
  peekRemote(nodeId: string): NodeAgentdClient | null {
    return this.remotes.get(nodeId) ?? null;
  }

  /** Peek the cached local-daemon client without connecting. */
  peekLocal(): NodeAgentdClient | null {
    return this.local;
  }

  /** Last redacted failure for a node, cleared after a successful authenticated link. */
  failureFor(nodeId: string): AgentdConnectionFailure | null {
    return this.failures.get(nodeId) ?? null;
  }

  /** Pending/failed-safe rollout state for operator-facing node readiness. */
  upgradeFor(nodeId: string): AgentdUpgradeState | null {
    return this.upgrades.get(nodeId) ?? null;
  }

  /** Last authenticated compatibility result for node lifecycle/readiness UI. */
  compatibilityFor(nodeId: string): AgentdCompatibility | null {
    return this.compatibilities.get(nodeId) ?? null;
  }

  private recordFailure(nodeId: string, error: unknown): void {
    const code = classifyAgentdFailure(error);
    const previous = this.failures.get(nodeId);
    this.failures.set(nodeId, {
      code,
      message: FAILURE_MESSAGES[code],
      at: new Date().toISOString(),
    });
    const wasConnected = this.connectedNodes.delete(nodeId);
    if (previous?.code === code && !wasConnected) return;
    const event =
      code === 'authentication'
        ? 'authentication_failed'
        : code === 'protocol'
          ? 'protocol_failed'
          : code === 'enrollment'
            ? 'enrollment_failed'
            : 'disconnected';
    this.deps.onAudit?.(nodeId, event);
  }

  private connected(nodeId: string): void {
    const transition = !this.connectedNodes.has(nodeId);
    this.connectedNodes.add(nodeId);
    this.failures.delete(nodeId);
    if (transition) this.deps.onAudit?.(nodeId, 'connected');
  }

  /**
   * Lightweight health probe of a remote node's daemon for the per-node dot:
   * is something answering on the loopback port? Connect-only — NO bootstrap (so
   * it never ships a binary from a health poll) and NO caching into the session
   * client map (so it can't bypass the session path's version-upgrade check). A
   * live cached session client trivially proves "up". The transient channel is
   * closed immediately. Returns false on any failure (daemon down / not yet
   * bootstrapped).
   */
  async probeRemote(nodeId: string, host: AgentdHost, port: number): Promise<boolean> {
    if (this.remotes.get(nodeId)) return true; // an active session link proves it
    const protocols = this.deps.supportedProtocolVersions ?? [AGENTD_PROTOCOL_VERSION];
    let lastError: unknown;
    for (const protocolVersion of protocols) {
      let client: NodeAgentdClient | null = null;
      try {
        const channel = await host.forwardOut('127.0.0.1', port);
        client = new NodeAgentdClient(channel);
        const identity = await this.deps.identityFor(nodeId, 'ssh');
        await client.hello(identity, protocolVersion);
        this.connected(nodeId);
        return true;
      } catch (error) {
        lastError = error;
        if (!/unsupported agentd protocol version/i.test(String(error))) break;
      } finally {
        client?.dispose();
      }
    }
    this.recordFailure(nodeId, lastError);
    return false;
  }

  /** Connect (once) to the local node's daemon and complete the handshake. */
  async clientForLocal(nodeId: string): Promise<NodeAgentdClient> {
    if (this.local) return this.local;
    if (this.localPending) return this.localPending;
    const socketPath = this.deps.socketPath ?? defaultLocalSocket();
    this.localPending = (async () => {
      const sock = net.connect(socketPath);
      await new Promise<void>((resolve, reject) => {
        sock.once('connect', () => resolve());
        sock.once('error', reject);
      });
      const client = new NodeAgentdClient(sock);
      if (this.deps.onStatus) client.onStatus(this.deps.onStatus);
      try {
        const identity = await this.deps.identityFor(nodeId, 'local');
        await client.hello(identity);
      } catch (err) {
        // T23: a failed handshake otherwise leaks the socket + frame decoder.
        client.dispose();
        sock.destroy();
        this.recordFailure(nodeId, err);
        throw err;
      }
      sock.on('close', () => {
        if (this.local === client) {
          this.local = null;
          this.recordFailure(nodeId, new Error('agentd connection closed'));
        }
      });
      this.local = client;
      this.connected(nodeId);
      return client;
    })();
    try {
      return await this.localPending;
    } catch (error) {
      this.recordFailure(nodeId, error);
      throw error;
    } finally {
      this.localPending = null;
    }
  }

  /**
   * Connect (once per node) to a REMOTE node's daemon: bootstrap it over SSH
   * (ship/launch/upgrade the binary), open a direct-tcpip channel to its loopback
   * addr, and complete the handshake. `host` is the live SSH-backed
   * {@link AgentdHost} (cheap to build fresh per call); only used on a cache miss.
   * The cached client is evicted when its channel closes (SSH drop/reconnect), so
   * the next call re-bootstraps + re-forwards over the fresh connection.
   */
  async clientForRemote(
    nodeId: string,
    host: AgentdHost,
    bootstrap: AgentdBootstrap,
    options: { forceUpgrade?: boolean } = {},
  ): Promise<NodeAgentdClient> {
    const existing = this.remotes.get(nodeId);
    if (existing) {
      if (options.forceUpgrade) {
        const active = await existing.list();
        if (active.length > 0) throw new AgentdActiveSessionsError(active.length);
        existing.dispose();
        this.remotes.delete(nodeId);
        this.upgrades.delete(nodeId);
        this.compatibilities.delete(nodeId);
      } else {
        const pending = this.upgrades.get(nodeId);
        if (pending?.status !== 'deferred') return existing;
        const active = await existing.list().catch(() => null);
        if (active === null || active.length > 0) {
          if (active) pending.activeSessions = active.length;
          return existing;
        }
        // The final session drained. Drop the old connection so this call performs
        // the deferred rollout before another session can be launched.
        existing.dispose();
        this.remotes.delete(nodeId);
        this.compatibilities.delete(nodeId);
      }
    }
    const pending = this.remotePending.get(nodeId);
    if (pending) return pending;
    const p = (async () => {
      try {
        const identity = await this.deps.identityFor(nodeId, 'ssh');
        const before = await bootstrap.inspect(host, identity.nodeId);
        const policy = bootstrap.policy();
        const protocols = [
          policy.preferredProtocolVersion,
          ...policy.supportedProtocolVersions.filter(
            (version) => version !== policy.preferredProtocolVersion,
          ),
        ];
        const connect = async (): Promise<{
          client: NodeAgentdClient;
          identity: AuthenticatedAgentdIdentity;
        }> => {
          let lastProtocolError: unknown;
          for (const protocolVersion of protocols) {
            const endpoint = bootstrap.endpoint();
            const channel = await host.forwardOut(endpoint.host, endpoint.port);
            const client = new NodeAgentdClient(channel);
            if (this.deps.onStatus) client.onStatus(this.deps.onStatus);
            try {
              const authenticated = await client.hello(identity, protocolVersion);
              return { client, identity: authenticated };
            } catch (error) {
              client.dispose();
              channel.destroy();
              if (!/unsupported agentd protocol version/i.test(String(error))) throw error;
              lastProtocolError = error;
            }
          }
          throw lastProtocolError ?? new Error('no supported agentd protocol is available');
        };

        let forceCandidateReplacement = false;
        if (before.running) {
          // Authenticate and evaluate the running daemon before any mutation.
          // A protocol mismatch fails closed: Flock will not kill sessions it
          // cannot count. A newer compatible binary is never downgraded.
          const current = await connect();
          const compatibility = evaluateAgentdCompatibility(policy, {
            installedVersion: current.identity.daemonVersion,
            protocolVersion: current.identity.protocolVersion,
            capabilities: current.identity.capabilities,
            runtimeVerified: true,
            servicePrepared: before.servicePrepared,
          });
          this.compatibilities.set(nodeId, compatibility);
          const rolloutNeeded =
            before.upgradeRequired ||
            compatibility.binaryReplacement ||
            compatibility.state === 'required';
          if (!rolloutNeeded) {
            this.upgrades.delete(nodeId);
            this.cacheRemote(nodeId, current.client);
            this.connected(nodeId);
            return current.client;
          }
          const active = await current.client.list();
          if (active.length > 0) {
            if (options.forceUpgrade) throw new AgentdActiveSessionsError(active.length);
            if (compatibility.state === 'required') {
              current.client.blockNewSessions(
                'This node daemon must be upgraded before starting new sessions.',
              );
            }
            this.upgrades.set(nodeId, {
              status: 'deferred',
              installedVersion: current.identity.daemonVersion,
              expectedVersion: before.expectedVersion,
              activeSessions: active.length,
              requirement: compatibility.state === 'required' ? 'required' : 'recommended',
              message: 'Node daemon rollout deferred until active sessions finish.',
            });
            this.cacheRemote(nodeId, current.client);
            this.connected(nodeId);
            return current.client;
          }
          current.client.dispose();
          if (compatibility.state === 'required' && !compatibility.binaryReplacement) {
            throw new Error(
              `${compatibility.detail} Automatic downgrade of a newer daemon is blocked.`,
            );
          }
          forceCandidateReplacement =
            compatibility.state === 'required' && compatibility.binaryReplacement;
        }

        let client: NodeAgentdClient;
        try {
          const endpoint = await bootstrap.ensureRunning(host, identity, {
            forceBinaryReplacement: forceCandidateReplacement,
          });
          const channel = await host.forwardOut(endpoint.host, endpoint.port);
          const candidate = new NodeAgentdClient(channel);
          if (this.deps.onStatus) candidate.onStatus(this.deps.onStatus);
          try {
            const hello = await candidate.hello(identity, policy.preferredProtocolVersion);
            if (
              (before.binaryUpgradeRequired || forceCandidateReplacement) &&
              hello.daemonVersion !== before.expectedVersion
            ) {
              throw new Error(
                `agentd candidate reported version ${hello.daemonVersion ?? 'unknown'}; expected ${before.expectedVersion}`,
              );
            }
            const compatibility = evaluateAgentdCompatibility(policy, {
              installedVersion: hello.daemonVersion,
              protocolVersion: hello.protocolVersion,
              capabilities: hello.capabilities,
              runtimeVerified: true,
              servicePrepared: true,
            });
            if (compatibility.state === 'required') throw new Error(compatibility.detail);
            client = candidate;
            this.compatibilities.set(nodeId, compatibility);
            this.upgrades.delete(nodeId);
          } catch (error) {
            candidate.dispose();
            channel.destroy();
            throw error;
          }
        } catch (error) {
          if (
            (!before.binaryUpgradeRequired && !forceCandidateReplacement) ||
            !before.installedVersion
          ) {
            throw error;
          }
          // systemd-active is not enough: a candidate must complete the real
          // authenticated protocol handshake. Restore the known previous binary
          // and return its healthy client when that validation fails.
          await bootstrap.rollback(host, nodeId);
          const restored = await connect();
          client = restored.client;
          const restoredCompatibility = evaluateAgentdCompatibility(policy, {
            installedVersion: restored.identity.daemonVersion,
            protocolVersion: restored.identity.protocolVersion,
            capabilities: restored.identity.capabilities,
            runtimeVerified: true,
            servicePrepared: before.servicePrepared,
          });
          if (restoredCompatibility.state === 'required') {
            client.blockNewSessions(
              'This node daemon must be upgraded before starting new sessions.',
            );
          }
          this.compatibilities.set(nodeId, restoredCompatibility);
          this.upgrades.set(nodeId, {
            status: 'rolled_back',
            installedVersion: before.installedVersion,
            expectedVersion: before.expectedVersion,
            activeSessions: 0,
            requirement: before.compatibility.state === 'required' ? 'required' : 'recommended',
            message: 'Daemon candidate failed authenticated health validation and was rolled back.',
          });
        }
        this.cacheRemote(nodeId, client);
        this.connected(nodeId);
        return client;
      } catch (error) {
        this.recordFailure(nodeId, error);
        throw error;
      }
    })();
    this.remotePending.set(nodeId, p);
    try {
      return await p;
    } finally {
      this.remotePending.delete(nodeId);
    }
  }

  private cacheRemote(nodeId: string, client: NodeAgentdClient): void {
    client.onLinkClose(() => {
      if (this.remotes.get(nodeId) === client) {
        this.remotes.delete(nodeId);
        this.compatibilities.delete(nodeId);
        this.recordFailure(nodeId, new Error('agentd connection closed'));
      }
    });
    this.remotes.set(nodeId, client);
  }
}
