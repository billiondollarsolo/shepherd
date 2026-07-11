/**
 * US-22 — Drizzle push subscription store, integration (real Postgres).
 *
 * Runs under `pnpm test:int` (dockerized Postgres via DATABASE_URL). Verifies the
 * store against the actual `push_subscriptions` table:
 *   - save() inserts a row and listByUser/listAll read it back;
 *   - save() is idempotent by the UNIQUE endpoint (re-subscribe updates keys);
 *   - removeByEndpoint() deletes it.
 *
 * A user + node + project are NOT required (push_subscriptions only FKs users),
 * so we seed a single user and clean up after ourselves.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../db/client.js';
import { pushSubscriptions } from '../db/schema.js';
import { eq } from 'drizzle-orm';

import { DrizzlePushSubscriptionStore } from './subscription-store.js';
import { ensureIntegrationOwner } from '../../test/integration-owner.js';

let handle: DbHandle;
let store: DrizzlePushSubscriptionStore;
let userId: string;

beforeAll(async () => {
  handle = createDb();
  store = new DrizzlePushSubscriptionStore(handle.db);

  userId = (await ensureIntegrationOwner(handle.db, `push-it-${randomUUID().slice(0, 8)}`)).id;
});

afterAll(async () => {
  if (handle) {
    await handle.db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    await handle.pool.end();
  }
});

describe('DrizzlePushSubscriptionStore (integration)', () => {
  it('saves, lists, upserts idempotently, and removes', async () => {
    const endpoint = `https://push.example/${randomUUID()}`;
    await store.save({ userId, endpoint, p256dh: 'p1', auth: 'a1' });

    let mine = await store.listByUser(userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ endpoint, p256dh: 'p1', auth: 'a1' });

    // Re-subscribe the SAME endpoint: idempotent upsert, not a duplicate.
    await store.save({ userId, endpoint, p256dh: 'p2', auth: 'a2' });
    mine = await store.listByUser(userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.p256dh).toBe('p2');

    await store.removeByEndpoint(endpoint);
    expect(await store.listByUser(userId)).toHaveLength(0);
  });
});
