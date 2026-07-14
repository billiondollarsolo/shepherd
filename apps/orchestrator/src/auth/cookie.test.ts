import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  INSECURE_SESSION_COOKIE,
  buildClearSessionCookie,
  buildSessionCookie,
  cookieSecure,
  readSessionCookie,
  sessionCookieName,
} from './cookie.js';

describe('auth/cookie (US-5, NFR-SEC1)', () => {
  const prevAllowHttp = process.env.FLOCK_ALLOW_INSECURE_HTTP;
  const prevMode = process.env.FLOCK_DEPLOYMENT_MODE;
  const prevNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    delete process.env.FLOCK_ALLOW_INSECURE_HTTP;
    delete process.env.FLOCK_DEPLOYMENT_MODE;
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    if (prevAllowHttp === undefined) delete process.env.FLOCK_ALLOW_INSECURE_HTTP;
    else process.env.FLOCK_ALLOW_INSECURE_HTTP = prevAllowHttp;
    if (prevMode === undefined) delete process.env.FLOCK_DEPLOYMENT_MODE;
    else process.env.FLOCK_DEPLOYMENT_MODE = prevMode;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('session cookie is HttpOnly + Secure + SameSite=Strict by default', () => {
    const c = buildSessionCookie('sess-123', 1000 * 60);
    expect(c).toContain(`${SESSION_COOKIE}=sess-123`);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Secure/i);
    expect(c).toMatch(/SameSite=Strict/i);
    expect(c).toMatch(/Path=\//i);
  });

  it('omits Secure when local HTTP development is explicitly enabled', () => {
    process.env.FLOCK_ALLOW_INSECURE_HTTP = '1';
    expect(cookieSecure()).toBe(false);
    const cookie = buildSessionCookie('s', 60_000);
    expect(cookie).toContain(`${INSECURE_SESSION_COOKIE}=s`);
    expect(cookie).not.toMatch(/Secure/i);
    expect(sessionCookieName()).toBe(INSECURE_SESSION_COOKIE);
  });

  it('refuses an insecure production flag outside private-http mode', () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOCK_ALLOW_INSECURE_HTTP = '1';
    expect(() => cookieSecure()).toThrow(/valid only.*private-http/);
    expect(() => buildSessionCookie('s', 60_000)).toThrow(/valid only.*private-http/);
  });

  it('uses the host-only non-Secure cookie in acknowledged private HTTP mode', () => {
    process.env.NODE_ENV = 'production';
    process.env.FLOCK_DEPLOYMENT_MODE = 'private-http';
    process.env.FLOCK_ALLOW_INSECURE_HTTP = '1';
    expect(cookieSecure()).toBe(false);
    expect(buildSessionCookie('s', 60_000)).toContain(`${INSECURE_SESSION_COOKIE}=s`);
  });

  it('clear cookie expires the session immediately', () => {
    const c = buildClearSessionCookie();
    expect(c).toContain(`${SESSION_COOKIE}=`);
    expect(c).toMatch(/Max-Age=0/i);
  });

  it('reads the session id back from a Cookie header', () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=abc; other=1`)).toBe('abc');
    expect(readSessionCookie('other=1')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });

  it('does not accept the insecure cookie name on a secure deployment', () => {
    expect(readSessionCookie(`${INSECURE_SESSION_COOKIE}=abc`)).toBeNull();
  });

  it('fails closed on duplicate authentication cookies', () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=valid; ${SESSION_COOKIE}=attacker`)).toBeNull();
  });
});
