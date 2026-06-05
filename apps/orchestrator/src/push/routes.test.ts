/**
 * US-22 — push subscription route HTTP mapping (spec §8.1).
 *
 * Exercised over a real in-process Fastify instance with injected fakes:
 *   - POST /api/push/subscribe stores the subscription for the authed user (201)
 *   - DELETE /api/push/subscribe removes it by endpoint (200)
 *   - both reject unauthenticated requests (401) and never touch the store
 *   - a malformed body is rejected (400)
 *   - GET /api/push/vapid-public-key returns the configured key
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerPushRoutes, type ResolveUserId } from './routes.js';
import { InMemoryPushSubscriptionStore } from './subscription-store.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const okAuth: ResolveUserId = async () => 'user-1';
// An unauthenticated request: the resolver returns null (route maps it to 401).
const denyAuth: ResolveUserId = async () => null;

function buildApp(opts: {
  store: InMemoryPushSubscriptionStore;
  resolveUserId: ResolveUserId;
  vapidPublicKey?: string;
}): FastifyInstance {
  app = Fastify();
  registerPushRoutes(app, opts);
  return app;
}

const VALID_SUB = {
  endpoint: 'https://push.example/aaa',
  keys: { p256dh: 'p-key', auth: 'a-key' },
};

describe('registerPushRoutes — POST /api/push/subscribe', () => {
  it('stores the subscription for the authed user and returns 201 { ok: true }', async () => {
    const store = new InMemoryPushSubscriptionStore();
    const built = buildApp({ store, resolveUserId: okAuth });

    const res = await built.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: VALID_SUB,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });

    const stored = await store.listByUser('user-1');
    expect(stored).toEqual([
      {
        userId: 'user-1',
        endpoint: 'https://push.example/aaa',
        p256dh: 'p-key',
        auth: 'a-key',
      },
    ]);
  });

  it('rejects an unauthenticated request with 401 and stores nothing', async () => {
    const store = new InMemoryPushSubscriptionStore();
    const built = buildApp({ store, resolveUserId: denyAuth });

    const res = await built.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: VALID_SUB,
    });

    expect(res.statusCode).toBe(401);
    expect(await store.listAll()).toHaveLength(0);
  });

  it('rejects a malformed subscription body with 400', async () => {
    const store = new InMemoryPushSubscriptionStore();
    const built = buildApp({ store, resolveUserId: okAuth });

    const res = await built.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: { endpoint: 'not-a-url' },
    });

    expect(res.statusCode).toBe(400);
    expect(await store.listAll()).toHaveLength(0);
  });
});

describe('registerPushRoutes — DELETE /api/push/subscribe', () => {
  it('removes the subscription by endpoint', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save({
      userId: 'user-1',
      endpoint: 'https://push.example/aaa',
      p256dh: 'p',
      auth: 'a',
    });
    const built = buildApp({ store, resolveUserId: okAuth });

    const res = await built.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      payload: { endpoint: 'https://push.example/aaa' },
    });

    expect(res.statusCode).toBe(200);
    expect(await store.listAll()).toHaveLength(0);
  });

  it('rejects an unauthenticated unsubscribe with 401', async () => {
    const store = new InMemoryPushSubscriptionStore();
    const built = buildApp({ store, resolveUserId: denyAuth });

    const res = await built.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      payload: { endpoint: 'https://push.example/aaa' },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe('registerPushRoutes — GET /api/push/vapid-public-key', () => {
  it('returns the configured VAPID public key for an authed user', async () => {
    const store = new InMemoryPushSubscriptionStore();
    const built = buildApp({
      store,
      resolveUserId: okAuth,
      vapidPublicKey: 'BPublicKey123',
    });

    const res = await built.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ publicKey: 'BPublicKey123' });
  });
});
