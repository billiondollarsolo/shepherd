/**
 * WebSocket upgrade authorization (T4 + T5).
 *
 * WS upgrades are NOT covered by SameSite the way fetch is, so a hostile page can
 * open a socket carrying the user's cookie (cross-site WebSocket hijacking). And
 * the surface guard only validates the cookie — it never checked that the user
 * OWNS the session, so any authed user could attach to any `/ws/pty/<id>` (read +
 * inject keystrokes) or `/ws/screencast/<id>`. This module closes both:
 *   - T5: reject upgrades whose Origin isn't our own.
 *   - T4: for a session-scoped socket, require the user to own it (or be admin).
 */
import type { IncomingMessage } from 'node:http';
import type { User } from '@flock/shared';

export interface WsAuthDeps {
  /** The app's public origin (PUBLIC_BASE_URL); used for the Origin check. */
  allowedOrigin?: string;
  /**
   * Insecure dev mode (FLOCK_INSECURE_COOKIES=1): the app is reached via
   * localhost / LAN IP / Tailscale interchangeably and isn't a hostile
   * environment, so the cross-site Origin check is skipped (it otherwise rejects
   * any host that isn't PUBLIC_BASE_URL — the "connecting forever" dev bug).
   */
  insecureDev?: boolean;
  /** Resolve the signed-in user from the request cookie, or null. */
  resolveUser(cookieHeader: string | undefined): Promise<User | null>;
  /** Owner (user id) of a session, or null if unknown/legacy. */
  sessionOwner(sessionId: string): Promise<string | null>;
}

/** The Host the request actually arrived on (proxy-aware). */
function requestHost(req: IncomingMessage): string | undefined {
  const fwd = req.headers['x-forwarded-host'];
  const host = Array.isArray(fwd) ? fwd[0] : fwd;
  return host || req.headers.host || undefined;
}

/**
 * Origin check (T5, anti-CSWSH): a browser ALWAYS sends Origin on a WS upgrade,
 * so a cross-site origin → reject. Accept when ANY of:
 *   - no Origin (non-browser client: curl, the orchestrator's own probes);
 *   - `dev` (insecure dev mode) — reached via localhost/LAN/Tailscale, not hostile;
 *   - the Origin's host == the host the request arrived on (same-origin — the
 *     canonical, host-AGNOSTIC CSWSH defense; works behind Caddy via X-Forwarded-Host);
 *   - the Origin matches the configured PUBLIC_BASE_URL exactly;
 *   - PUBLIC_BASE_URL isn't configured (don't block).
 */
export function originAllowed(
  req: IncomingMessage,
  allowedOrigin?: string,
  opts?: { dev?: boolean },
): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; no CSWSH risk
  if (opts?.dev) return true; // dev: any access host is fine
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const host = requestHost(req);
  if (host && o.host === host) return true; // same-origin as the request arrived
  if (allowedOrigin) {
    try {
      return o.origin === new URL(allowedOrigin).origin;
    } catch {
      return false;
    }
  }
  return true; // not configured → don't block
}

/**
 * Build the WS upgrade authorizer. Returns `(req, sessionId?) => Promise<boolean>`:
 * with a sessionId it's a session-scoped socket (PTY/screencast) → owner-or-admin;
 * without (the global status stream) → any authed user. Origin is always checked.
 * A null owner (legacy session created before owner tracking) is allowed for any
 * authed user so existing sessions keep working.
 */
export function makeWsAuthorizer(deps: WsAuthDeps) {
  return async (req: IncomingMessage, sessionId?: string | null): Promise<boolean> => {
    if (!originAllowed(req, deps.allowedOrigin, { dev: deps.insecureDev })) return false;
    const user = await deps.resolveUser(req.headers.cookie);
    if (!user) return false;
    if (!sessionId) return true; // status stream: any authed user
    if (user.role === 'admin') return true;
    const owner = await deps.sessionOwner(sessionId);
    return owner === null || owner === user.id;
  };
}

export type WsAuthorizer = ReturnType<typeof makeWsAuthorizer>;
