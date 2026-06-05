/**
 * Live channels wiring — assembles the runtime pieces that were built + tested
 * but never connected into the running orchestrator: the live status map + the
 * `/ws/status` fan-out, the per-session-token hook endpoint, and the
 * `/ws/pty/:id` terminal bridge. Without this, a session sits at "starting" with
 * no status events and the terminal shows "reconnecting" forever.
 *
 * Design notes:
 *   - Status is in-memory authoritative (spec §6.6); transitions fan out over WS
 *     and write-behind to Postgres via the events queue (NFR-PERF1).
 *   - The hook endpoint + PTY bridge resolve sessions from an in-memory binding
 *     that is hydrated from the DB on demand (and seeded on boot) — the hot path
 *     itself never reads Postgres.
 *   - The PTY bridge resolves each session's node transport via the
 *     NodeConnectionManager, so the live terminal works for local AND ssh nodes.
 */
import type { Server as HttpServer } from 'node:http';

import type { AgentTelemetry, HookTelemetry, Status } from '@flock/shared';

import { eq, sql } from 'drizzle-orm';
import { WebSocketServer } from 'ws';

import type { Database } from './db/client.js';
import { agentSessions } from './db/schema.js';
import { rowToSession } from './db/mappers.js';
import { verifyPassword } from './auth/hashing.js';
import { StatusMap, StatusChannel } from './status/index.js';
import {
  WriteBehindEventQueue,
  createDrizzleEventWriter,
  type EventRecord,
} from './events/index.js';
import {
  HookEndpointService,
  type HookSessionAuth,
} from './hooks/index.js';
import { OscFallbackStatusSource } from './status/osc-fallback/index.js';
import { contextPct, estimateCostUsd, lookupModel } from './sessions/model-info.js';
import { attachWsHeartbeat } from './ws-heartbeat.js';
import {
  PtySessionRegistry,
  type PtySessionBinding,
} from './sessions/pty-ws/pty-session-registry.js';
import { PtyWsServer } from './sessions/pty-ws/pty-ws-server.js';
import type { NodeConnectionManager } from './nodes/node-connection-manager.js';

/**
 * Turn an agent's RAW hook telemetry into the COMPUTED {@link AgentTelemetry}
 * the paddock renders. Mirrors the agentd telemetry path (`mergeMeta` in
 * index.ts): context-% comes from the model-info table; cost prefers the agent's
 * OWN figure (OpenCode reports exact USD) and falls back to our blended estimate.
 */
function toAgentTelemetry(raw: HookTelemetry): AgentTelemetry {
  return {
    tokens: raw.tokens,
    model: raw.model,
    contextPct: contextPct(raw.model, raw.contextTokens),
    contextTokens: raw.contextTokens,
    contextLimit: raw.contextTokens != null ? lookupModel(raw.model).contextLimit : undefined,
    costUsd: raw.costUsd ?? estimateCostUsd(raw.model, raw.tokens),
  };
}

/** A live session binding cached in memory (hot-path lookups never hit the DB). */
interface LiveSession {
  id: string;
  nodeId: string;
  tmuxSessionName: string;
  workingDir: string;
  hookTokenHash: string;
  /** Initial status to seed the live map with (defaults to 'starting'). A
   *  hook-less `terminal` session is created 'running' and must seed as such. */
  status?: Status;
  statusDetail?: string | null;
}

export interface LiveChannels {
  statusMap: StatusMap;
  hookService: HookEndpointService;
  /** Register/refresh a session in the in-memory binding (call on create). */
  trackSession(session: LiveSession): void;
  /** Drop a session from the live binding, status map, and PTY (call on terminate). */
  untrackSession(sessionId: string): void;
  /** Hydrate the in-memory binding from the DB (call on boot). */
  hydrate(): Promise<void>;
  /** Append an event to the write-behind log (e.g. reconcile resync events). */
  enqueueEvent(record: EventRecord): void;
  /** Attach the status + pty WS servers to the HTTP server (after listen). */
  attach(server: HttpServer): void;
  dispose(): Promise<void>;
}

export interface LiveChannelsDeps {
  db: Database;
  connections: NodeConnectionManager;
  /**
   * Authorize a WS upgrade (NFR-SEC6 + T4/T5): Origin + valid cookie, and for a
   * session-scoped socket (sessionId given) that the user OWNS it or is admin. The
   * status stream passes no sessionId (any authed user). See makeWsAuthorizer.
   */
  authorizeUpgrade(req: import('node:http').IncomingMessage, sessionId?: string | null): Promise<boolean>;
  /**
   * flock-agentd PTY resolver — the only PTY transport. Returns a binding that
   * sources the PTY from the node daemon's raw PTY; returning null surfaces as a
   * terminal error (no fallback). `isShell` marks the `:shell[-n]` split/drawer
   * panes so they open fresh daemon shells distinct from the agent's own PTY.
   */
  agentdResolve?: (
    sessionId: string,
    base: { nodeId: string; workingDir: string },
    isShell: boolean,
  ) => Promise<PtySessionBinding | null>;
}

export function createLiveChannels(deps: LiveChannelsDeps): LiveChannels {
  const { db } = deps;

  // In-memory binding: sessionId -> live session (hook auth + pty attach info).
  const live = new Map<string, LiveSession>();

  // --- status + write-behind events -------------------------------------
  const events = new WriteBehindEventQueue({
    writer: createDrizzleEventWriter(db),
    retryBackoffMs: 250,
  });
  const statusMap = new StatusMap({ writeBehind: events.transitionSink() });
  const statusChannel = new StatusChannel(statusMap);

  // --- hook endpoint (per-session token; DB-free hot path) ---------------
  const hookService = new HookEndpointService({
    lookup: {
      getHookAuth(sessionId: string): HookSessionAuth | undefined {
        const s = live.get(sessionId);
        return s ? { sessionId: s.id, hookTokenHash: s.hookTokenHash } : undefined;
      },
    },
    verifyToken: (hash, token) => verifyPassword(hash, token),
    onTransition: (t) => {
      // Turn RAW agent telemetry into the COMPUTED shape the paddock consumes:
      // context-% via the model-info table; prefer the agent's OWN reported cost
      // (OpenCode reports exact USD) over our blended estimate.
      const meta = t.telemetry ? toAgentTelemetry(t.telemetry) : undefined;
      if (t.status !== null) {
        statusMap.set(t.sessionId, t.status, t.detail, true, meta);
        return;
      }
      // Telemetry-only frame: keep the current status, ride the telemetry out on
      // the WS (persist:false → no timeline row). Skipped if the session has no
      // live status yet (nothing to preserve).
      if (!meta) return;
      const current = statusMap.get(t.sessionId)?.status;
      if (current) statusMap.set(t.sessionId, current, t.detail, false, meta);
    },
    enqueueEvent: events.hookEnqueue(),
  });

  // OSC/PTY status fallback (US-20): derive status from terminal ACTIVITY for a
  // session that hooks haven't moved off "starting" (e.g. an agent idling at a
  // login/permission prompt, or a hook-less generic session). Only applied while
  // the live status is still "starting" so it NEVER overrides an accurate
  // hook-driven transition for a working agent. Active while a terminal is
  // attached (output is flowing); per-session source cleaned up on untrack.
  const fallbacks = new Map<string, OscFallbackStatusSource>();
  function feedFallback(sessionId: string, chunk: Buffer): void {
    let src = fallbacks.get(sessionId);
    if (!src) {
      src = new OscFallbackStatusSource({
        onSignal: (sig) => {
          if (statusMap.get(sessionId)?.status === 'starting') {
            // persist:false → drives the live dot but writes NO timeline event.
            // The OSC reason is a debug heuristic, not a user-facing milestone.
            statusMap.set(sessionId, sig.status, `osc:${sig.reason}`, false);
          }
        },
      });
      fallbacks.set(sessionId, src);
    }
    src.push(chunk);
  }

  // --- pty bridge: resolve the daemon PTY transport per session ----------
  const registry = new PtySessionRegistry({
    onOutput: feedFallback,
    // A genuine process exit → mark the session done. A TRANSIENT link drop →
    // mark 'disconnected' (the agent persists on the daemon; the dot recovers
    // when the client reconnects). Stop any OSC fallback timer either way.
    onExit: (sessionId, event) => {
      fallbacks.get(sessionId)?.stop();
      fallbacks.delete(sessionId);
      if (event?.transient) {
        statusMap.set(sessionId, 'disconnected', 'node link lost — reconnecting');
      } else {
        statusMap.set(sessionId, 'done', 'process exited');
      }
    },
    resolve: async (sessionId: string) => {
      // The shell drawer (US-35) + terminal splits open SEPARATE shells via the
      // derived id `<baseId>:shell` (and `<baseId>:shell-2`, `-3`, … for extra
      // split panes) — fresh persistent daemon shells in the session's working
      // dir, distinct from the agent's own session. Route the suffix here.
      const shellMatch = sessionId.match(/:shell(-\d+)?$/);
      const isShell = shellMatch !== null;
      const baseId = isShell ? sessionId.slice(0, shellMatch.index) : sessionId;
      const s = live.get(baseId) ?? (await loadSession(baseId));
      if (!s) throw new Error(`No session ${baseId}`);
      // flock-agentd is the only transport: source the PTY from the node daemon
      // (raw PTY). Throws if the daemon link is down — surfaced as a terminal
      // error (+ red dot), never a silent fallback.
      if (!deps.agentdResolve) throw new Error('no PTY transport configured');
      const binding = await deps.agentdResolve(
        sessionId,
        { nodeId: s.nodeId, workingDir: s.workingDir },
        isShell,
      );
      if (!binding) throw new Error(`flock-agentd could not resolve session ${sessionId}`);
      return binding;
    },
  });
  const ptyServer = new PtyWsServer({
    registry,
    // T4/T5: Origin + valid cookie + the user owns this session (or is admin).
    authenticate: (req, sessionId) => deps.authorizeUpgrade(req, sessionId),
  });

  // Status WS server (own noServer WSS; shares the http upgrade event).
  const statusWss = new WebSocketServer({ noServer: true });
  const stopStatusHeartbeat = attachWsHeartbeat(statusWss);

  async function loadSession(sessionId: string): Promise<LiveSession | undefined> {
    const [row] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (!row) return undefined;
    const s = rowToSession(row);
    const entry: LiveSession = {
      id: s.id,
      nodeId: s.nodeId,
      tmuxSessionName: s.tmuxSessionName,
      workingDir: s.workingDir,
      hookTokenHash: s.hookTokenHash,
    };
    live.set(s.id, entry);
    return entry;
  }

  return {
    statusMap,
    hookService,
    enqueueEvent: (record) => events.enqueue(record),
    trackSession(session) {
      live.set(session.id, session);
      // Seed the status map so the sidebar shows the session immediately. Agents
      // seed 'starting' (their hooks advance it); a terminal seeds 'running'.
      if (!statusMap.get(session.id)) {
        statusMap.set(session.id, session.status ?? 'starting', session.statusDetail ?? null);
      }
    },
    untrackSession(sessionId) {
      // Drop the live binding (hook auth + pty resolve), close any PTY attach,
      // and remove the session from the status map so it leaves the sidebar.
      live.delete(sessionId);
      registry.closeSession(sessionId);
      statusMap.delete(sessionId);
      fallbacks.get(sessionId)?.stop();
      fallbacks.delete(sessionId);
    },
    async hydrate() {
      const rows = await db.select().from(agentSessions);
      // Resume each session's LAST-KNOWN live status (from its newest event)
      // rather than the create-time record status. Without this, a restart
      // re-seeds a stuck 'starting' session, which the OSC fallback then flaps to
      // 'idle' — one noisy starting→idle pair in the timeline per restart. The
      // record's `status` column is the create-time value (live status is
      // in-memory authoritative, §6.6), so it would otherwise reset on every boot.
      const lastStatus = new Map<string, { status: Status; detail: string | null }>();
      try {
        const res = await db.execute<{
          session_id: string;
          mapped_status: string;
          detail: string | null;
        }>(sql`
          SELECT DISTINCT ON (session_id) session_id, mapped_status, detail
          FROM events
          WHERE mapped_status IS NOT NULL
          ORDER BY session_id, seq DESC
        `);
        for (const r of res.rows) {
          lastStatus.set(r.session_id, {
            status: r.mapped_status as Status,
            detail: r.detail ?? null,
          });
        }
      } catch {
        /* best-effort; fall back to the record's create-time status below */
      }
      for (const row of rows) {
        if (row.closedAt) continue;
        const s = rowToSession(row);
        live.set(s.id, {
          id: s.id,
          nodeId: s.nodeId,
          tmuxSessionName: s.tmuxSessionName,
          workingDir: s.workingDir,
          hookTokenHash: s.hookTokenHash,
        });
        if (!statusMap.get(s.id)) {
          // seed() (not set()) so boot-restore writes no event row — see StatusMap.
          const seed = lastStatus.get(s.id);
          statusMap.seed(s.id, seed?.status ?? s.status, seed?.detail ?? s.statusDetail);
        }
      }
    },
    attach(server: HttpServer) {
      // PTY bridge claims /ws/pty/* via its own upgrade handler.
      ptyServer.attach(server);
      // Status channel claims /ws/status.
      server.on('upgrade', (req, socket, head) => {
        const path = (req.url ?? '').split('?')[0];
        if (path !== '/ws/status') return; // not ours; another handler owns it
        void (async () => {
          // Status stream is not session-scoped → any authed user (origin-checked).
          const ok = await deps.authorizeUpgrade(req);
          if (!ok) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }
          statusWss.handleUpgrade(req, socket, head, (ws) => {
            // Emit 'connection' so the heartbeat's pong tracking arms (handleUpgrade
            // does not) — otherwise the status WS is reaped every ~30-60s too.
            statusWss.emit('connection', ws, req);
            statusChannel.add(ws);
            // Replay current snapshot so a fresh client paints immediately.
            for (const [sessionId, entry] of Object.entries(statusMap.snapshot())) {
              ws.send(
                JSON.stringify({
                  channel: 'status',
                  sessionId,
                  status: entry.status,
                  detail: entry.detail,
                  ts: entry.ts,
                }),
              );
            }
            ws.on('close', () => statusChannel.remove(ws));
            ws.on('error', () => statusChannel.remove(ws));
          });
        })();
      });
    },
    async dispose() {
      stopStatusHeartbeat();
      statusChannel.close();
      ptyServer.close();
      statusWss.close();
      registry.closeAll();
      await events.stop();
    },
  };
}
