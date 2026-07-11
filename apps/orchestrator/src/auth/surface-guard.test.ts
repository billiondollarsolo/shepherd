/**
 * US-39 — TLS + auth on ALL surfaces (NFR-SEC1, NFR-SEC6).
 *
 * These tests pin the two halves of "auth on every surface":
 *
 *  1. `makeSurfaceAuthGuard` — a global default-DENY `onRequest` hook for the
 *     HTTP server: every request is rejected with 401 UNLESS it is either
 *       (a) authenticated by a valid session cookie, or
 *       (b) on the explicit public allow-list (login/setup/logout/health), or
 *       (c) the hook endpoint, which is the ONE exception authed by its own
 *           per-session token (spec §8.1) and therefore skipped by the cookie
 *           guard entirely.
 *
 *  2. `authenticateUpgrade` — the WebSocket upgrade authenticator. The spec
 *     (§8.2) requires "one AUTHED socket": an upgrade with no/invalid session
 *     cookie must be rejected so an anonymous client can never open the status /
 *     pty / screencast / nodes channels (NFR-SEC6).
 *
 * The guard is the safety net that makes default-deny the posture: even a route
 * an author forgets to attach `requireAuth` to is still rejected. The hook
 * endpoint stays reachable for agents without a cookie.
 */
import { describe, it, expect, vi } from 'vitest';
import type { User } from '@flock/shared';
import {
  makeSurfaceAuthGuard,
  authenticateUpgrade,
  isPublicPath,
  isHookPath,
} from './surface-guard.js';

const ADMIN: User = {
  id: '11111111-1111-1111-1111-111111111111',
  username: 'admin',
  role: 'admin',
  createdAt: new Date(0).toISOString(),
  lastLoginAt: null,
  isActive: true,
} as unknown as User;

type ReplyStub = {
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  statusCode?: number;
};

function makeReply(): ReplyStub {
  const reply: ReplyStub = {
    code: vi.fn(function (this: ReplyStub, c: number) {
      this.statusCode = c;
      return this;
    }),
    send: vi.fn(function (this: ReplyStub) {
      return this;
    }),
  };
  return reply;
}

function makeRequest(opts: { method?: string; url: string; cookie?: string }): {
  method: string;
  url: string;
  raw: { url: string };
  headers: Record<string, string>;
} {
  return {
    method: opts.method ?? 'GET',
    url: opts.url,
    raw: { url: opts.url },
    headers: opts.cookie ? { cookie: opts.cookie } : {},
  };
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

describe('path classification', () => {
  it('treats the hook endpoint as the per-session-token exception', () => {
    expect(isHookPath('/api/hooks/abc')).toBe(true);
    expect(isHookPath('/api/hooks/abc?x=1')).toBe(true);
    expect(isHookPath('/api/sessions/abc')).toBe(false);
  });

  it('allow-lists only the unauthenticated public auth + health surfaces', () => {
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/setup')).toBe(true);
    expect(isPublicPath('/api/auth/logout')).toBe(true);
    expect(isPublicPath('/health')).toBe(true);
    // Everything else is private by default.
    expect(isPublicPath('/api/auth/me')).toBe(false);
    expect(isPublicPath('/api/sessions')).toBe(false);
    expect(isPublicPath('/api/users')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP default-deny guard
// ---------------------------------------------------------------------------

describe('makeSurfaceAuthGuard (HTTP default-deny)', () => {
  it('rejects an unauthenticated request to a protected API route with 401', async () => {
    const getUserBySession = vi.fn(async () => null);
    const guard = makeSurfaceAuthGuard({ getUserBySession });
    const req = makeRequest({ url: '/api/sessions' });
    const reply = makeReply();

    await guard(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    // No cookie at all → never even hits the session lookup.
    expect(getUserBySession).not.toHaveBeenCalled();
  });

  it('rejects a request with an invalid/expired session cookie with 401', async () => {
    const getUserBySession = vi.fn(async () => null);
    const guard = makeSurfaceAuthGuard({ getUserBySession });
    const req = makeRequest({ url: '/api/sessions', cookie: 'flock_session=deadbeef' });
    const reply = makeReply();

    await guard(req as never, reply as never);

    expect(reply.statusCode).toBe(401);
    expect(getUserBySession).toHaveBeenCalledWith('deadbeef');
  });

  it('allows an authenticated request through (no reply sent) and attaches the user', async () => {
    const getUserBySession = vi.fn(async () => ADMIN);
    const guard = makeSurfaceAuthGuard({ getUserBySession });
    const req = makeRequest({ url: '/api/sessions', cookie: 'flock_session=good' });
    const reply = makeReply();

    await guard(req as never, reply as never);

    expect(reply.code).not.toHaveBeenCalled();
    expect((req as { authUser?: User }).authUser).toBe(ADMIN);
  });

  it('lets the public login route through WITHOUT a cookie (so users can log in)', async () => {
    const getUserBySession = vi.fn(async () => null);
    const guard = makeSurfaceAuthGuard({ getUserBySession });
    const req = makeRequest({ method: 'POST', url: '/api/auth/login' });
    const reply = makeReply();

    await guard(req as never, reply as never);

    expect(reply.code).not.toHaveBeenCalled();
    expect(getUserBySession).not.toHaveBeenCalled();
  });

  it('NEVER cookie-gates the hook endpoint — it is the per-session-token exception', async () => {
    const getUserBySession = vi.fn(async () => null);
    const guard = makeSurfaceAuthGuard({ getUserBySession });
    // No cookie: the hook endpoint must NOT be 401'd by the cookie guard; its
    // own per-session-token check (registered separately) authorizes it.
    const req = makeRequest({
      method: 'POST',
      url: '/api/hooks/11111111-1111-1111-1111-111111111111',
    });
    const reply = makeReply();

    await guard(req as never, reply as never);

    expect(reply.code).not.toHaveBeenCalled();
    expect(getUserBySession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WebSocket upgrade authenticator (spec §8.2 — one AUTHED socket)
// ---------------------------------------------------------------------------

describe('authenticateUpgrade (WebSocket)', () => {
  it('rejects an upgrade with no session cookie', async () => {
    const getUserBySession = vi.fn(async () => null);
    const result = await authenticateUpgrade({ getUserBySession }, { headers: {} });
    expect(result.ok).toBe(false);
    expect(getUserBySession).not.toHaveBeenCalled();
  });

  it('rejects an upgrade with an invalid/expired session cookie', async () => {
    const getUserBySession = vi.fn(async () => null);
    const result = await authenticateUpgrade(
      { getUserBySession },
      { headers: { cookie: 'flock_session=deadbeef' } },
    );
    expect(result.ok).toBe(false);
    expect(getUserBySession).toHaveBeenCalledWith('deadbeef');
  });

  it('accepts an upgrade with a valid session cookie and returns the user', async () => {
    const getUserBySession = vi.fn(async () => ADMIN);
    const result = await authenticateUpgrade(
      { getUserBySession },
      { headers: { cookie: 'flock_session=good' } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user).toBe(ADMIN);
    }
  });
});
