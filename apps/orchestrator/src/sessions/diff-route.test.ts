/**
 * US-33 — GET /api/sessions/:id/diff route tests (run under `pnpm test:unit`).
 *
 * Exercises the HTTP surface with Fastify `inject` (no real port), using fakes
 * for the auth guard and the diff service so the assertions are about the route
 * wiring only:
 *   - unauthenticated callers get 401 (NFR-SEC6) and the service is NOT called;
 *   - an authed GET returns 200 + the shared DiffResponse for the session id;
 *   - an unknown session maps SessionNotFoundError → 404 (spec §10);
 *   - a git failure maps DiffUnavailableError → 422;
 *   - a malformed id param is rejected with 400.
 *
 * Mirrors terminate-route.test.ts so the route conventions stay uniform.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { DiffResponse, type User } from '@flock/shared';

import type { AuthGuardDeps } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/cookie.js';
import { registerDiffRoute } from './diff-route.js';
import { DiffSessionNotFoundError, DiffUnavailableError } from './diff-service.js';

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

/** Minimal diff-service stand-in capturing the call + scripting the outcome. */
class FakeDiffService {
  readonly calls: string[] = [];
  outcome:
    | { type: 'ok'; diff: string }
    | { type: 'notFound' }
    | { type: 'unavailable'; detail: string } = { type: 'ok', diff: '' };

  async getDiff(id: string) {
    this.calls.push(id);
    if (this.outcome.type === 'notFound') throw new DiffSessionNotFoundError(id);
    if (this.outcome.type === 'unavailable') {
      throw new DiffUnavailableError(id, this.outcome.detail);
    }
    return {
      sessionId: id,
      diff: this.outcome.diff,
      generatedAt: '2026-05-29T01:00:00.000Z',
    };
  }
}

function buildApp(service: FakeDiffService) {
  const app = Fastify({ logger: false });
  registerDiffRoute(app, {
    service: service as unknown as Parameters<typeof registerDiffRoute>[1]['service'],
    auth: authStub,
  });
  return app;
}

describe('GET /api/sessions/:id/diff (US-33 route)', () => {
  it('rejects an unauthenticated request with 401 and does not call the service', async () => {
    const service = new FakeDiffService();
    const app = buildApp(service);
    try {
      const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/diff` });
      expect(res.statusCode).toBe(401);
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('returns 200 + the shared DiffResponse for an authed request', async () => {
    const diff = 'diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n';
    const service = new FakeDiffService();
    service.outcome = { type: 'ok', diff };
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${SESSION_ID}/diff`,
        headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        sessionId: SESSION_ID,
        diff,
        generatedAt: '2026-05-29T01:00:00.000Z',
      });
      expect(DiffResponse.safeParse(body).success).toBe(true);
      expect(service.calls).toEqual([SESSION_ID]);
    } finally {
      await app.close();
    }
  });

  it('returns 200 with an empty diff for a clean tree', async () => {
    const service = new FakeDiffService();
    service.outcome = { type: 'ok', diff: '' };
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${SESSION_ID}/diff`,
        headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().diff).toBe('');
    } finally {
      await app.close();
    }
  });

  it('maps an unknown session to 404 (spec §10)', async () => {
    const service = new FakeDiffService();
    service.outcome = { type: 'notFound' };
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${SESSION_ID}/diff`,
        headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('session_not_found');
    } finally {
      await app.close();
    }
  });

  it('maps a git failure to 422 (diff_unavailable)', async () => {
    const service = new FakeDiffService();
    service.outcome = { type: 'unavailable', detail: 'fatal: not a git repository' };
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${SESSION_ID}/diff`,
        headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('diff_unavailable');
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed session id with 400', async () => {
    const service = new FakeDiffService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/sessions/not-a-uuid/diff',
        headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
      });
      expect(res.statusCode).toBe(400);
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
