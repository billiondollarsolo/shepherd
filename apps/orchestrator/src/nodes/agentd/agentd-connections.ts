/**
 * AgentdConnections — owns one {@link NodeAgentdClient} per node (the multiplexed
 * link to that node's flock-agentd), reused across all of the node's sessions.
 * LOCAL nodes connect over a unix socket; REMOTE nodes are bootstrapped over SSH
 * and reached via a direct-tcpip channel to the daemon's loopback addr.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { NodeAgentdClient } from './agentd-client.js';
import type { AgentdBootstrap } from './agentd-bootstrap.js';
import type { AgentdHost } from './ssh-agentd-host.js';

export interface AgentdConnectionsDeps {
  /** Local daemon unix socket; defaults to the daemon's own default path. */
  socketPath?: string;
  /** Optional shared secret (matches the daemon's --secret). */
  secret?: string;
  /**
   * Derived agent-status push from any node's daemon (it tails the agent's
   * transcript). Wired into every client before the handshake so the daemon's
   * snapshot replay is captured. The caller feeds this into the live status map.
   */
  onStatus?: (
    sessionId: string,
    state: string,
    meta: { tokens?: number; tool?: string },
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

  constructor(private readonly deps: AgentdConnectionsDeps = {}) {}

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
    try {
      const channel = await host.forwardOut('127.0.0.1', port);
      const client = new NodeAgentdClient(channel);
      try {
        await client.hello(this.deps.secret);
        return true;
      } finally {
        client.dispose();
      }
    } catch {
      return false;
    }
  }

  /** Connect (once) to the local node's daemon and complete the handshake. */
  async clientForLocal(): Promise<NodeAgentdClient> {
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
        await client.hello(this.deps.secret);
      } catch (err) {
        // T23: a failed handshake otherwise leaks the socket + frame decoder.
        client.dispose();
        sock.destroy();
        throw err;
      }
      sock.on('close', () => {
        if (this.local === client) this.local = null;
      });
      this.local = client;
      return client;
    })();
    try {
      return await this.localPending;
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
  ): Promise<NodeAgentdClient> {
    const existing = this.remotes.get(nodeId);
    if (existing) return existing;
    const pending = this.remotePending.get(nodeId);
    if (pending) return pending;
    const p = (async () => {
      const endpoint = await bootstrap.ensureRunning(host);
      const channel = await host.forwardOut(endpoint.host, endpoint.port);
      const client = new NodeAgentdClient(channel);
      if (this.deps.onStatus) client.onStatus(this.deps.onStatus);
      try {
        await client.hello(this.deps.secret);
      } catch (err) {
        // T23: a failed handshake otherwise leaks the channel + frame decoder.
        client.dispose();
        channel.destroy();
        throw err;
      }
      channel.on('close', () => {
        if (this.remotes.get(nodeId) === client) this.remotes.delete(nodeId);
      });
      this.remotes.set(nodeId, client);
      return client;
    })();
    this.remotePending.set(nodeId, p);
    try {
      return await p;
    } finally {
      this.remotePending.delete(nodeId);
    }
  }
}
