/**
 * US-39 — auth on ALL surfaces (NFR-SEC1, NFR-SEC6, spec §8.1/§8.2).
 *
 * Per-route `requireAuth` guards establish the owner. The surface guard hardens the
 * posture to default-DENY across every surface so that:
 *   - all UI/API/WS require authentication (NFR-SEC6), and
 *   - the hook endpoint is the ONE exception, authed by its own per-session
 *     token rather than the login cookie (spec §8.1 line 187).
 *
 * Three collaborators, all sharing the same `getUserBySession` seam as the
 * per-route guards (so the concrete {@link AuthService} satisfies all of them):
 *
 *   - {@link makeSurfaceAuthGuard} — a global `onRequest` hook for the HTTP
 *     server. Every request is 401'd unless it is authenticated by a valid
 *     session cookie, on the small public allow-list (login/setup/logout/
 *     health), or the hook endpoint (skipped here; its token check authorizes
 *     it). This is the safety net: a route an author forgets to guard is still
 *     denied to anonymous callers.
 *
 *   - {@link authenticateUpgrade} — the WebSocket upgrade authenticator. The
 *     spec mandates "one AUTHED socket" (§8.2): an upgrade without a valid
 *     session cookie is rejected, so an anonymous client can never open the
 *     status / pty / nodes channels.
 *
 *   - {@link makePtyWsAuthenticator} — a thin adapter that bridges
 *     {@link authenticateUpgrade} to the existing PTY-bridge `authenticate`
 *     gate signature `(req, sessionId) => Promise<boolean>` (US-11), so the live
 *     PTY socket reuses the same cookie auth without duplicating it.
 *
 * TLS itself is terminated by the upstream reverse proxy (the Caddy service in
 * the production compose, NFR-SEC1) — the orchestrator speaks plain HTTP/WS on
 * the internal network and relies on the proxy for the wire encryption.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '@flock/shared';
import type { AuthGuardDeps } from './middleware.js';
import { readSessionCookie } from './cookie.js';

/** Prefix of the hook endpoint — the per-session-token exception (spec §8.1). */
const HOOK_PREFIX = '/api/hooks/';

/** Agent orchestration API — also per-session-token authed (NOT cookie). */
const ORCHESTRATE_PREFIX = '/api/orchestrate/';

/**
 * Surfaces reachable WITHOUT a session cookie. Deliberately tiny: only the
 * routes a user must reach before they have a session (log in / first-run
 * setup), the logout route (idempotent; clears the cookie), and the health
 * probes used by the container/proxy health checks. Everything else is private.
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/logout',
  // First-run probe: reports whether the installation owner still needs creating, so
  // the sign-in UI can show the right screen before any session exists.
  '/api/auth/status',
  '/health',
  '/healthz',
  // T15(a): readiness probe (DB-backed). Public like /health so the
  // orchestrator/proxy/k8s can gate traffic without a session cookie.
  '/ready',
]);

/** Strip query string + trailing slash so classification is canonical. */
function normalizePath(url: string): string {
  const q = url.indexOf('?');
  let path = q === -1 ? url : url.slice(0, q);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/** True when the path is the hook endpoint (per-session-token authed). */
export function isHookPath(url: string): boolean {
  return normalizePath(url).startsWith(HOOK_PREFIX);
}

/** True when the path is the agent orchestration API (per-session-token authed). */
export function isOrchestratePath(url: string): boolean {
  return normalizePath(url).startsWith(ORCHESTRATE_PREFIX);
}

/** True when the path is on the unauthenticated public allow-list. */
export function isPublicPath(url: string): boolean {
  return PUBLIC_PATHS.has(normalizePath(url));
}

function unauthorized(reply: FastifyReply): void {
  void reply.code(401).send({
    error: { code: 'unauthorized', message: 'Authentication required.' },
  });
}

/**
 * Build the global default-deny `onRequest` hook. Returns 401 for any request
 * that is neither public, the hook endpoint, nor cookie-authenticated. On a
 * successful cookie auth it attaches `request.authUser` (so downstream handlers
 * see the user) and returns without sending a reply.
 */
export function makeSurfaceAuthGuard(deps: AuthGuardDeps) {
  return async function surfaceAuthGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const url = request.url ?? request.raw?.url ?? '';

    // The hook endpoint is the ONE per-session-token exception (spec §8.1):
    // never cookie-gate it. Its route handler performs the token check.
    if (isHookPath(url)) return;

    // The agent orchestration API authenticates with the caller's session token
    // (its handler verifies it) — never cookie-gate it.
    if (isOrchestratePath(url)) return;

    // Public, pre-session surfaces (login / setup / logout / health).
    if (isPublicPath(url)) return;

    // Everything else requires a valid session cookie (NFR-SEC6, default-deny).
    const sessionId = readSessionCookie(request.headers.cookie);
    if (!sessionId) {
      unauthorized(reply);
      return;
    }
    const user = await deps.getUserBySession(sessionId);
    if (!user) {
      unauthorized(reply);
      return;
    }
    request.authUser = user;
  };
}

/** Minimal shape of an incoming upgrade request (the Node `IncomingMessage`). */
export interface UpgradeRequestLike {
  headers: { cookie?: string | undefined };
}

/** Result of authenticating a WebSocket upgrade. */
export type UpgradeAuthResult = { ok: true; user: User } | { ok: false };

/**
 * Authenticate a WebSocket upgrade from the session cookie carried on the
 * upgrade request's headers. Returns the resolved user on success; `{ ok:false }`
 * when no/invalid/expired cookie is present (the caller must then destroy the
 * socket without completing the handshake). This enforces "one AUTHED socket"
 * (spec §8.2, NFR-SEC6) for the status / PTY / nodes channels.
 */
export async function authenticateUpgrade(
  deps: AuthGuardDeps,
  request: UpgradeRequestLike,
): Promise<UpgradeAuthResult> {
  const sessionId = readSessionCookie(request.headers.cookie);
  if (!sessionId) return { ok: false };
  const user = await deps.getUserBySession(sessionId);
  if (!user) return { ok: false };
  return { ok: true, user };
}

/**
 * Adapt {@link authenticateUpgrade} to the PTY-bridge `authenticate` gate
 * signature `(req, sessionId) => Promise<boolean>` (see pty-ws-server.ts). The
 * `sessionId` arg is ignored here: cookie auth establishes the *user*, and
 * per-session authorization (does this user own this session?) is a separate
 * concern the registry/owner enforces. Returns true iff the cookie is valid.
 */
export function makePtyWsAuthenticator(deps: AuthGuardDeps) {
  return async function authenticatePtyWsUpgrade(
    req: UpgradeRequestLike,
    _sessionId: string,
  ): Promise<boolean> {
    const result = await authenticateUpgrade(deps, req);
    return result.ok;
  };
}
