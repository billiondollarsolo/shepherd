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
import { allowsInsecureHttp, deploymentMode } from './origin-policy.js';

/**
 * Production uses the `__Host-` prefix so a compromised preview subdomain
 * cannot plant or overwrite the control-plane login cookie. Browsers enforce
 * that this name is Secure, host-only, and scoped to `/`.
 */
export const SESSION_COOKIE = '__Host-shepherd_session';
export const INSECURE_SESSION_COOKIE = 'shepherd_session';

/**
 * Whether to mark the cookie `Secure`. Production disables it only for the
 * explicitly acknowledged `private-http` deployment mode. Native development
 * may opt into HTTP with the same acknowledgement flag.
 */
export function cookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
  const insecure = allowsInsecureHttp(env);
  const mode = deploymentMode(env);
  if (mode === 'private-http') {
    if (!insecure) {
      throw new Error(
        'private-http requires FLOCK_ALLOW_INSECURE_HTTP=1 as an explicit acknowledgement',
      );
    }
    return false;
  }
  if (mode !== 'development' && insecure) {
    throw new Error(
      'FLOCK_ALLOW_INSECURE_HTTP=1 is valid only with FLOCK_DEPLOYMENT_MODE=private-http',
    );
  }
  return !insecure;
}

/** Cookie name appropriate for the configured transport. */
export function sessionCookieName(env: NodeJS.ProcessEnv = process.env): string {
  return cookieSecure(env) ? SESSION_COOKIE : INSECURE_SESSION_COOKIE;
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
  return serialize(sessionCookieName(), sessionId, baseOptions(Math.floor(ttlMs / 1000)));
}

/** Serialize a `Set-Cookie` value that immediately clears the session cookie. */
export function buildClearSessionCookie(): string {
  return serialize(sessionCookieName(), '', baseOptions(0));
}

/** Extract the session id from a raw `Cookie` header, or null when absent. */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const expectedName = sessionCookieName();
  // `cookie.parse()` keeps only one duplicate. Reject duplicates before parsing:
  // a Preview app on another port shares the cookie host and must not be able to
  // introduce an ambiguous second auth credential.
  const matching = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf('=')).trim() === expectedName);
  if (matching.length !== 1) return null;
  const parsed = parse(cookieHeader);
  return parsed[expectedName] ?? null;
}
