/**
 * US-13 — DELETE /api/sessions/:id route tests (run under `pnpm test:unit`).
 *
 * Exercises the HTTP surface with Fastify `inject` (no real port), using fakes
 * for the auth guard and the terminate service so the assertions are about the
 * route wiring only:
 *   - unauthenticated callers get 401 (NFR-SEC6) and the service is NOT called;
 *   - an authenticated DELETE returns 200 + the shared TerminateSessionResponse
 *     and forwards the authed user id + request ip to the service;
 *   - an unknown session maps SessionNotFoundError → 404 (spec §10);
 *   - a malformed id param is rejected with 400.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { User } from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { registerTerminateSessionRoute } from './terminate-route.js';
import {
  SessionNotFoundError,
  type TerminateContext,
} from './terminate-session-service.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const FAKE_USER: User = {
  id: USER_ID,
  username: 'op',
  role: 'admin',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};

/** Auth guard fake: a known cookie value resolves to FAKE_USER, else null. */
const authStub: AuthGuardDeps = {
  async getUserBySession(sessionId: string): Promise<User | null> {
    return sessionId === 'good-cookie' ? FAKE_USER : null;
  },
};

/** Minimal terminate-service stand-in capturing the call. */
class FakeTerminateService {
  readonly calls: Array<{ id: string; ctx: TerminateContext }> = [];
  notFound = false;
  async terminate(id: string, ctx: TerminateContext) {
    this.calls.push({ id, ctx });
    if (this.notFound) throw new SessionNotFoundError(id);
    return { sessionId: id, terminated: true as const, closedAt: '2026-05-29T01:00:00.000Z' };
  }
}

function buildApp(service: FakeTerminateService) {
  const app = Fastify({ logger: false });
  // The route accepts the structural TerminateSessionService shape; the fake
  // satisfies the `terminate` method the route calls.
  registerTerminateSessionRoute(app, {
    service: service as unknown as Parameters<typeof registerTerminateSessionRoute>[1]['service'],
    auth: authStub,
  });
  return app;
}

describe('DELETE /api/sessions/:id (US-13 route)', () => {
  it('rejects an unauthenticated request with 401 and does not call the service', async () => {
    const service = new FakeTerminateService();
    const app = buildApp(service);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${SESSION_ID}` });
      expect(res.statusCode).toBe(401);
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('terminates an authed request: 200 + response body, forwarding user id + ip', async () => {
    const service = new FakeTerminateService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${SESSION_ID}`,
        headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sessionId: SESSION_ID,
        terminated: true,
        closedAt: '2026-05-29T01:00:00.000Z',
      });
      expect(service.calls).toHaveLength(1);
      expect(service.calls[0]!.id).toBe(SESSION_ID);
      expect(service.calls[0]!.ctx.userId).toBe(USER_ID);
      expect(service.calls[0]!.ctx.ip).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('maps an unknown session to 404 (spec §10)', async () => {
    const service = new FakeTerminateService();
    service.notFound = true;
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/sessions/${SESSION_ID}`,
        headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('session_not_found');
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed session id with 400', async () => {
    const service = new FakeTerminateService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/sessions/not-a-uuid',
        headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
      });
      expect(res.statusCode).toBe(400);
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
