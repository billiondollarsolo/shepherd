/**
 * US-22 — push subscription store contract (spec §6 push_subscriptions).
 *
 * These pin the persistence semantics the routes + push service rely on:
 *   - save() stores a subscription and is idempotent by endpoint (re-subscribe
 *     updates the keys/owner, never duplicates) — browsers re-issue endpoints;
 *   - removeByEndpoint() deletes by endpoint and no-ops on an absent one;
 *   - listByUser() / listAll() return the right fan-out targets.
 *
 * They run against the InMemory implementation (the DB-backed one is covered by
 * an integration test against real Postgres); both honor the same interface so
 * the routes/service can be wired to either.
 */
import { describe, expect, it } from 'vitest';

import {
  InMemoryPushSubscriptionStore,
  type StoredPushSubscription,
} from './subscription-store.js';

function sub(over: Partial<StoredPushSubscription> = {}): StoredPushSubscription {
  return {
    userId: 'u1',
    endpoint: 'https://push.example/aaa',
    p256dh: 'key-p',
    auth: 'key-a',
    ...over,
  };
}

describe('InMemoryPushSubscriptionStore', () => {
  it('saves a subscription and lists it by user', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(sub());

    expect(await store.listByUser('u1')).toEqual([sub()]);
    expect(await store.listAll()).toHaveLength(1);
  });

  it('is idempotent by endpoint: re-saving updates the keys, never duplicates', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(sub({ p256dh: 'old' }));
    await store.save(sub({ p256dh: 'new' }));

    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.p256dh).toBe('new');
  });

  it('removes a subscription by endpoint and no-ops on an absent one', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(sub());

    await store.removeByEndpoint('https://push.example/aaa');
    expect(await store.listAll()).toHaveLength(0);

    // Absent endpoint: must not throw.
    await expect(store.removeByEndpoint('nope')).resolves.toBeUndefined();
  });

  it('lists only the requested user’s subscriptions', async () => {
    const store = new InMemoryPushSubscriptionStore();
    await store.save(sub({ userId: 'u1', endpoint: 'https://push.example/1' }));
    await store.save(sub({ userId: 'u2', endpoint: 'https://push.example/2' }));

    const u1 = await store.listByUser('u1');
    expect(u1).toHaveLength(1);
    expect(u1[0]!.endpoint).toBe('https://push.example/1');
  });
});
