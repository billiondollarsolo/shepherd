/**
 * WebSocket upgrade authorization (T4 + T5).
 *
 * WS upgrades are NOT covered by SameSite the way fetch is, so a hostile page can
 * open a socket carrying the user's cookie (cross-site WebSocket hijacking). And
 * the surface guard only validates the cookie — it never checked that the user
 * OWNS the session, so any authed user could attach to any `/ws/pty/<id>` (read +
 * inject keystrokes) or `/ws/screencast/<id>`. This module closes both:
 *   - T5: reject upgrades whose Origin isn't our own.
 *   - T4: for a session-scoped socket, require the user to own it.
 */
import type { IncomingMessage } from 'node:http';
import type { User } from '@flock/shared';

export interface WsAuthDeps {
  /** Exact canonical browser origins accepted by startup configuration. */
  allowedOrigins: ReadonlySet<string>;
  /** Resolve the signed-in user from the request cookie, or null. */
  resolveUser(cookieHeader: string | undefined): Promise<User | null>;
  /** Owner (user id) of a session, or null when the session is unknown/invalid. */
  sessionOwner(sessionId: string): Promise<string | null>;
}

/**
 * Origin check (T5, anti-CSWSH): a browser ALWAYS sends Origin on a WS upgrade,
 * so a cross-site origin is rejected unless its exact canonical origin appears in
 * the startup allowlist. Missing Origin remains valid for deliberate non-browser
 * clients, which do not receive ambient browser cookies.
 */
export function originAllowed(req: IncomingMessage, allowedOrigins: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client; no CSWSH risk
  if (Array.isArray(origin)) return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

/**
 * Build the WS upgrade authorizer. Returns `(req, sessionId?) => Promise<boolean>`:
 * with a sessionId it's a session-scoped socket (PTY/screencast) → exact owner;
 * without (the global status stream) → any authed user. Origin is always checked.
 * Unknown and null-owner sessions fail closed. Human-role bypasses do not belong in
 * this boundary; Flock's supported product model has one explicit owner.
 */
export function makeWsAuthorizer(deps: WsAuthDeps) {
  return async (req: IncomingMessage, sessionId?: string | null): Promise<boolean> => {
    if (!originAllowed(req, deps.allowedOrigins)) return false;
    const user = await deps.resolveUser(req.headers.cookie);
    if (!user) return false;
    if (!sessionId) return true; // status stream: any authed user
    const owner = await deps.sessionOwner(sessionId);
    return owner !== null && owner === user.id;
  };
}
