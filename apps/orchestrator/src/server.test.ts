import { describe, it, expect, afterAll } from 'vitest';
import { buildServer } from './server.js';

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
