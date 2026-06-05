/**
 * Auth session cookie helpers (US-5, FR-A1, NFR-SEC1/SEC6).
 *
 * The login session id is carried in an httpOnly + SameSite=Strict cookie. The
 * `Secure` attribute is set whenever NOT in a test/dev-insecure context so the
 * cookie is only ever sent over TLS in production (NFR-SEC1). httpOnly keeps it
 * out of reach of any script (XSS hardening); SameSite=Strict blocks CSRF on
 * state-changing requests.
 */
import { parse, serialize, type SerializeOptions } from 'cookie';

/** Name of the auth session cookie. */
export const SESSION_COOKIE = 'flock_session';

/**
 * Whether to mark the cookie `Secure`. Defaults to true; disabled only when
 * `FLOCK_INSECURE_COOKIES=1` (local http dev / tests where there is no TLS).
 */
export function cookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FLOCK_INSECURE_COOKIES !== '1';
}

/** Base attributes shared by the set/clear cookie strings. */
function baseOptions(maxAgeSeconds?: number): SerializeOptions {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'strict',
    path: '/',
    ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
  };
}

/** Serialize the `Set-Cookie` value that establishes a login session. */
export function buildSessionCookie(sessionId: string, ttlMs: number): string {
  return serialize(SESSION_COOKIE, sessionId, baseOptions(Math.floor(ttlMs / 1000)));
}

/** Serialize a `Set-Cookie` value that immediately clears the session cookie. */
export function buildClearSessionCookie(): string {
  return serialize(SESSION_COOKIE, '', baseOptions(0));
}

/** Extract the session id from a raw `Cookie` header, or null when absent. */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const parsed = parse(cookieHeader);
  return parsed[SESSION_COOKIE] ?? null;
}
