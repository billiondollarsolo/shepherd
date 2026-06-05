/**
 * US-39 — server-level assertion that EVERY surface is authed (NFR-SEC6) with
 * the hook endpoint as the one per-session-token exception (spec §8.1).
 *
 * Unlike the unit tests in surface-guard.test.ts (which test the guard in
 * isolation), this exercises the wired `buildServer`: it confirms that once the
 * global surface guard is installed, an unauthenticated request to an arbitrary
 * `/api/*` route is rejected with 401, while a hook callback bearing a valid
 * per-session token is accepted — proving the exception is exactly scoped.
 */
import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server.js';
import type { AuthGuardDeps } from './middleware.js';
import type { HookRouteService } from '../hooks/routes.js';
import type { HandleHookInput, HookCallbackAck } from '../hooks/endpoint.js';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

/**
 * The surface guard only needs the `getUserBySession` seam (the same shape the
 * full AuthService satisfies). With no users, every cookie resolves to null.
 */
const denyAllAuth: AuthGuardDeps = {
  getUserBySession: async () => null,
};

/** A hook service that accepts any non-empty token (real verify lives in US-15). */
const hookService: HookRouteService = {
  handle: async (input: HandleHookInput): Promise<HookCallbackAck> => {
    if (!input.token) throw new Error('unreachable: route rejects null token');
    return { ok: true };
  },
};

describe('US-39 surface auth (server-level)', () => {
  const app: FastifyInstance = buildServer({
    surfaceAuth: denyAllAuth,
    hookEndpoint: hookService,
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated API request with 401 (default-deny)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown API path with 401 before route resolution', async () => {
    // Even a route nobody registered must not leak existence to an anon caller.
    const res = await app.inject({ method: 'GET', url: '/api/anything/at/all' });
    expect(res.statusCode).toBe(401);
  });

  it('still serves the public health check without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('still allows POST /api/auth/login without a cookie', async () => {
    // No auth service wired here, so the route 404s — but crucially it is NOT
    // 401'd by the surface guard (proving login stays reachable to anon users).
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(res.statusCode).not.toBe(401);
  });

  it('accepts the hook endpoint with a valid per-session token (the exception)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/hooks/${VALID_ID}`,
      headers: { authorization: 'Bearer per-session-token' },
      payload: { event: 'Stop' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects the hook endpoint when the per-session token is missing (401, not cookie-gated)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/hooks/${VALID_ID}`,
      payload: { event: 'Stop' },
    });
    // 401 from the hook route's OWN token check, never from the cookie guard.
    expect(res.statusCode).toBe(401);
  });
});
