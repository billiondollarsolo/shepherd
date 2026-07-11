/**
 * US-15 — POST /api/hooks/:sessionId route tests (run under `pnpm test:unit`).
 *
 * Exercises the HTTP surface with Fastify `inject` (no real port), using a fake
 * {@link HookEndpointService} so the assertions are about route wiring only:
 *   - a missing Authorization header → 401 (NFR-SEC3), service NOT called;
 *   - an invalid token → 401 (HookUnauthorizedError mapped), service called;
 *   - a valid token → 202 + the shared HookCallbackResponse ({ ok: true });
 *   - an unknown/closed session → 404 (spec §10);
 *   - a malformed session id → 400;
 *   - the route is NOT cookie-authed (a cookie alone does not authorize).
 *
 * This is the one endpoint authed by the per-session token, never the session
 * cookie (spec §8.1 line 187).
 */
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createHookAbuseControls, registerHookRoute } from './routes.js';
import { RequestBudget } from '../http/request-budget.js';
import {
  HookSessionNotFoundError,
  HookUnauthorizedError,
  type HandleHookInput,
  type HookCallbackAck,
} from './endpoint.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const GOOD_TOKEN = 'plaintext-hook-token-abc';

/** Minimal service stand-in capturing the call + steering the outcome. */
class FakeHookService {
  readonly calls: HandleHookInput[] = [];
  outcome: 'ok' | 'unauthorized' | 'not_found' = 'ok';

  async handle(input: HandleHookInput): Promise<HookCallbackAck> {
    this.calls.push(input);
    if (this.outcome === 'unauthorized') throw new HookUnauthorizedError();
    if (this.outcome === 'not_found') throw new HookSessionNotFoundError(input.sessionId);
    return { ok: true };
  }
}

function buildApp(
  service: FakeHookService,
  abuse?: Parameters<typeof registerHookRoute>[1]['abuse'],
) {
  const app = Fastify({ logger: false });
  registerHookRoute(app, {
    service: service as unknown as Parameters<typeof registerHookRoute>[1]['service'],
    abuse,
  });
  return app;
}

describe('POST /api/hooks/:sessionId (US-15 route)', () => {
  it('leaves measurable headroom for telemetry-heavy sessions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { perSession } = createHookAbuseControls();
      for (let i = 0; i < 600; i += 1) {
        const permit = perSession.enter(SESSION_ID);
        expect(permit.allowed).toBe(true);
        if (permit.allowed) permit.release();
      }
      expect(perSession.enter(SESSION_ID)).toMatchObject({ allowed: false, reason: 'rate' });
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects a request with NO Authorization header with 401 (NFR-SEC3)', async () => {
    const service = new FakeHookService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/hooks/${SESSION_ID}`,
        payload: { hook_event_name: 'Stop' },
      });
      expect(res.statusCode).toBe(401);
      // A missing token is rejected at the edge; the service is never invoked
      // (no work done for an unauthenticated caller).
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('maps an invalid token (HookUnauthorizedError) to 401', async () => {
    const service = new FakeHookService();
    service.outcome = 'unauthorized';
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/hooks/${SESSION_ID}`,
        headers: { authorization: 'Bearer wrong' },
        payload: { hook_event_name: 'Stop' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    } finally {
      await app.close();
    }
  });

  it('accepts a valid token: 202 + { ok: true } and forwards token + body + sessionId', async () => {
    const service = new FakeHookService();
    const app = buildApp(service);
    try {
      const body = { hook_event_name: 'Notification', notification_type: 'permission_prompt' };
      const res = await app.inject({
        method: 'POST',
        url: `/api/hooks/${SESSION_ID}`,
        headers: { authorization: `Bearer ${GOOD_TOKEN}` },
        payload: body,
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ ok: true });
      expect(service.calls).toHaveLength(1);
      expect(service.calls[0]!.sessionId).toBe(SESSION_ID);
      expect(service.calls[0]!.token).toBe(GOOD_TOKEN);
      expect(service.calls[0]!.body).toEqual(body);
    } finally {
      await app.close();
    }
  });

  it('does NOT authorize on a session cookie (per-session token only)', async () => {
    const service = new FakeHookService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/hooks/${SESSION_ID}`,
        headers: { cookie: 'flock_session=some-valid-looking-cookie' },
        payload: { hook_event_name: 'Stop' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('maps an unknown/closed session to 404 (spec §10)', async () => {
    const service = new FakeHookService();
    service.outcome = 'not_found';
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/hooks/${SESSION_ID}`,
        headers: { authorization: `Bearer ${GOOD_TOKEN}` },
        payload: { hook_event_name: 'Stop' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('session_not_found');
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed session id with 400 and does not call the service', async () => {
    const service = new FakeHookService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/hooks/not-a-uuid',
        headers: { authorization: `Bearer ${GOOD_TOKEN}` },
        payload: { hook_event_name: 'Stop' },
      });
      expect(res.statusCode).toBe(400);
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('accepts an arbitrary JSON object body (fast path never rejects on schema drift)', async () => {
    const service = new FakeHookService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/hooks/${SESSION_ID}`,
        headers: { authorization: `Bearer ${GOOD_TOKEN}` },
        payload: { totally: 'unexpected', shape: 123 },
      });
      expect(res.statusCode).toBe(202);
      expect(service.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('rate-limits sustained per-session traffic with Retry-After', async () => {
    const service = new FakeHookService();
    const makeBudget = () =>
      new RequestBudget({
        maxRequests: 1,
        windowMs: 60_000,
        maxConcurrent: 2,
        maxConcurrentPerKey: 2,
      });
    const app = buildApp(service, { perIp: makeBudget(), perSession: makeBudget() });
    const request = () =>
      app.inject({
        method: 'POST',
        url: `/api/hooks/${SESSION_ID}`,
        headers: { authorization: `Bearer ${GOOD_TOKEN}` },
        payload: { hook_event_name: 'Stop' },
      });
    try {
      expect((await request()).statusCode).toBe(202);
      const blocked = await request();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      expect(blocked.json().error.code).toBe('too_many_requests');
      expect(service.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('rejects hook bodies larger than the explicit endpoint limit', async () => {
    const service = new FakeHookService();
    const app = buildApp(service);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/hooks/${SESSION_ID}`,
        headers: { authorization: `Bearer ${GOOD_TOKEN}` },
        payload: { output: 'x'.repeat(300 * 1024) },
      });
      expect(res.statusCode).toBe(413);
      expect(service.calls).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
