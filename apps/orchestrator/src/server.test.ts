import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from './server.js';
import { RequestBudget } from './http/request-budget.js';
import { SESSION_COOKIE } from './auth/cookie.js';

describe('orchestrator health route', () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok and the shared StatusEnum values', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('flock-orchestrator');
    // Confirms @flock/shared is the single source of truth, imported here.
    expect(body.statuses).toContain('awaiting_input');
    expect(body.statuses).toContain('disconnected');
  });
});

describe('global HTTP abuse bounds', () => {
  it('rate-limits every route and releases concurrency after responses', async () => {
    const budget = new RequestBudget({
      maxRequests: 1,
      windowMs: 60_000,
      maxConcurrent: 1,
      maxConcurrentPerKey: 1,
    });
    const app = buildServer({ requestBudget: budget });
    try {
      expect((await app.inject('/health')).statusCode).toBe(200);
      expect(budget.snapshot().active).toBe(0);
      const blocked = await app.inject('/health');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      expect(blocked.json().error.code).toBe('too_many_requests');
    } finally {
      await app.close();
    }
  });

  it('returns the shared error envelope for oversized bodies', async () => {
    const app = buildServer({
      hookEndpoint: {
        handle: async () => ({ ok: true }),
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/hooks/11111111-1111-4111-8111-111111111111',
        headers: { authorization: 'Bearer token' },
        payload: { output: 'x'.repeat(300 * 1024) },
      });
      expect(response.statusCode).toBe(413);
      expect(response.json().error.code).toBe('payload_too_large');
    } finally {
      await app.close();
    }
  });
});

describe('orchestrator readiness route (T15)', () => {
  it('GET /ready returns 200 when the readiness check passes', async () => {
    const app = buildServer({ readiness: async () => true });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
    await app.close();
  });

  it('GET /ready returns 503 when the dependency is down', async () => {
    const app = buildServer({ readiness: async () => false });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('unavailable');
    await app.close();
  });

  it('GET /ready returns 503 when the readiness check throws', async () => {
    const app = buildServer({
      readiness: async () => {
        throw new Error('db unreachable');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('authenticated diagnostics bundle', () => {
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'owner',
    createdAt: new Date(0).toISOString(),
    lastLoginAt: null,
    isActive: true,
  } as never;

  it('rejects anonymous requests and downloads the redacted snapshot for the owner', async () => {
    const app = buildServer({
      surfaceAuth: { getUserBySession: async (id) => (id === 'valid' ? user : null) },
      diagnostics: async () => ({
        bundleVersion: 1,
        privacy: { excluded: 'tokens and PTY content' },
      }),
    });
    try {
      expect((await app.inject('/api/diagnostics')).statusCode).toBe(401);
      const response = await app.inject({
        url: '/api/diagnostics/bundle',
        headers: { cookie: `${SESSION_COOKIE}=valid` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('flock-diagnostics-');
      expect(response.json().bundleVersion).toBe(1);
    } finally {
      await app.close();
    }
  });
});
