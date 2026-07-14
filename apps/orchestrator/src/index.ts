import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  AuthService,
  describeOriginPolicy,
  makeDbAuthAuditRecorder,
  makeDbAuditSink,
  readOriginPolicy,
  readSetupToken,
  PersistentLoginThrottle,
} from './auth/index.js';
import { AuditQueryService, DrizzleAuditReadStore } from './audit/index.js';
import { AuditLogger } from './audit/index.js';
import { getDb, closeDb } from './db/index.js';
import { SecretStore } from './secrets/index.js';
import { NodeService, NodeFsService, preflightRemoteNode } from './nodes/index.js';
import { NodeWorkspaceService } from './nodes/node-workspace-service.js';
import { AgentdActiveSessionsError, AgentdConnections } from './nodes/agentd/agentd-connections.js';
import { AgentdPtyTransport } from './nodes/agentd/agentd-pty-transport.js';
import { AgentdBootstrap } from './nodes/agentd/agentd-bootstrap.js';
import { FsAgentdBinaryProvider } from './nodes/agentd/agentd-binary-provider.js';
import type { NodeAgentdClient } from './nodes/agentd/agentd-client.js';
import type { AgentdStatusMeta } from './nodes/agentd/protocol.js';
import { NodeControlCredentials } from './nodes/agentd/node-control-credentials.js';
import { registerNodeCredentialRotationRoute } from './nodes/agentd/credential-rotation-route.js';
import { registerNodeAgentdUpgradeRoute } from './nodes/agentd/agentd-upgrade-route.js';
import {
  evaluateAgentdCompatibility,
  loadAgentdCompatibilityPolicy,
} from './nodes/agentd/agentd-compatibility.js';
import type { ConnectionStatus, PlanItem, Status } from '@flock/shared';
import { CreateSessionRequest } from '@flock/shared';
import { forgetPlan, planEventFields } from './hooks/plan.js';
import {
  NodeConnectionManager,
  type NodeConnectionManagerDeps,
} from './nodes/node-connection-manager.js';
import {
  planSessionTruth,
  type NodeTruth,
  type SessionTruthCorrection,
} from './status/session-truth.js';
import { ProjectService } from './projects/index.js';
import {
  SessionRestService,
  TerminateSessionService,
  DrizzleSessionRegistry,
  DiffService,
  GitService,
} from './sessions/index.js';
import { renderHookConfig } from './sessions/config-injection/index.js';
import {
  agentSessionKind,
  agentUsesActivityStatus,
  isBareAgentProcessName,
} from './sessions/agent-launch.js';
import { lookupModel } from './sessions/model-info.js';
import { hashHookToken } from './hooks/hook-token.js';
import { OrchestrationService } from './orchestrate/orchestrate-service.js';
import { registerOrchestrateRoute } from './orchestrate/orchestrate-route.js';
import { AgentCapabilityService } from './orchestrate/capability-service.js';
import { buildAgentEnvironment } from './sessions/agent-environment-policy.js';
import { ConfigService } from './config/config-service.js';
import { registerConfigRoutes } from './config/config-routes.js';
import { readSessionCookie } from './auth/cookie.js';
import { makeWsAuthorizer } from './auth/ws-auth.js';
import { UserPreferencesService } from './me/user-preferences-service.js';
import { ProjectPensService } from './me/project-pens-service.js';
import { agentSessions } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { createLiveChannels } from './live-channels.js';
import { EventReadService } from './events/index.js';
import {
  PushService,
  DrizzlePushSubscriptionStore,
  createWebPushSender,
  readVapidConfig,
  type PushRouteDeps,
} from './push/index.js';
import { buildServer } from './server.js';
import { registerCollaborationRoutes } from './sessions/collaboration-routes.js';
import { resolveAgentdVersion } from './runtime/agentd-version.js';
import { mergeAgentMeta, type CachedAgentMeta } from './runtime/telemetry-cache.js';
import { createGracefulShutdown, installShutdownSignals } from './runtime/graceful-shutdown.js';
import { DiagnosticSink } from './runtime/diagnostics.js';
import { collectDiagnostics } from './operations/diagnostics.js';
import { BoundedTtlMap } from './runtime/bounded-ttl-map.js';
import {
  createPreviewGateway,
  PreviewService,
  ProjectPortsService,
  readPreviewConfig,
} from './preview/index.js';

/**
 * Entry point. Starts the HTTP server ONLY when this module is run directly
 * (e.g. `tsx src/index.ts` / `node dist/index.js`), never on import — so tests
 * can import `buildServer` without binding a port.
 *
 * Wires the durable system-of-record (Postgres) into the auth service so the
 * `/api/auth/*` routes (US-4/US-5) are live. Postgres is
 * the system of record only — never the live status path (spec §6.6).
 */
export async function main(): Promise<void> {
  const diagnosticSecrets = [
    process.env.FLOCK_MASTER_KEY,
    process.env.FLOCK_AGENTD_SECRET,
    process.env.VAPID_PRIVATE_KEY,
    process.env.DATABASE_URL,
  ].filter((value): value is string => Boolean(value));
  for (const file of [
    process.env.FLOCK_MASTER_KEY_FILE,
    process.env.POSTGRES_PASSWORD_FILE,
    process.env.FLOCK_SETUP_TOKEN_FILE,
  ]) {
    if (!file) continue;
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) diagnosticSecrets.push(value);
    } catch {
      // Startup validation reports required missing files through their owner.
    }
  }
  const diagnostics = new DiagnosticSink(200, undefined, () => diagnosticSecrets);
  const recordFailure = (
    category: string,
    operation: string,
    error: unknown,
    context?: Record<string, unknown>,
  ): void => {
    diagnostics.record({ category, operation, message: error, context });
  };
  const originPolicy = readOriginPolicy(process.env);
  const setupToken = readSetupToken(process.env);
  const previewConfig = readPreviewConfig(process.env, originPolicy.publicBaseUrl);
  // eslint-disable-next-line no-console
  console.log(describeOriginPolicy(originPolicy));
  const { db, pool } = getDb();
  const auth = new AuthService({ db, audit: makeDbAuthAuditRecorder(db), setupToken });
  const loginThrottle = new PersistentLoginThrottle(db);

  // US-40: owner audit read surface (GET /api/audit). Reads the append-only
  // audit_log off the live status path; guarded by authentication.
  const audit = new AuditQueryService(new DrizzleAuditReadStore(db));

  // Shared audit logger + secret store for the CRUD surfaces (FR-A3/FR-A4).
  const auditLogger = new AuditLogger(makeDbAuditSink(db));
  const secrets = new SecretStore({ audit: auditLogger });
  secrets.assertReady(); // fail loud at boot on a missing/malformed master key

  // Node connection manager: owns live transports — a shared LocalTransport for
  // the local node and a supervised ssh2 connection per SSH node (US-8). Adding
  // an SSH node triggers a real connect; status is mirrored to the node row.
  // US-9: each SSH node gets a loopback reverse tunnel so agents can POST hook
  // callbacks to `127.0.0.1:<remotePort>` (forwarded over the managed connection
  // to the orchestrator's own loopback hook endpoint). Bound to loopback only
  // (NFR-SEC4). The remote port is fixed so an autossh reconnect re-exposes the
  // SAME port already baked into a running agent's FLOCK_HOOK_URL.
  //
  // Connectivity changes drive session ground-truth reconcile (stale "running"
  // after a VM power-off / SSH drop). The handler is installed after live
  // channels exist; until then this is a no-op.
  const orchestratorPort = Number(process.env.PORT ?? 8080);
  const hookTunnelRemotePort = Number(process.env.FLOCK_TUNNEL_REMOTE_PORT ?? 8765);
  let onConnectivityChange: NonNullable<NodeConnectionManagerDeps['onConnectivityChange']> = () => {
    /* installed after liveChannels */
  };
  const connections = new NodeConnectionManager({
    db,
    secrets,
    logger: {
      warn: (message, error) => recordFailure('ssh', message, error ?? message),
      info: (message) =>
        diagnostics.record({
          category: 'ssh',
          operation: 'lifecycle',
          severity: 'info',
          message,
        }),
    },
    hookTunnel: {
      target: { host: '127.0.0.1', port: orchestratorPort },
      remotePort: hookTunnelRemotePort,
    },
    onConnectivityChange: (nodeId, status, prev) => {
      onConnectivityChange(nodeId, status, prev);
    },
  });

  // Node / project / session CRUD (FR-N1/N2/N3, FR-S2/S3). Creating an SSH node
  // fires a managed connect; removing one tears it down.
  let revokeNodePreviews = (_nodeId: string): void => {};
  const nodes = new NodeService({
    db,
    secrets,
    audit: auditLogger,
    onSshNodeCreated: (id) => {
      void connections
        .connectNode(id)
        .catch((error) => recordFailure('ssh', 'connect-created-node', error, { nodeId: id }));
    },
    onNodeRemoved: (id) => {
      revokeNodePreviews(id);
      void connections
        .disconnectNode(id)
        .catch((error) => recordFailure('ssh', 'disconnect-removed-node', error, { nodeId: id }));
    },
    onSshNodeUpdated: (id) => {
      // Edited connection params → drop the stale link and reconnect with the new
      // host/user/credential. Fire-and-forget; a failure leaves it error/retry.
      void connections
        .disconnectNode(id)
        .catch((error) => recordFailure('ssh', 'disconnect-updated-node', error, { nodeId: id }))
        .then(() => connections.connectNode(id))
        .catch((error) => recordFailure('ssh', 'reconnect-updated-node', error, { nodeId: id }));
    },
  });
  const projects = new ProjectService({ db, audit: auditLogger });

  // One node-transport resolver, shared by fs-browse, workspace intel, and git:
  // resolve the node's transport, or null when unreachable (routes map null → 422).
  const transportForNode = async (nodeId: string) =>
    connections.transportFor(nodeId).catch(() => null);
  const previews = new PreviewService({
    db,
    audit: auditLogger,
    config: previewConfig,
    transportForNode,
  });
  const previewGateway = createPreviewGateway(previews, {
    host: previewConfig.listenHost,
    port: previewConfig.listenPort,
    pool:
      previewConfig.backend === 'port_pool' && previewConfig.portRange
        ? {
            host: previewConfig.poolListenHost,
            ports: Array.from(
              { length: previewConfig.portRange.capacity },
              (_, index) => previewConfig.portRange!.start + index,
            ),
          }
        : null,
  });
  revokeNodePreviews = (nodeId) => previews.revokeForNode(nodeId);

  // Node filesystem browse (path picker): lists directories on any node.
  const nodeFs = new NodeFsService({ transports: { transportForNode } });

  // Workspace intelligence (stack detection, fuzzy file list, Find-in-Files).
  const nodeWorkspace = new NodeWorkspaceService({ transports: { transportForNode } });

  // flock-agentd is the ONLY PTY transport. It routes a node's PTYs through the
  // node daemon (raw PTY). LOCAL nodes connect over a unix socket; REMOTE (ssh)
  // nodes are bootstrapped over SSH (binary shipped + launched) and reached via a
  // direct-tcpip channel. `localNodeId` is filled at boot (ensureLocalNode).
  // Pinned on; the `useAgentd` branches below are always taken.
  const useAgentd = true;
  const developmentAgentdSecret = process.env.FLOCK_AGENTD_SECRET;
  const nodeControlCredentials = new NodeControlCredentials({
    db,
    secrets,
    localCredentialFile: process.env.FLOCK_AGENTD_SECRET_FILE,
    localIdentityFile: process.env.FLOCK_AGENTD_NODE_ID_FILE,
    developmentLocal:
      process.env.NODE_ENV !== 'production' &&
      developmentAgentdSecret &&
      developmentAgentdSecret.length >= 32
        ? {
            nodeId: process.env.FLOCK_AGENTD_NODE_ID || 'development-local',
            credential: developmentAgentdSecret,
          }
        : undefined,
  });
  const installationId = (() => {
    const explicit = process.env.FLOCK_INSTALLATION_ID?.trim();
    if (explicit) return explicit;
    const identityFile = process.env.FLOCK_AGENTD_NODE_ID_FILE;
    if (identityFile) {
      const value = readFileSync(identityFile, 'utf8').trim();
      if (value) return value;
    }
    if (process.env.NODE_ENV !== 'production') return 'development-local';
    throw new Error('FLOCK_INSTALLATION_ID or the protected local node identity is required');
  })();
  const agentCapabilities = new AgentCapabilityService({ db, installationId });
  // Derived agent status (daemon tails the agent transcript) → live status map +
  // per-session meta (token usage + current tool) shown in the paddock sidebar.
  // Per-session telemetry cache (everything except `plan`, which is routed to the
  // plan-event artifact rather than cached here).
  const agentdSessionMeta = new BoundedTtlMap<string, CachedAgentMeta>(
    10_000,
    24 * 60 * 60 * 1_000,
  );
  // Cache the connect-only daemon probe per ssh node so a down/zero-session node
  // isn't re-probed (connect + handshake + teardown) on every 4s health poll.
  const probeCache = new BoundedTtlMap<string, { up: boolean; at: number }>(5_000, 15_000);
  const PROBE_TTL_MS = 15_000;
  // sandboxAvailable is a STATIC node property (Landlock support); cache it so an
  // autonomous launch doesn't fetch full host metrics every time.
  const sandboxAvailableByNode = new BoundedTtlMap<string, boolean>(5_000, 24 * 60 * 60 * 1_000);
  let forwardAgentdStatus: (id: string, state: string, meta: AgentdStatusMeta) => void = () => {};
  const recordNodeControlEvent = (nodeId: string, event: string): void => {
    void auditLogger
      .record({
        action: 'node_control_event',
        targetType: 'node',
        targetId: nodeId,
        detail: { event },
      })
      .catch((error) => recordFailure('audit', 'node-control-event', error, { nodeId }));
  };
  const expectedAgentdVersion = resolveAgentdVersion();
  const agentdCompatibilityPolicy = loadAgentdCompatibilityPolicy(expectedAgentdVersion);
  const agentdConns = new AgentdConnections({
    socketPath: process.env.FLOCK_AGENTD_SOCKET || undefined,
    supportedProtocolVersions: [
      agentdCompatibilityPolicy.preferredProtocolVersion,
      ...agentdCompatibilityPolicy.supportedProtocolVersions.filter(
        (version) => version !== agentdCompatibilityPolicy.preferredProtocolVersion,
      ),
    ],
    identityFor: (nodeId, kind) => nodeControlCredentials.forNode(nodeId, kind),
    onStatus: (id, state, meta) => forwardAgentdStatus(id, state, meta),
    onAudit: recordNodeControlEvent,
  });
  // Enrollment for REMOTE nodes: verifies and installs the arch-matched binary
  // as a root-owned system service, then drops sessions to flock-agent.
  const agentdPort = Number(process.env.FLOCK_AGENTD_PORT || 48222);
  const agentdBootstrap = new AgentdBootstrap({
    version: expectedAgentdVersion,
    compatibilityPolicy: agentdCompatibilityPolicy,
    port: agentdPort,
    binaries: new FsAgentdBinaryProvider(
      process.env.FLOCK_AGENTD_DIST_DIR || path.resolve(process.cwd(), '../../agentd/dist'),
    ),
    onEvent: recordNodeControlEvent,
  });
  let localNodeId = '';

  // Resolve the daemon client for a node: local → unix socket; remote → SSH
  // bootstrap + direct-tcpip. Returns null if the daemon link can't be
  // established, which the callers surface as a disconnected dot / terminal error.
  const agentdClientForNode = async (
    nodeId: string,
    nodeKind: string,
  ): Promise<NodeAgentdClient | null> => {
    if (nodeKind === 'local' || nodeId === localNodeId) {
      try {
        return await agentdConns.clientForLocal(nodeId);
      } catch {
        diagnostics.increment('agentd.local_connect_failures');
        return null;
      }
    }
    // SSH node: ride out a (re)connecting link and retry the bootstrap/connect a
    // few times so a session created right after a restart doesn't strand blank.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const connected = await connections.waitForConnected(nodeId, 8000);
        if (!connected) {
          lastErr = new Error('ssh link not connected');
        } else {
          const host = await connections.agentdHostFor(nodeId);
          return await agentdConns.clientForRemote(nodeId, host, agentdBootstrap);
        }
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // eslint-disable-next-line no-console
    console.warn(`[agentd] no daemon link for node ${nodeId} after retries:`, lastErr);
    return null;
  };

  // The CACHED daemon client for a node (no connect), local-vs-remote dispatch —
  // used by the teardown paths to close PTYs without forcing a reconnect.
  const peekClientForNode = (nodeId: string): NodeAgentdClient | null =>
    nodeId === localNodeId ? agentdConns.peekLocal() : agentdConns.peekRemote(nodeId);

  const projectPorts = new ProjectPortsService({
    db,
    audit: auditLogger,
    previews,
    discover: async (nodeId) => {
      const node = await nodes.getNode(nodeId);
      if (!node) {
        return {
          supported: false,
          healthy: false,
          reason: 'Project node no longer exists.',
          observedAt: null,
          ports: [],
        };
      }
      const client = await agentdClientForNode(node.id, node.kind);
      if (!client) {
        return {
          supported: false,
          healthy: false,
          reason: 'Node daemon is unreachable; enter a port manually or reconnect the node.',
          observedAt: null,
          ports: [],
        };
      }
      if (!client.supports('listening_ports_v1')) {
        return {
          supported: false,
          healthy: false,
          reason:
            'Upgrade this node daemon for automatic port discovery; manual forwarding remains available.',
          observedAt: null,
          ports: [],
        };
      }
      try {
        const snapshot = await client.listeningPorts();
        return {
          supported: true,
          healthy: snapshot.degradedReason === null,
          reason: snapshot.degradedReason,
          observedAt: snapshot.observedAt,
          ports: snapshot.ports,
        };
      } catch (error) {
        return {
          supported: true,
          healthy: false,
          reason: error instanceof Error ? error.message : 'Listener discovery failed.',
          observedAt: null,
          ports: [],
        };
      }
    },
  });

  // flock-agentd connection health (the paddock's green dot). Per ssh node: is the
  // multiplexed daemon link live (cached client). Per open session: is its PTY
  // actually running on that daemon (present in the daemon's session list). Lazy:
  // a node we have not talked to yet reports link 'down' (we never bootstrap from
  // the health path).
  const agentdHealthSnapshot = async () => {
    const [openSessions, allNodes] = await Promise.all([
      sessions.listSessions(),
      nodes.listNodes(),
    ]);
    const sshNodes = allNodes.filter((n) => n.kind === 'ssh');
    const nodeHealth: Record<
      string,
      {
        link: 'up' | 'down';
        failure?: {
          code: 'network' | 'authentication' | 'protocol' | 'enrollment';
          message: string;
          at: string;
        };
      }
    > = {};
    const sessionHealth: Record<
      string,
      {
        live: boolean;
        tokens?: number;
        tool?: string;
        // T19 — richer telemetry surfaced to the paddock.
        model?: string;
        contextPct?: number;
        contextTokens?: number;
        contextLimit?: number;
        costUsd?: number;
      }
    > = {};

    for (const node of allNodes) {
      const failure = agentdConns.failureFor(node.id) ?? undefined;
      nodeHealth[node.id] = {
        link: node.id === localNodeId && agentdConns.peekLocal() ? 'up' : 'down',
        failure,
      };
    }

    // Per-node link: PROACTIVELY probe each ssh node's daemon (connect-only, no
    // bootstrap) so the node dot reflects the persistent (systemd) daemon even
    // with zero sessions. Only probe nodes whose SSH link is up.
    await Promise.all(
      sshNodes.map(async (n) => {
        if (connections.statusOf(n.id) !== 'connected') {
          nodeHealth[n.id] = {
            link: 'down',
            failure: agentdConns.failureFor(n.id) ?? undefined,
          };
          return;
        }
        let up = agentdConns.peekRemote(n.id) !== null;
        if (!up) {
          const cached = probeCache.get(n.id);
          if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
            up = cached.up;
          } else {
            try {
              const host = await connections.agentdHostFor(n.id);
              up = await agentdConns.probeRemote(n.id, host, agentdPort);
            } catch {
              diagnostics.increment('agentd.remote_probe_failures');
              up = false;
            }
            probeCache.set(n.id, { up, at: Date.now() });
          }
        }
        nodeHealth[n.id] = {
          link: up ? 'up' : 'down',
          failure: agentdConns.failureFor(n.id) ?? undefined,
        };
      }),
    );

    // Per-session liveness: a session is live when its PTY is in its node
    // daemon's session list. Probes SSH nodes AND the local daemon so health
    // matches the paddock ground-truth reconcile.
    const idsByNode = new Map<string, string[]>();
    for (const s of openSessions) {
      const ids = idsByNode.get(s.nodeId) ?? [];
      ids.push(s.id);
      idsByNode.set(s.nodeId, ids);
    }
    await Promise.all(
      [...idsByNode].map(async ([nodeId, ids]) => {
        const isLocal = nodeId === localNodeId;
        let client = isLocal ? agentdConns.peekLocal() : agentdConns.peekRemote(nodeId);
        if (!client && isLocal) {
          try {
            client = await agentdConns.clientForLocal(localNodeId);
          } catch {
            diagnostics.increment('agentd.local_health_connect_failures');
            client = null;
          }
        }
        let liveSet = new Set<string>();
        let probed = false;
        if (client) {
          try {
            liveSet = new Set((await client.list()).map((x) => x.id));
            probed = true;
          } catch {
            diagnostics.increment('agentd.session_inventory_failures');
          }
        }
        for (const id of ids) {
          const meta = agentdSessionMeta.get(id) ?? {};
          // contextPct/costUsd are precomputed in mergeMeta (on status change),
          // so the 4s poll does no per-session math.
          sessionHealth[id] = {
            live: probed && liveSet.has(id),
            tokens: meta.tokens,
            tool: meta.tool,
            model: meta.model,
            contextPct: meta.contextPct,
            contextTokens: meta.contextTokens,
            contextLimit:
              meta.contextLimit ??
              (meta.contextTokens != null && meta.model
                ? lookupModel(meta.model).contextLimit
                : undefined),
            costUsd: meta.costUsd,
          };
        }
      }),
    );

    return { enabled: true, nodes: nodeHealth, sessions: sessionHealth };
  };

  // Per-node host metrics + detected agents for the node-info dialog / bottom bar.
  // Resolves the node's daemon client and asks it for a NodeInfo snapshot; null
  // when the node is unknown or its link is down (the route maps that to 503).
  const nodeInfo = async (nodeId: string): Promise<unknown | null> => {
    const node = (await nodes.listNodes()).find((n) => n.id === nodeId);
    if (!node) return null;
    const client = await agentdClientForNode(node.id, node.kind);
    if (!client) return null;
    try {
      const info = (await client.nodeInfo()) as Record<string, unknown>;
      const authenticated = client.identity();
      const daemonCompatibility =
        agentdConns.compatibilityFor(nodeId) ??
        evaluateAgentdCompatibility(agentdCompatibilityPolicy, {
          installedVersion: authenticated?.daemonVersion ?? '',
          protocolVersion: authenticated?.protocolVersion,
          capabilities: authenticated?.capabilities,
          runtimeVerified: authenticated !== null,
          servicePrepared: true,
        });
      return {
        ...info,
        lifecycle: {
          expectedDaemonVersion: expectedAgentdVersion,
          daemonCompatibility,
          upgrade: agentdConns.upgradeFor(nodeId),
        },
      };
    } catch {
      diagnostics.increment('agentd.node_info_failures');
      return null;
    }
  };

  const nodePreflight = async (nodeId: string): Promise<unknown | null> => {
    const node = await nodes.getNode(nodeId);
    if (!node) return null;
    if (node.kind === 'local') {
      const info = (await nodeInfo(nodeId)) as {
        agents?: Array<{ name: string }>;
        control?: { daemonVersion?: string };
        lifecycle?: { daemonCompatibility?: ReturnType<typeof evaluateAgentdCompatibility> };
      } | null;
      if (!info) return null;
      const agents = info.agents ?? [];
      const daemonCompatibility =
        info.lifecycle?.daemonCompatibility ??
        evaluateAgentdCompatibility(agentdCompatibilityPolicy, {
          installedVersion: info.control?.daemonVersion ?? '',
          servicePrepared: true,
        });
      const checks = [
        {
          id: 'preparation',
          label: 'Shepherd node preparation',
          status: 'pass',
          detail: 'Local identities and permissions are managed by the Shepherd image.',
        },
        {
          id: 'daemon-version',
          label: 'Node daemon',
          status:
            daemonCompatibility.state === 'compatible'
              ? 'pass'
              : daemonCompatibility.state === 'recommended'
                ? 'warning'
                : 'fail',
          detail: daemonCompatibility.detail,
        },
        {
          id: 'agent:any',
          label: 'Launchable coding agent',
          status: agents.length > 0 ? 'pass' : 'fail',
          detail:
            agents.length > 0
              ? `Detected ${agents.map((agent) => agent.name).join(', ')}.`
              : 'No supported coding-agent CLI was detected.',
        },
      ] as const;
      return {
        nodeId,
        generatedAt: new Date().toISOString(),
        ready: checks.every((item) => item.status !== 'fail'),
        daemonCompatibility,
        checks,
      };
    }
    const connected = await connections.waitForConnected(nodeId, 8_000);
    if (!connected) return null;
    await agentdClientForNode(nodeId, node.kind);
    const [host, nodeProjects] = await Promise.all([
      connections.agentdHostFor(nodeId),
      projects.listProjects(nodeId),
    ]);
    return preflightRemoteNode({
      nodeId,
      host,
      compatibilityPolicy: agentdCompatibilityPolicy,
      authenticatedCompatibility: agentdConns.compatibilityFor(nodeId),
      workspaces: nodeProjects.map((project) => project.workingDir),
    });
  };

  // Whether a node can enforce the Landlock sandbox (T17). Static per node, so the
  // first definitive answer is cached — autonomous launches then don't refetch the
  // full host-metrics snapshot just to read one bool. A node we couldn't reach is
  // NOT cached (so it's re-checked next launch).
  const nodeSandboxAvailable = async (nodeId: string): Promise<boolean> => {
    const cached = sandboxAvailableByNode.get(nodeId);
    if (cached !== undefined) return cached;
    const info = (await nodeInfo(nodeId).catch(() => null)) as {
      sandboxAvailable?: boolean;
    } | null;
    if (info === null) return false; // unreachable → don't pin; retry next time
    const ok = info.sandboxAvailable === true;
    sandboxAvailableByNode.set(nodeId, ok);
    return ok;
  };

  // Live channels: status map + /ws/status fan-out, the per-session-token hook
  // endpoint, and the /ws/pty/:id terminal bridge. These were built+tested but
  // never wired in before — without them a session sits at "starting" with no
  // events and the terminal shows "reconnecting".
  // T4/T5: WS upgrade authorizer — Origin check + cookie→user + per-session
  // ownership. Shared by the PTY and status sockets.
  const wsAuthorize = makeWsAuthorizer({
    allowedOrigins: originPolicy.allowedOrigins,
    resolveUser: async (cookieHeader) => {
      const sid = readSessionCookie(cookieHeader ?? undefined);
      return sid ? await auth.getUserBySession(sid) : null;
    },
    sessionOwner: async (sessionId) => {
      // `<id>:shell[-n]` split panes inherit the base session's owner.
      const baseId = sessionId.replace(/:shell(?:-\d+)?$/, '');
      const [row] = await db
        .select({ owner: agentSessions.createdBy })
        .from(agentSessions)
        .where(eq(agentSessions.id, baseId))
        .limit(1);
      return row?.owner ?? null;
    },
  });

  const liveChannels = createLiveChannels({
    db,
    connections,
    diagnostics,
    authorizeUpgrade: wsAuthorize,
    agentdResolve: useAgentd
      ? async (sessionId, base, isShell) => {
          // flock-agentd is the ONLY transport (local + ssh). Any failure THROWS so
          // it surfaces as a terminal error (+ red connection dot), never a silent shell.
          const nodeKind = base.nodeId === localNodeId ? 'local' : 'ssh';
          const client = await agentdClientForNode(base.nodeId, nodeKind);
          if (!client) throw new Error(`flock-agentd link down for node ${base.nodeId}`);
          const mkBinding = (attachOnly: boolean) => ({
            transport: new AgentdPtyTransport(
              client,
              { id: sessionId, kind: isShell ? 'shell' : 'agent', cwd: base.workingDir },
              { attachOnly },
            ),
            attachCommand: () => [],
            workingDir: base.workingDir,
          });
          // `:shell` split panes have no separate launch — the attach path creates
          // them on demand (a plain shell).
          if (isShell) return mkBinding(false);
          // Agent/terminal sessions are created by agentdLaunch (the SOLE creator,
          // carrying command + permission flags + hook env). Attach-only here after
          // waiting out the create/attach race; if it never appears the launch
          // failed — surface the error, don't spawn a shell.
          const exists = await client.waitForSession(sessionId, 4000);
          if (!exists)
            throw new Error(`flock-agentd session ${sessionId} not running on the daemon`);
          return mkBinding(true);
        }
      : undefined,
  });

  // Now that the live status map exists, route daemon-derived agent status into
  // it (→ /ws/status → paddock dots). Only forward the transcript-provable states.
  if (useAgentd) {
    const agentdStates = new Set(['running', 'awaiting_input', 'idle', 'error']);
    if (process.env.FLOCK_DEBUG_TELEMETRY) {
      // eslint-disable-next-line no-console
      console.log('[telemetry] debug telemetry logging ENABLED (FLOCK_DEBUG_TELEMETRY)');
    }
    forwardAgentdStatus = (id, state, meta) => {
      // Carry forward unchanged fields: the daemon emits a full snapshot but proto
      // omitempty drops zero/empty fields on the wire, so "non-zero/non-empty wins".
      let workState = state;
      let workMeta = meta;
      // Guard: watchForeground reports tool=<agent binary> + running whenever the
      // TUI process owns the PTY — even when idle at the prompt. That happens when
      // agentd misses hook-owned detection (e.g. grok launched via `sh -c … exec
      // grok`). Real tool use uses names like Bash/Edit, not the agent binary.
      if (workState === 'running' && workMeta.tool && isBareAgentProcessName(workMeta.tool)) {
        workState = 'idle';
        workMeta = { ...workMeta, tool: undefined };
      }
      const merged = mergeAgentMeta(agentdSessionMeta.get(id) ?? {}, workMeta);
      agentdSessionMeta.set(id, merged);
      // TEMP (agent-integration validation): when FLOCK_DEBUG_TELEMETRY is set, log
      // every per-session status frame + its derived telemetry so we can verify the
      // claude/codex/opencode/gemini pipelines end-to-end. Remove after validation.
      if (process.env.FLOCK_DEBUG_TELEMETRY) {
        // eslint-disable-next-line no-console
        console.log(
          `[telemetry] sid=${id.slice(0, 8)} state=${workState} model=${merged.model ?? '-'} ` +
            `tokens=${merged.tokens ?? 0} tool=${merged.tool ?? '-'} ctx%=${merged.contextPct ?? '-'} ` +
            `cost=${merged.costUsd ?? '-'} plan=${meta.plan ? 'yes' : '-'}`,
        );
      }
      // Drive the work-status dot (only the transcript-provable states) AND ride
      // the live telemetry out on the SAME fan-out, so the paddock's token/tool/
      // model/context%/cost gauges update over the WS — no 4s agentd-status poll.
      if (agentdStates.has(workState)) {
        liveChannels.statusMap.set(id, workState as Status, workMeta.tool ?? null, true, {
          tokens: merged.tokens,
          tool: merged.tool,
          model: merged.model,
          contextPct: merged.contextPct,
          contextTokens: merged.contextTokens,
          contextLimit:
            merged.contextLimit ??
            (merged.contextTokens != null && merged.model
              ? lookupModel(merged.model).contextLimit
              : undefined),
          costUsd: merged.costUsd,
        });
      }
      // T62: Codex reports its task list via update_plan on the status channel.
      // Route it through the SAME deduped plan-artifact builder Claude's TodoWrite
      // uses (planEventFields owns dedup + shape), then enqueue with our source.
      if (meta.plan) {
        try {
          const items = JSON.parse(meta.plan) as PlanItem[];
          const planFields = Array.isArray(items) ? planEventFields(id, items) : null;
          if (planFields) {
            liveChannels.enqueueEvent({ sessionId: id, source: 'orchestrator', ...planFields });
          }
        } catch {
          /* malformed plan JSON — ignore */
        }
      }
    };
  }

  const resolveUserId = async (cookieHeader: string | null | undefined): Promise<string | null> => {
    const sessionId = readSessionCookie(cookieHeader ?? undefined);
    if (!sessionId) return null;
    const user = await auth.getUserBySession(sessionId);
    return user?.id ?? null;
  };

  // US-22: Web Push — fan push-worthy status transitions (awaiting_input/done/
  // error) out to subscribed browsers, OFF the live path. Graceful: if no VAPID
  // keys are configured, push is simply disabled (the orchestrator still boots).
  const pushStore = new DrizzlePushSubscriptionStore(db);
  let pushRouteDeps: PushRouteDeps | undefined;
  try {
    const vapid = readVapidConfig();
    new PushService({ store: pushStore, sender: createWebPushSender(vapid) }).attach(
      liveChannels.statusMap,
    );
    pushRouteDeps = { store: pushStore, resolveUserId, vapidPublicKey: vapid.publicKey };
  } catch (err) {
    recordFailure('push', 'configure', err);
    // eslint-disable-next-line no-console
    console.warn(
      `[flock-orchestrator] Web Push disabled (set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Where agent hook callbacks POST. Over an SSH node the agent curls localhost
  // (the reverse tunnel forwards it back); locally it hits the orchestrator
  // directly. PUBLIC_BASE_URL is the orchestrator's own origin.
  const hookBaseUrl = originPolicy.publicBaseUrl ?? `http://localhost:${process.env.PORT ?? 8080}`;

  // Session create launches the agent on the target node's flock-agentd daemon
  // (local OR ssh), injecting the per-session Shepherd hook env (US-19) so the agent
  // emits lifecycle hooks, and tracking it in the live channels so the sidebar +
  // terminal light up immediately.
  const sessions = new SessionRestService({
    db,
    hashToken: (t) => Promise.resolve(hashHookToken(t)),
    audit: auditLogger,
    issueOrchestrationCapability: (session, scopes) =>
      agentCapabilities.issue(session.id, session.projectId, scopes),
    // flock-agentd is the transport for ALL nodes (local + ssh). It is MANDATORY:
    // 'launched' on success, 'failed' on any error (the session then shows a
    // disconnected dot instead of a silent shell).
    agentdLaunch: useAgentd
      ? async ({ session, nodeKind, command, env, mode }) => {
          // agentd is the ONLY transport (local + ssh). On a hard failure mark the
          // session 'error' (red dot + reason) rather than blank — never a silent shell.
          const fail = (reason: string) => {
            liveChannels.statusMap.set(session.id, 'error', reason);
            return 'failed' as const;
          };
          const client = await agentdClientForNode(session.nodeId, nodeKind);
          if (!client) return fail('flock-agentd unreachable on node');
          // Scoped hook-config (US-19, T1): agentd seeds it on the node so the agent
          // calls back into Shepherd's hook endpoint (→ awaiting_input, Plan, Web Push).
          // ACP sessions (Gemini) skip hook injection — status + chat come from the
          // ACP stream (`acp_bridge`), not hooks.
          const isAcp = mode === 'acp';
          const scoped = isAcp ? null : await renderHookConfig(session.agentType).catch(() => null);
          // T17: an `autonomous` agent (--dangerously-skip-permissions) must be
          // FS-confined. Enable the Landlock sandbox iff the node supports it;
          // otherwise warn loudly (the agent then runs with full write access).
          let sandbox = false;
          if (session.permissionMode === 'autonomous') {
            sandbox = await nodeSandboxAvailable(session.nodeId);
            if (!sandbox) {
              // eslint-disable-next-line no-console
              console.warn(
                `[flock-orchestrator] UNSANDBOXED autonomous session ${session.id} on node ` +
                  `${session.nodeId}: node lacks Landlock — the agent has full write access to the node.`,
              );
            }
          }
          // #3a per-node env: merge the node's env UNDER the per-session launch
          // env (session/hook vars win on a key clash). Best-effort — never fail a
          // launch because node env can't be read.
          const nodeEnv = await nodes.envForNode(session.nodeId).catch(() => ({}));
          const mergedEnv = buildAgentEnvironment(session.agentType, nodeEnv, env ?? {});
          try {
            await client.open({
              id: session.id,
              mode,
              sandbox,
              // Confine writes to the session's working dir (its worktree when set).
              sandboxAllow: sandbox ? [session.workingDir] : undefined,

              // Status source + daemon kind come from the agent capability table.
              // ACP sessions push their own status, so no PTY-activity heuristic.
              activityStatus: isAcp ? false : agentUsesActivityStatus(session.agentType),
              kind: agentSessionKind(session.agentType),
              cwd: session.workingDir,
              command,
              env:
                Object.keys(mergedEnv).length > 0
                  ? Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`)
                  : undefined,
              configFiles: scoped?.files,
              configBaseSubdir: scoped?.configBaseSubdir,
            });
          } catch (err) {
            return fail(`agent launch failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return 'launched';
        }
      : undefined,
    onSessionCreated: (session) => {
      liveChannels.trackSession({
        id: session.id,
        nodeId: session.nodeId,
        tmuxSessionName: session.tmuxSessionName,
        workingDir: session.workingDir,
        hookTokenHash: session.hookTokenHash,
        agentType: session.agentType,
        status: session.status,
        statusDetail: session.statusDetail,
      });
    },
    sessionEnv: async (session, hookToken, orchestrationToken) => {
      // Over an SSH node the agent must curl the node-local reverse-tunnel port
      // (US-9); the tunnel forwards it back to the orchestrator. Locally it hits
      // the orchestrator origin directly. A null tunnel port (local node, or the
      // tunnel not up) falls back to the orchestrator's own base URL.
      const tunnelPort = connections.hookTunnelPort(session.nodeId);
      const hookBase =
        tunnelPort != null ? `http://127.0.0.1:${tunnelPort}` : hookBaseUrl.replace(/\/$/, '');
      const hookUrl = `${hookBase}/api/hooks/${session.id}`;
      return {
        FLOCK_SESSION_ID: session.id,
        FLOCK_HOOK_URL: hookUrl,
        FLOCK_HOOK_TOKEN: hookToken,
        ...(orchestrationToken ? { FLOCK_ORCHESTRATE_TOKEN: orchestrationToken } : {}),
      };
    },
  });

  // Terminate (US-13, FR-S5): close the agent's flock-agentd session on its node
  // (kill the agent), mark the record closed, drop it from live channels, audit.
  // Closing a browser tab does NOT terminate the daemon-backed agent. This is the
  // only place a session is killed. Best-effort via the cached node link.
  const sessionRegistry = new DrizzleSessionRegistry(db);
  const terminateSession = new TerminateSessionService({
    registry: sessionRegistry,
    audit: auditLogger,
    revokeCapabilities: (sessionId) => agentCapabilities.revokeSession(sessionId),
    terminator: {
      // `killSession` is the service's transport-agnostic seam; for agentd it
      // closes the daemon session (+ its `:shell` split, if any) by session id.
      killSession: async (sessionName: string) => {
        const open = await sessionRegistry.listOpenSessions();
        const owner = open.find((s) => s.tmuxSessionName === sessionName);
        if (!owner) return; // already gone
        const client = peekClientForNode(owner.nodeId);
        if (client) {
          client.close(owner.id);
          client.close(`${owner.id}:shell`); // shell drawer/split, if any
        }
      },
    },
  });

  // After a terminate, drop the session from the live channels (status map +
  // hook binding + PTY) so it leaves the sidebar and frees its attachment.
  const terminateAndCleanup = {
    async terminate(sessionId: string, ctx: { userId: string; ip?: string | null }) {
      const result = await terminateSession.terminate(sessionId, ctx);
      liveChannels.untrackSession(sessionId);
      agentdSessionMeta.delete(sessionId); // free the per-session telemetry cache (was never evicted)
      forgetPlan(sessionId);
      return result;
    },
  };

  // Ground-truth reconcile: after rehydrate the status map can still claim
  // `running` for sessions whose node/PTY is gone (powered-off VMs, restarted
  // agentd). Correct those to `disconnected` so the UI never shows a stale
  // work-status. Also re-runs on every SSH connectivity change + a slow poll.
  const applyTruthCorrections = (corrections: ReadonlyArray<SessionTruthCorrection>): number => {
    let n = 0;
    for (const c of corrections) {
      if (liveChannels.statusMap.set(c.id, c.status, c.detail, true)) n += 1;
    }
    return n;
  };

  const buildNodeTruthMap = async (
    allNodes: ReadonlyArray<{ id: string; kind: string; connectionStatus: ConnectionStatus }>,
  ): Promise<Map<string, NodeTruth>> => {
    const truth = new Map<string, NodeTruth>();

    await Promise.all(
      allNodes.map(async (n) => {
        if (n.kind === 'local' || n.id === localNodeId) {
          let liveSessionIds: Set<string> | null = null;
          try {
            const client =
              agentdConns.peekLocal() ??
              (await agentdConns.clientForLocal(localNodeId).catch(() => {
                diagnostics.increment('reconcile.local_connect_failures');
                return null;
              }));
            if (client) {
              liveSessionIds = new Set((await client.list()).map((x) => x.id));
            } else {
              // Local daemon down → positive empty inventory (nothing is live).
              liveSessionIds = new Set();
            }
          } catch {
            diagnostics.increment('reconcile.local_inventory_failures');
            liveSessionIds = new Set();
          }
          truth.set(n.id, {
            kind: 'local',
            connection: 'connected',
            liveSessionIds,
          });
          return;
        }

        // Prefer the live supervised status; fall back to the DB mirror when the
        // node is not yet managed (boot race before connectAll settles).
        const liveConn = connections.statusOf(n.id);
        const connection: ConnectionStatus = liveConn ?? n.connectionStatus;
        let liveSessionIds: ReadonlySet<string> | null = null;
        if (connection === 'connected') {
          const client = agentdConns.peekRemote(n.id);
          if (client) {
            try {
              liveSessionIds = new Set((await client.list()).map((x) => x.id));
            } catch {
              diagnostics.increment('reconcile.remote_inventory_failures');
              liveSessionIds = null; // transient — don't invent disconnects
            }
          } else {
            // SSH up but no multiplexed agentd client yet → cannot prove PTY
            // presence; leave null so we only disconnect on node-down.
            liveSessionIds = null;
          }
        }
        truth.set(n.id, { kind: 'ssh', connection, liveSessionIds });
      }),
    );
    return truth;
  };

  const reconcileSessionTruth = async (): Promise<number> => {
    try {
      const [openSessions, allNodes] = await Promise.all([
        sessions.listSessions(),
        nodes.listNodes(),
      ]);
      const nodeTruth = await buildNodeTruthMap(allNodes);
      const plan = planSessionTruth(
        openSessions.map((s) => ({
          id: s.id,
          nodeId: s.nodeId,
          status: (liveChannels.statusMap.get(s.id)?.status ?? s.status) as Status,
        })),
        nodeTruth,
      );
      const applied = applyTruthCorrections(plan);
      if (applied > 0) {
        const disc = plan.filter((c) => c.status === 'disconnected').length;
        const restored = plan.filter((c) => c.status === 'idle').length;
        // eslint-disable-next-line no-console
        console.log(
          `[reconcile] ground truth: ${applied} applied` +
            (disc ? ` (${disc} disconnected)` : '') +
            (restored ? ` (${restored} restored idle)` : ''),
        );
      }
      return applied;
    } catch (err) {
      recordFailure('reconcile', 'session-truth', err);
      // eslint-disable-next-line no-console
      console.warn(`[reconcile] session truth failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  };

  onConnectivityChange = (nodeId, status, prev) => {
    // Any non-connected link means open sessions on that node cannot be live.
    // Reconnect (`connected`) also re-runs so a recovered node re-probes agentd
    // and can clear ghosts; live agentd status frames restore work-status.
    if (status === prev) return;
    void reconcileSessionTruth();
    // Also immediately force sessions on this node when the link is clearly down
    // so the UI does not wait on the async inventory probe.
    if (status !== 'connected') {
      void sessions.listSessions().then((open) => {
        const detail =
          status === 'error'
            ? 'node unreachable'
            : status === 'connecting'
              ? 'node connecting'
              : 'node disconnected';
        for (const s of open) {
          if (s.nodeId !== nodeId) continue;
          const cur = liveChannels.statusMap.get(s.id)?.status ?? s.status;
          if (cur === 'done' || cur === 'error' || cur === 'disconnected') continue;
          liveChannels.statusMap.set(s.id, 'disconnected', detail, true);
        }
      });
    }
  };

  // Boot seeding: ensure a single `local` node exists so the paddock tree is
  // never empty. Idempotent — a restart never creates a duplicate.
  localNodeId = (await nodes.ensureLocalNode()).id;

  // Hydrate the live binding from surviving sessions so the terminal can attach
  // and status shows after an orchestrator restart (NFR-AV1). Rehydrate first,
  // then ground-truth reconcile so a powered-off VM never paints as "running".
  await liveChannels
    .hydrate()
    .catch((error) => recordFailure('status', 'hydrate-live-channels', error));

  // Reconnect to every known SSH node on boot (best-effort). Connectivity
  // transitions fire onConnectivityChange → session truth.
  void connections
    .connectAll()
    .catch((error) => recordFailure('ssh', 'connect-all', error))
    .finally(() => {
      void reconcileSessionTruth();
    });

  // Immediate reconcile against DB connection_status (before connectAll settles)
  // so the first WS snapshot is already truthful for long-dead nodes.
  void reconcileSessionTruth();

  // Slow poll: catches local agentd restarts and sessions that died without an
  // SSH status transition (PTY exit while node stayed up).
  const RECONCILE_INTERVAL_MS = 15_000;
  const reconcileTimer = setInterval(() => {
    void reconcileSessionTruth();
  }, RECONCILE_INTERVAL_MS);
  // Don't keep the process alive solely for the poller.
  reconcileTimer.unref?.();

  // Read-only `git diff` for the center pane's Diff tab (US-33). Runs `git diff`
  // on the session's node via its transport. Built+tested but never wired before
  // — without it `GET /api/sessions/:id/diff` 404s and the Diff tab shows the
  // "Diff request failed (404)" error.
  const gitSeams = {
    sessions: { getSession: (id: string) => sessionRegistry.getSession(id) },
    transports: { transportForNode },
  };
  const diff = new DiffService(gitSeams);
  // US-33.1: git source-control actions (stage/commit/push) share the diff seams
  // — same session registry + per-node transport. Writes git plumbing on the node.
  const git = new GitService(gitSeams);

  // US-39: install the global default-DENY surface guard so ALL UI/API/WS
  // require auth (NFR-SEC6); the hook endpoint stays the per-session-token
  // exception (spec §8.1). The AuthService satisfies the `getUserBySession`
  // seam directly. TLS is terminated by the upstream Caddy proxy (NFR-SEC1).
  const app = buildServer({
    auth,
    loginThrottle,
    authDeployment: originPolicy.deployment,
    browserOrigins: originPolicy.allowedOrigins,
    surfaceAuth: auth,
    audit,
    nodes,
    nodeFs,
    nodeWorkspace,
    projects,
    me: {
      auth,
      preferences: new UserPreferencesService(db),
      pens: new ProjectPensService(db),
    },
    sessions,
    previews,
    projectPorts,
    diff,
    git,
    diagnostics: () =>
      collectDiagnostics({
        pool,
        sink: diagnostics,
        agentdHealth: agentdHealthSnapshot,
        listNodes: () => nodes.listNodes(),
        previewHealth: () => ({
          enabled: previewConfig.enabled,
          active: previews.size(),
          reason: previewConfig.reason,
        }),
        collectionSizes: () => ({
          agentTelemetry: agentdSessionMeta.size,
          daemonProbes: probeCache.size,
          sandboxCapabilities: sandboxAvailableByNode.size,
          previews: previews.size(),
          ...liveChannels.diagnosticSizes(),
        }),
      }),
    events: new EventReadService(db),
    push: pushRouteDeps,
    terminateSession: terminateAndCleanup,
    hookEndpoint: liveChannels.hookService,
    agentdHealth: useAgentd ? agentdHealthSnapshot : undefined,
    // T15(a): readiness gate — a 1s-bounded `SELECT 1` proving Postgres answers.
    readiness: async () => {
      try {
        await pool.query({ text: 'select 1', query_timeout: 1000 } as never);
        return true;
      } catch {
        diagnostics.increment('readiness.failures');
        return false;
      }
    },
    nodeInfo: useAgentd ? nodeInfo : undefined,
    nodePreflight: useAgentd ? nodePreflight : undefined,
    // Kill a split-pane shell on the daemon when the user closes the pane, then
    // drop the orchestrator's PtySession so a re-split builds a FRESH shell
    // (otherwise the daemon shell lingers and re-attaches with stale scrollback).
    terminatePty: useAgentd
      ? async (ptyId: string) => {
          const m = ptyId.match(/^(.+):shell(?:-\d+)?$/);
          if (!m) return;
          const baseId = m[1]!;
          const owner = (await sessionRegistry.listOpenSessions()).find((s) => s.id === baseId);
          if (!owner) return;
          const client = peekClientForNode(owner.nodeId);
          client?.close(ptyId); // kill the daemon shell PTY
          liveChannels.untrackSession(ptyId); // drop the shared PtySession (fresh on re-split)
        }
      : undefined,
  });

  registerNodeCredentialRotationRoute(app, {
    auth,
    rotate: async (nodeId, context) => {
      const node = await nodes.getNode(nodeId);
      if (!node) return 'not_found';
      const client = await agentdClientForNode(node.id, node.kind);
      if (!client) return 'unavailable';
      await nodeControlCredentials.rotate(node.id, node.kind, (next) =>
        client.rotateCredential(next.credential),
      );
      await auditLogger.record({
        action: 'node_credential_rotate',
        userId: context.userId,
        targetType: 'node',
        targetId: node.id,
        ip: context.ip,
        detail: { mode: 'secure' },
      });
      return 'rotated';
    },
  });

  registerNodeAgentdUpgradeRoute(app, {
    auth,
    upgrade: async (nodeId, context) => {
      const node = await nodes.getNode(nodeId);
      if (!node) return { status: 'not_found' };
      if (node.kind !== 'ssh') return { status: 'not_remote' };
      if (!(await connections.waitForConnected(nodeId, 8_000))) {
        return { status: 'unavailable' };
      }
      try {
        const host = await connections.agentdHostFor(nodeId);
        await agentdConns.clientForRemote(nodeId, host, agentdBootstrap, {
          forceUpgrade: true,
        });
      } catch (error) {
        if (error instanceof AgentdActiveSessionsError) {
          return { status: 'active_sessions', count: error.count };
        }
        recordFailure('agentd', 'forced-upgrade', error, { nodeId });
        return { status: 'unavailable' };
      }
      await auditLogger.record({
        action: 'node_control_event',
        userId: context.userId,
        targetType: 'node',
        targetId: nodeId,
        ip: context.ip,
        detail: { event: 'upgrade_requested', expectedVersion: expectedAgentdVersion },
      });
      return { status: 'upgraded' };
    },
  });

  // Agent-facing orchestration API: separate durable capability, project policy,
  // and explicit per-verb grants. Callback-only agents cannot enter this surface.
  const orchestration = new OrchestrationService(
    db,
    liveChannels.statusMap,
    (callerId, token, required) => agentCapabilities.authorize(callerId, token, required),
    () => new EventReadService(db).latestChats(),
    // spawn: launch a sibling in the project (reuses the full create machinery).
    async (projectId, createdBy, agentType) => {
      const input = CreateSessionRequest.parse({ projectId, agentType });
      const r = await sessions.createSession(input, { userId: createdBy, ip: null });
      return r.session.id;
    },
    // send: deliver input to a sibling's live PTY (it must be running on a node).
    async (targetId, text) => {
      const s = await sessionRegistry.getSession(targetId);
      const client = s ? peekClientForNode(s.nodeId) : null;
      if (!client) return false;
      client.write(targetId, Buffer.from(text.endsWith('\r') ? text : `${text}\r`));
      return true;
    },
    // kill: terminate a sibling (full cleanup: worktree, preview, untrack).
    async (targetId) => {
      try {
        await terminateAndCleanup.terminate(targetId, { userId: '', ip: null });
        return true;
      } catch (error) {
        // terminate can throw on a racy / still-opening session even though it DID
        // close the record — report success if the session is actually gone.
        const s = await sessionRegistry.getSession(targetId).catch((lookupError) => {
          recordFailure('session', 'verify-termination', lookupError, { sessionId: targetId });
          return null;
        });
        const closed = !s || s.closedAt != null;
        if (!closed) recordFailure('session', 'terminate-agent', error, { sessionId: targetId });
        return closed;
      }
    },
    // read_output: a sibling's recent chat/assistant messages (oldest→newest).
    (targetId, limit) => new EventReadService(db).recentChats(targetId, limit),
    60_000,
    () => Date.now(),
    (callerId, required) => {
      void auditLogger
        .record({
          action: 'agent_policy_event',
          targetType: 'session',
          targetId: callerId,
          detail: { event: 'denied', required },
        })
        .catch((error) =>
          recordFailure('audit', 'agent-policy-denial', error, { sessionId: callerId }),
        );
    },
  );
  registerOrchestrateRoute(app, orchestration);

  registerCollaborationRoutes(app, {
    auth,
    sessions,
    registry: sessionRegistry,
    events: new EventReadService(db),
    clientForNode: peekClientForNode,
  });
  // Config-as-code (flock.yml): apply a reproducible workspace + export the fleet.
  registerConfigRoutes(
    app,
    new ConfigService({
      listNodes: () => nodes.listNodes(),
      listProjects: (nodeId) => projects.listProjects(nodeId),
      createProject: (input) => projects.createProject(input),
      listSessions: () => sessions.listSessions(),
      createSession: (input, ctx) => sessions.createSession(input, ctx),
    }),
    auth,
  );

  const port = Number(process.env.PORT ?? 8080);
  // Bind loopback by DEFAULT: the orchestrator's only callers are the web dev
  // proxy (same host) and the reverse tunnels (forwarded from this process), so it
  // never needs a public interface, and the token-only hook endpoint must not be
  // LAN-reachable. Multi-container deploys set HOST=0.0.0.0 explicitly (compose).
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  await previewGateway.listen();

  // Attach the live status and PTY WebSocket bridges to the HTTP server.
  liveChannels.attach(app.server);
  // eslint-disable-next-line no-console
  console.log(`[flock-orchestrator] listening on http://${host}:${port}`);
  console.log(
    previewConfig.enabled
      ? previewConfig.backend === 'port_pool' && previewConfig.portRange
        ? `[shepherd-preview] private pool listening on ${previewConfig.poolListenHost}:${previewConfig.portRange.start}-${previewConfig.portRange.end}`
        : `[shepherd-preview] hostname gateway listening on ${previewConfig.listenHost}:${previewConfig.listenPort} for *.${previewConfig.domain}`
      : `[shepherd-preview] disabled: ${previewConfig.reason}`,
  );

  installShutdownSignals(
    createGracefulShutdown({
      stopBackground: () => clearInterval(reconcileTimer),
      closeHttp: () => app.close(),
      closePreviewGateway: () => previewGateway.close(),
      disposeLiveChannels: () => liveChannels.dispose(),
      disposePreview: () => previews.dispose(),
      disposeConnections: () => connections.disposeAll(),
      closeDatabase: closeDb,
      log: (message, error) => {
        if (error === undefined) console.log(message);
        else console.error(message, error);
      },
    }),
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[flock-orchestrator] failed to start', err);
    process.exit(1);
  });
}

export { buildServer } from './server.js';
