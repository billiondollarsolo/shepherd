/**
 * US-22 — Web Push subscription store (spec §6 push_subscriptions, §8.1).
 *
 * Persists the W3C `PushSubscription`s registered by the web client so the push
 * service can fan a notification out to every device a user owns. This is the
 * DURABLE side of US-22 (`POST /api/push/subscribe` writes here); it is NOT on
 * the live status path — push delivery itself is scheduled off the hot path by
 * the push service (NFR-PERF1).
 *
 * The store is defined as an interface (the seam) plus a Drizzle-backed
 * implementation, mirroring the events/drizzle-event-writer.ts convention:
 * pure-logic consumers (the push service, the routes) depend on the interface so
 * they unit-test against an in-memory fake, while production wires the Drizzle
 * implementation over the existing `push_subscriptions` table.
 */
import { and, eq } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { pushSubscriptions, type NewPushSubscriptionRow } from '../db/schema.js';

/**
 * A stored Web Push subscription — the fields the VAPID sender needs, plus the
 * owning user. Column-aligned with the `push_subscriptions` table.
 */
export interface StoredPushSubscription {
  readonly userId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/**
 * Persistence seam for push subscriptions. Implementations must be idempotent on
 * `save` (re-subscribing the same endpoint updates, never duplicates) and on
 * `remove` (deleting an absent endpoint is a no-op) — browsers re-issue the same
 * endpoint and expect upsert semantics.
 */
export interface PushSubscriptionStore {
  /** Upsert a subscription by its (unique) endpoint. */
  save(sub: StoredPushSubscription): Promise<void>;
  /** Remove a subscription by endpoint (unsubscribe / pruned dead endpoint). */
  removeByEndpoint(endpoint: string): Promise<void>;
  /** All subscriptions for a user (push fan-out targets). */
  listByUser(userId: string): Promise<StoredPushSubscription[]>;
  /** Every subscription (used when a transition must notify all operators). */
  listAll(): Promise<StoredPushSubscription[]>;
}

/** A Drizzle-backed {@link PushSubscriptionStore} over `push_subscriptions`. */
export class DrizzlePushSubscriptionStore implements PushSubscriptionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async save(sub: StoredPushSubscription): Promise<void> {
    const row: NewPushSubscriptionRow = {
      userId: sub.userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
    };
    // The `endpoint` column is UNIQUE: on conflict, refresh the keys + owner so
    // a browser re-subscribing the same endpoint updates rather than 23505s.
    await this.db
      .insert(pushSubscriptions)
      .values(row)
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: sub.userId,
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
      });
  }

  async removeByEndpoint(endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, endpoint));
  }

  async listByUser(userId: string): Promise<StoredPushSubscription[]> {
    const rows = await this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    return rows.map(toStored);
  }

  async listAll(): Promise<StoredPushSubscription[]> {
    const rows = await this.db.select().from(pushSubscriptions);
    return rows.map(toStored);
  }

  /** Remove a single (userId, endpoint) pair — used by tests/ownership checks. */
  async removeOwned(userId: string, endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          eq(pushSubscriptions.endpoint, endpoint),
        ),
      );
  }
}

function toStored(row: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}): StoredPushSubscription {
  return {
    userId: row.userId,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
  };
}

/**
 * A simple in-memory {@link PushSubscriptionStore} keyed by endpoint. Useful for
 * unit tests and a DB-less dev mode; production uses
 * {@link DrizzlePushSubscriptionStore}.
 */
export class InMemoryPushSubscriptionStore implements PushSubscriptionStore {
  private readonly byEndpoint = new Map<string, StoredPushSubscription>();

  async save(sub: StoredPushSubscription): Promise<void> {
    this.byEndpoint.set(sub.endpoint, { ...sub });
  }

  async removeByEndpoint(endpoint: string): Promise<void> {
    this.byEndpoint.delete(endpoint);
  }

  async listByUser(userId: string): Promise<StoredPushSubscription[]> {
    return [...this.byEndpoint.values()].filter((s) => s.userId === userId);
  }

  async listAll(): Promise<StoredPushSubscription[]> {
    return [...this.byEndpoint.values()];
  }
}
