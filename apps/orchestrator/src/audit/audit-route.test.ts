/**
 * US-40 — GET /api/audit route tests (run under `pnpm test:unit`).
 *
 * The authenticated owner READ surface for the append-only audit log (FR-A3, spec §8.1).
 * Exercised over a real in-process Fastify instance with fakes for the auth
 * guard + the query service, so the assertions are about route wiring + the
 * admin-only authorization contract only:
 *   - an unauthenticated caller gets 401 and the service is NOT called;
 *   - the authenticated owner gets 200 + the shared ListAuditResponse;
 *   - query filters (action/userId/limit/offset) are forwarded to the service;
 *   - a malformed query (bad action) is rejected with 400.
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { AuditEntry, User } from '@flock/shared';

import { SESSION_COOKIE } from '../auth/cookie.js';
import type { AuthGuardDeps } from '../auth/middleware.js';
import { registerAuditRoutes } from './audit-route.js';
import type { AuditQueryFilter } from './audit-query-service.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';

const OWNER: User = {
  id: OWNER_ID,
  username: 'owner',
  createdAt: '2026-05-29T00:00:00.000Z',
  lastLoginAt: null,
  isActive: true,
};
/** Auth guard fake: 'owner-cookie' -> owner, else null. */
const authStub: AuthGuardDeps = {
  async getUserBySession(sessionId: string): Promise<User | null> {
    if (sessionId === 'owner-cookie') return OWNER;
    return null;
  },
};

const SAMPLE: AuditEntry = {
  id: '33333333-3333-4333-8333-333333333333',
  ts: '2026-05-29T00:00:00.000Z',
  userId: OWNER_ID,
  action: 'login',
  targetType: 'user',
  targetId: OWNER_ID,
  ip: '1.2.3.4',
  detail: null,
};

/** Captures the filter + returns canned entries. */
class FakeQueryService {
  readonly calls: AuditQueryFilter[] = [];
  constructor(private readonly entries: AuditEntry[] = [SAMPLE]) {}
  async list(filter: AuditQueryFilter): Promise<{ entries: AuditEntry[] }> {
    this.calls.push(filter);
    return { entries: this.entries };
  }
}

function buildApp(service: FakeQueryService) {
  const app = Fastify({ logger: false });
  registerAuditRoutes(app, {
    service: service as unknown as Parameters<typeof registerAuditRoutes>[1]['service'],
    auth: authStub,
  });
  return app;
}

describe('GET /api/audit (US-40 route — owner read)', () => {
  it('rejects an unauthenticated request with 401 and does not call the service', async () => {
    const service = new FakeQueryService();
    const app = buildApp(service);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/audit' });
      expect(res.statusCode).toBe(401);
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('returns 200 + the shared ListAuditResponse for the owner', async () => {
    const service = new FakeQueryService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { cookie: `${SESSION_COOKIE}=owner-cookie` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ entries: [SAMPLE] });
      expect(service.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('forwards action/userId/limit/offset filters to the service', async () => {
    const service = new FakeQueryService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/audit?action=node_remove&userId=${OWNER_ID}&limit=25&offset=5`,
        headers: { cookie: `${SESSION_COOKIE}=owner-cookie` },
      });
      expect(res.statusCode).toBe(200);
      expect(service.calls[0]).toEqual({
        action: 'node_remove',
        userId: OWNER_ID,
        limit: 25,
        offset: 5,
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed query (bad action) with 400', async () => {
    const service = new FakeQueryService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?action=not_a_real_action',
        headers: { cookie: `${SESSION_COOKIE}=owner-cookie` },
      });
      expect(res.statusCode).toBe(400);
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
