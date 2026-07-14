import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRequestOriginGuard } from './request-origin.js';

describe('request Origin guard', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  function app() {
    const instance = Fastify();
    apps.push(instance);
    instance.addHook(
      'onRequest',
      makeRequestOriginGuard(new Set(['https://shepherd.example', 'http://100.64.0.10:11010'])),
    );
    instance.get('/api/value', async () => ({ ok: true }));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      instance.route({ method, url: '/api/value', handler: async () => ({ ok: true }) });
    }
    instance.post('/api/hooks/session', async () => ({ ok: true }));
    instance.post('/api/orchestrate/session/send', async () => ({ ok: true }));
    return instance;
  }

  it('allows safe methods without Origin', async () => {
    expect((await app().inject({ method: 'GET', url: '/api/value' })).statusCode).toBe(200);
  });

  it('requires an exact configured Origin for unsafe control-plane methods', async () => {
    const instance = app();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await instance.inject({ method, url: '/api/value' })).statusCode).toBe(403);
    }
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/api/value',
          headers: { origin: 'http://100.64.0.10:12001' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/api/value',
          headers: { origin: 'http://100.64.0.10:11010' },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('keeps capability-authenticated routes outside cookie Origin policy', async () => {
    const instance = app();
    expect((await instance.inject({ method: 'POST', url: '/api/hooks/session' })).statusCode).toBe(
      200,
    );
    expect(
      (await instance.inject({ method: 'POST', url: '/api/orchestrate/session/send' })).statusCode,
    ).toBe(200);
  });
});
