import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  buildClearSessionCookie,
  buildSessionCookie,
  cookieSecure,
  readSessionCookie,
} from './cookie.js';

describe('auth/cookie (US-5, NFR-SEC1)', () => {
  const prev = process.env.FLOCK_INSECURE_COOKIES;
  beforeEach(() => {
    delete process.env.FLOCK_INSECURE_COOKIES;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.FLOCK_INSECURE_COOKIES;
    else process.env.FLOCK_INSECURE_COOKIES = prev;
  });

  it('session cookie is HttpOnly + Secure + SameSite=Strict by default', () => {
    const c = buildSessionCookie('sess-123', 1000 * 60);
    expect(c).toContain(`${SESSION_COOKIE}=sess-123`);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Secure/i);
    expect(c).toMatch(/SameSite=Strict/i);
    expect(c).toMatch(/Path=\//i);
  });

  it('omits Secure when FLOCK_INSECURE_COOKIES=1 (local http dev)', () => {
    process.env.FLOCK_INSECURE_COOKIES = '1';
    expect(cookieSecure()).toBe(false);
    expect(buildSessionCookie('s', 60_000)).not.toMatch(/Secure/i);
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
});
