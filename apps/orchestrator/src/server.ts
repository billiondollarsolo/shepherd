import Fastify, { type FastifyInstance } from 'fastify';
import { STATUS_VALUES } from '@flock/shared';
import {
  registerAuthRoutes,
  makeSurfaceAuthGuard,
  type AuthService,
  type AuthGuardDeps,
} from './auth/index.js';
import {
  registerDiffRoute,
  registerGitRoutes,
  registerTerminateSessionRoute,
  registerSessionRestRoutes,
  type DiffService,
  type GitService,
  type TerminateService,
  type SessionRestService,
} from './sessions/index.js';
import {
  registerBrowserControlRoutes,
  type BrowserControlService,
} from './browser/browser-control-route.js';
import { errorEnvelope } from './http/reply.js';
import { registerEventRoute, type EventReadService } from './events/index.js';
import { registerPushRoutes, type PushRouteDeps } from './push/index.js';
import { registerHookRoute, type HookRouteService } from './hooks/index.js';
import { registerAuditRoutes, type AuditQueryService } from './audit/index.js';
import {
  registerNodeRoutes,
  registerNodeFsRoute,
  type NodeService,
  type NodeFsService,
} from './nodes/index.js';
import { registerNodeWorkspaceRoutes } from './nodes/node-workspace-route.js';
import type { NodeWorkspaceService } from './nodes/node-workspace-service.js';
import { registerProjectRoutes, type ProjectService } from './projects/index.js';
import { registerMeRoutes } from './me/me-routes.js';

/** Optional collaborators wired into the server (added incrementally per phase). */
export interface BuildServerDeps {
  /**
   * Auth + user-management service (US-4/US-5/US-6). When provided, the
   * `/api/auth/*` and `/api/users` routes are registered. Omitted in the bare
   * health-only smoke test.
   */
  auth?: AuthService;
  /**
   * Session terminate (US-13). When provided ALONGSIDE `auth` (the route is
   * cookie-authed), `DELETE /api/sessions/:id` is registered: it kills the tmux
   * session + any browser harness, marks the record closed, and writes a
   * `session_terminate` audit row (FR-S5).
   */
  terminateSession?: TerminateService;
  /**
   * Read-only session diff (US-33, FR-UI4). When provided ALONGSIDE `auth` (the
   * route is cookie-authed), `GET /api/sessions/:id/diff` is registered: it runs
   * `git diff` of the session working dir on the node and returns the unified
   * diff text for the center pane's read-only Diff tab.
   */
  diff?: DiffService;
  /**
   * Git source-control actions (US-33.1, FR-UI4). When provided ALONGSIDE `auth`,
   * `GET /api/sessions/:id/git/status` and `POST .../git/{stage,unstage,commit,
   * push}` are registered — the Source Control panel's write side. Commit uses
   * the acting user's identity (from `request.authUser`), so it needs `auth`.
   */
  git?: GitService;
  /**
   * Browser input takeover (US-28, FR-B4). When provided ALONGSIDE `auth`,
   * `POST /api/sessions/:id/browser/{takeover,release}` are registered (the
   * paddock's Take/Release control over the screencast pane).
   */
  browserControl?: BrowserControlService;
  /**
   * Session event log read (US-21/US-34). When provided ALONGSIDE `auth`,
   * `GET /api/sessions/:id/events` is registered (the Activity timeline source).
   */
  events?: EventReadService;
  /**
   * Web Push subscription routes (US-22). When provided, `POST/DELETE
   * /api/push/subscribe` + `GET /api/push/vapid-public-key` are registered.
   */
  push?: PushRouteDeps;
  /**
   * Hook callback endpoint (US-15). When provided, `POST /api/hooks/:sessionId`
   * is registered. This route is authed by the PER-SESSION token in the
   * `Authorization` header (NFR-SEC3), NOT the session cookie, so it wires
   * independently of `auth`. It is the one DB-free hot path (spec §15).
   */
  hookEndpoint?: HookRouteService;
  /**
   * flock-agentd health snapshot (the connection indicator). When provided,
   * `GET /api/agentd/status` returns per-node daemon-link state + per-session
   * liveness (is the session's PTY actually running on the daemon) so the paddock
   * can show an affirmative "connected & communicating" dot. Cookie-authed via
   * the global surface guard.
   */
  agentdHealth?: () => Promise<unknown>;
  /**
   * T15(a) — readiness check. When provided, `GET /ready` runs it (a `SELECT 1`
   * against Postgres) and returns 200 only when the dependency is reachable, else
   * 503. `/health` stays pure liveness (process is up). Public (no cookie).
   */
  readiness?: () => Promise<boolean>;
  /**
   * Live host metrics + detected agents for one node (the node-info dialog +
   * bottom status bar). Returns null when the node's daemon link is down.
   */
  nodeInfo?: (nodeId: string) => Promise<unknown | null>;
  /**
   * Terminate a single split-pane PTY by its id (`<sessionId>:shell[-N]`). When
   * provided, `DELETE /api/pty/:id` kills that throwaway shell on the daemon so
   * closing a split pane actually ENDS its terminal (instead of detaching and
   * leaving it running). The agent pane (a top-level session id, no `:shell`
   * suffix) is rejected — that goes through `DELETE /api/sessions/:id`.
   */
  terminatePty?: (ptyId: string) => Promise<void>;
  /**
   * Audit log read surface (US-40, FR-A3). When provided ALONGSIDE `auth`,
   * `GET /api/audit` is registered: it returns the append-only audit rows to an
   * ADMIN (401 unauthenticated, 403 for a member). The read is a durable-store
   * read, never the live status path (spec §6.6).
   */
  audit?: AuditQueryService;
  /**
   * Node CRUD (FR-N1/N2). When provided ALONGSIDE `auth` (the routes are
   * cookie-authed), `GET/POST /api/nodes` and `DELETE /api/nodes/:id` are
   * registered: list/create/remove execution-target nodes. An ssh node's private
   * key is encrypted at rest; the raw key is never stored or returned.
   */
  nodes?: NodeService;
  /**
   * Node filesystem browse. When provided ALONGSIDE `auth`,
   * `GET /api/nodes/:id/fs?path=` is registered: list directories on the node
   * (local or remote) so the UI can offer a path picker for a project's working
   * dir instead of a blind text field.
   */
  nodeFs?: NodeFsService;
  /**
   * Workspace intelligence (stack detection, fuzzy file list, Find-in-Files).
   * When provided ALONGSIDE `auth`, registers `GET /api/nodes/:id/stack`,
   * `GET /api/nodes/:id/files`, `POST /api/nodes/:id/search`.
   */
  nodeWorkspace?: NodeWorkspaceService;
  /**
   * Project CRUD (FR-N3). When provided ALONGSIDE `auth`, `GET/POST
   * /api/projects` are registered: list (optionally by `?nodeId=`) and create
   * node-scoped projects (404 on an unknown node).
   */
  projects?: ProjectService;
  /**
   * Per-user shell APIs (selection, launcher presets, project layouts).
   * When provided ALONGSIDE `auth`, registers `/api/me/*` and project layout routes.
   */
  me?: import('./me/me-routes.js').MeRouteDeps;
  /**
   * Session list/create (FR-S2/S3). When provided ALONGSIDE `auth`, `GET/POST
   * /api/sessions` are registered: list (optionally by `?projectId=`) and create
   * the single authoritative session record (returns the hook token once). The
   * `DELETE /api/sessions/:id` terminate route is wired separately.
   */
  sessions?: SessionRestService;
  /**
   * US-39: global default-DENY surface guard (NFR-SEC6). When provided, an
   * `onRequest` hook rejects every request with 401 unless it is authenticated
   * by a valid session cookie, on the public allow-list (login/setup/logout/
   * health), or the per-session-token hook endpoint (the one exception, spec
   * §8.1). Shares the `getUserBySession` seam with the per-route guards, so the
   * concrete {@link AuthService} satisfies it directly.
   *
   * Wired independently of `auth` so the safety net can be tested in isolation
   * and so it covers routes even before their owning service is supplied.
   */
  surfaceAuth?: AuthGuardDeps;
}

/**
 * Build the orchestrator HTTP server. Kept as a factory (no side effects on
 * import) so unit tests can exercise routes without binding a port.
 *
 * Routes are registered conditionally on the injected {@link BuildServerDeps}
 * so each phase can wire only what it owns. The auth surface (US-4/US-5/US-6)
 * registers when an {@link AuthService} is supplied; the per-session-token hook
 * endpoint (US-15) registers when a {@link HookRouteService} is supplied.
 * Remaining routes (nodes, projects, sessions, and the WS status fan-out) are
 * added by later agents.
 */
export function buildServer(deps: BuildServerDeps = {}): FastifyInstance {
  // T12 — structured request logging via Fastify's built-in pino. Each request
  // logs method/path/status/latency/reqId as JSON for aggregation. Silenced under
  // test (vitest/NODE_ENV=test) to keep suite output clean; level is env-tunable.
  const underTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  // Behind a reverse proxy (Caddy, single-box deploy) Fastify must trust the
  // forwarding hop so `request.ip` is the REAL client, not the proxy — otherwise
  // the login throttle keys on one IP for everyone and audit rows log the wrong
  // actor. FLOCK_TRUST_PROXY: "1" (hop count), a CIDR/IP, or "true"; unset = off
  // (dev, no proxy). Defaults conservative.
  const tpEnv = process.env.FLOCK_TRUST_PROXY?.trim();
  const trustProxy: boolean | number | string =
    !tpEnv ? false : tpEnv === 'true' ? true : /^\d+$/.test(tpEnv) ? Number(tpEnv) : tpEnv;
  const app = Fastify({
    logger: underTest ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy,
  });

  // F2: every error leaves as the shared envelope `{ error: { code, message } }`,
  // including uncaught ones (Fastify's default JSON otherwise leaks a different
  // shape). 5xx messages are NOT echoed to the client (no internal leakage) — the
  // detail is logged instead. Schema-validation failures map to `bad_request`.
  app.setErrorHandler((err, req, reply) => {
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    const status =
      e.validation ? 400 : typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      req.log?.error?.({ err }, 'unhandled request error');
      return reply.code(500).send(errorEnvelope('internal', 'Internal server error'));
    }
    const code = status === 400 ? 'bad_request' : status === 401 ? 'unauthorized' : status === 404 ? 'not_found' : 'error';
    return reply.code(status).send(errorEnvelope(code, e.message ?? 'Request failed'));
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send(errorEnvelope('not_found', `No route for ${req.method} ${req.url}`)),
  );

  // US-39: install the global default-DENY surface guard FIRST so it runs on
  // every request (NFR-SEC6). It allow-lists the public auth + health routes
  // and skips the hook endpoint (its per-session token authorizes it, spec
  // §8.1); everything else needs a valid session cookie. The per-route
  // `requireAuth`/`requireAdmin` guards still run on top for role checks.
  if (deps.surfaceAuth) {
    app.addHook('onRequest', makeSurfaceAuthGuard(deps.surfaceAuth));
  }

  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'flock-orchestrator',
      // Proves the shared package is wired in and imported, not duplicated.
      statuses: STATUS_VALUES,
    };
  });

  // T15(a): readiness — 200 only when the DB answers; 503 otherwise. Distinct from
  // /health so a proxy can keep the box alive (liveness) while pulling it out of
  // rotation when its dependencies are down (readiness).
  if (deps.readiness) {
    const ready = deps.readiness;
    app.get('/ready', async (_req, reply) => {
      const ok = await ready().catch(() => false);
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'unavailable' });
    });
  }

  if (deps.auth) {
    registerAuthRoutes(app, deps.auth);

    // US-13: terminate route is cookie-authed, so it needs the auth service as
    // its guard. Wired only when both the terminate service and auth are present.
    if (deps.terminateSession) {
      registerTerminateSessionRoute(app, {
        service: deps.terminateSession,
        auth: deps.auth,
      });
    }

    // US-33: the read-only diff route is cookie-authed too (NFR-SEC6).
    if (deps.diff) {
      registerDiffRoute(app, { service: deps.diff, auth: deps.auth });
    }

    // US-33.1: git source-control actions (stage/commit/push), cookie-authed.
    if (deps.git) {
      registerGitRoutes(app, { service: deps.git, auth: deps.auth });
    }

    // US-28: browser input takeover/release (cookie-authed, NFR-SEC6).
    if (deps.browserControl) {
      registerBrowserControlRoutes(app, { service: deps.browserControl, auth: deps.auth });
    }

    // US-21/US-34: the read-only session event log (cookie-authed).
    if (deps.events) {
      registerEventRoute(app, { service: deps.events, auth: deps.auth });
    }

    // US-22: Web Push subscription routes (cookie-authed via resolveUserId).
    if (deps.push) {
      registerPushRoutes(app, deps.push);
    }

    // US-40: the admin audit read route is admin-only (requireAdmin), so it
    // needs the auth service as its guard.
    if (deps.audit) {
      registerAuditRoutes(app, { service: deps.audit, auth: deps.auth });
    }

    // Node CRUD (FR-N1/N2): cookie-authed list/create/remove.
    if (deps.nodes) {
      registerNodeRoutes(app, { service: deps.nodes, auth: deps.auth });
    }

    // Node filesystem browse (path picker): cookie-authed.
    if (deps.nodeFs) {
      registerNodeFsRoute(app, { service: deps.nodeFs, auth: deps.auth });
    }

    // Workspace intelligence (stack / files / search), cookie-authed.
    if (deps.nodeWorkspace) {
      registerNodeWorkspaceRoutes(app, { service: deps.nodeWorkspace, auth: deps.auth });
    }

    // Project CRUD (FR-N3): cookie-authed list/create.
    if (deps.projects) {
      registerProjectRoutes(app, { service: deps.projects, auth: deps.auth });
    }

    // Per-user shell: fleet selection, launcher presets, project layouts.
    if (deps.me) {
      registerMeRoutes(app, deps.me);
    }

    // Session list/create (FR-S2/S3): cookie-authed.
    if (deps.sessions) {
      registerSessionRestRoutes(app, { service: deps.sessions, auth: deps.auth });
    }
  }

  // flock-agentd connection health (cookie-authed via the surface guard).
  if (deps.agentdHealth) {
    const health = deps.agentdHealth;
    app.get('/api/agentd/status', async () => health());
  }

  // Per-node host metrics + detected agents (cookie-authed; node-info dialog).
  if (deps.nodeInfo) {
    const nodeInfo = deps.nodeInfo;
    app.get('/api/nodes/:id/info', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const info = await nodeInfo(id);
      if (info == null) {
        return reply
          .code(503)
          .send({ error: { code: 'node_unreachable', message: 'node daemon link is down.' } });
      }
      return reply.code(200).send(info);
    });
  }

  if (deps.terminatePty) {
    const terminatePty = deps.terminatePty;
    // Only `<sessionId>:shell[-N]` ids — a split shell pane — are killable here;
    // a bare session id (the agent) must use the terminate-session route.
    app.delete('/api/pty/:id', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!/:shell(?:-\d+)?$/.test(id)) {
        return reply
          .code(400)
          .send({ error: { code: 'bad_request', message: 'not a split-pane pty id.' } });
      }
      await terminatePty(id);
      return reply.code(204).send();
    });
  }

  // US-15: hook callback endpoint is authed by the per-session token, NOT the
  // session cookie, so it registers independently of `auth` (spec §8.1).
  if (deps.hookEndpoint) {
    registerHookRoute(app, { service: deps.hookEndpoint });
  }

  return app;
}
