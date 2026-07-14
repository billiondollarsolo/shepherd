import { and, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { authLoginThrottle } from '../db/schema.js';
import {
  loginThrottleKey,
  type LoginThrottleLike,
  type ThrottleDecision,
} from './login-throttle.js';

export interface PersistentLoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  lockoutMs?: number;
  idleTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * PostgreSQL-backed login throttle. A process restart or rolling upgrade cannot
 * reset a public attacker's failure counter, and a bounded pruning pass keeps
 * attacker-controlled key cardinality finite.
 */
export class PersistentLoginThrottle implements LoginThrottleLike {
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly idleTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private nextPruneAt = 0;

  constructor(
    private readonly db: Database,
    options: PersistentLoginThrottleOptions = {},
  ) {
    this.maxFailures = options.maxFailures ?? 8;
    this.windowMs = options.windowMs ?? 5 * 60_000;
    this.lockoutMs = options.lockoutMs ?? 15 * 60_000;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60_000;
    this.maxEntries = options.maxEntries ?? 50_000;
    this.now = options.now ?? Date.now;
    if (
      this.maxFailures <= 0 ||
      this.windowMs <= 0 ||
      this.lockoutMs <= 0 ||
      this.idleTtlMs <= 0 ||
      this.maxEntries <= 0
    ) {
      throw new Error('Persistent login-throttle limits must be positive');
    }
  }

  static key(ip: string | null | undefined, username: string): string {
    return loginThrottleKey(ip, username);
  }

  async check(key: string): Promise<ThrottleDecision> {
    await this.pruneIfDue();
    const now = new Date(this.now());
    const [row] = await this.db
      .select({ lockedUntil: authLoginThrottle.lockedUntil })
      .from(authLoginThrottle)
      .where(eq(authLoginThrottle.keyHash, key))
      .limit(1);
    const retryAfterMs = row?.lockedUntil ? row.lockedUntil.getTime() - now.getTime() : 0;
    return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true, retryAfterMs: 0 };
  }

  async recordFailure(key: string): Promise<void> {
    await this.pruneIfDue();
    const nowMs = this.now();
    const now = new Date(nowMs);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(authLoginThrottle)
        .values({
          keyHash: key,
          failures: 0,
          firstFailureAt: now,
          lastSeenAt: now,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(authLoginThrottle)
        .where(eq(authLoginThrottle.keyHash, key))
        .for('update')
        .limit(1);
      if (!row) throw new Error('login throttle row disappeared during update');
      const reset = nowMs - row.firstFailureAt.getTime() > this.windowMs;
      const failures = reset ? 1 : row.failures + 1;
      const firstFailureAt = reset ? now : row.firstFailureAt;
      const lockedUntil = failures >= this.maxFailures ? new Date(nowMs + this.lockoutMs) : null;
      await tx
        .update(authLoginThrottle)
        .set({ failures, firstFailureAt, lockedUntil, lastSeenAt: now })
        .where(eq(authLoginThrottle.keyHash, key));
    });
  }

  async recordSuccess(key: string): Promise<void> {
    await this.db.delete(authLoginThrottle).where(eq(authLoginThrottle.keyHash, key));
  }

  private async pruneIfDue(): Promise<void> {
    const nowMs = this.now();
    if (nowMs < this.nextPruneAt) return;
    this.nextPruneAt = nowMs + 60_000;
    const now = new Date(nowMs);
    await this.db
      .delete(authLoginThrottle)
      .where(
        and(
          lt(authLoginThrottle.lastSeenAt, new Date(nowMs - this.idleTtlMs)),
          or(isNull(authLoginThrottle.lockedUntil), lte(authLoginThrottle.lockedUntil, now)),
        ),
      );
    await this.db.execute(sql`
      DELETE FROM auth_login_throttle
      WHERE key_hash IN (
        SELECT key_hash FROM auth_login_throttle
        ORDER BY last_seen_at DESC
        OFFSET ${this.maxEntries}
      )
    `);
  }
}
