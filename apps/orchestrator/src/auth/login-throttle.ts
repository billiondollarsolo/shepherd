import { createHash } from 'node:crypto';

/**
 * Login throttle (T6) — in-memory per-key failure counter + lockout to blunt
 * online brute-force / credential-stuffing against `/api/auth/login` (and setup).
 * No dependency, no DB: a Map keyed by `ip|username`. argon2id already makes each
 * guess slow; this caps the number of guesses.
 *
 * Policy: after MAX_FAILURES failures within WINDOW_MS, the key is locked for
 * LOCKOUT_MS. A success clears the key. Designed to be conservative (it never
 * blocks a legitimate user who knows their password, since success resets).
 */
export interface ThrottleDecision {
  allowed: boolean;
  /** ms until the caller may retry, when not allowed. */
  retryAfterMs: number;
}

export interface LoginThrottleLike {
  check(key: string): ThrottleDecision | Promise<ThrottleDecision>;
  recordFailure(key: string): void | Promise<void>;
  recordSuccess(key: string): void | Promise<void>;
}

/** Privacy-preserving key shared by the memory and durable implementations. */
export function loginThrottleKey(ip: string | null | undefined, username: string): string {
  return createHash('sha256')
    .update(`${ip ?? 'unknown'}\0${username.trim().toLowerCase()}`)
    .digest('hex');
}

export interface LoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  lockoutMs?: number;
  maxEntries?: number;
  idleTtlMs?: number;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
}

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
  lastSeenAt: number;
}

export class LoginThrottle implements LoginThrottleLike {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;
  private nextPruneAt = 0;

  constructor(opts: LoginThrottleOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 8;
    this.windowMs = opts.windowMs ?? 5 * 60_000; // 5 min window
    this.lockoutMs = opts.lockoutMs ?? 15 * 60_000; // 15 min lockout
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? 5_000;
    this.idleTtlMs = opts.idleTtlMs ?? Math.max(this.windowMs, this.lockoutMs) * 2;
    if (this.maxEntries <= 0 || this.idleTtlMs <= 0) {
      throw new Error('maxEntries and idleTtlMs must be positive');
    }
  }

  private prune(t: number, force = false): void {
    if (!force && t < this.nextPruneAt) return;
    this.nextPruneAt = t + Math.max(1_000, Math.min(this.windowMs, this.idleTtlMs) / 4);
    for (const [key, entry] of this.entries) {
      if (t - entry.lastSeenAt >= this.idleTtlMs && entry.lockedUntil <= t) {
        this.entries.delete(key);
      }
    }
  }

  private makeRoom(): void {
    if (this.entries.size < this.maxEntries) return;
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.lastSeenAt < oldestAt) {
        oldestKey = key;
        oldestAt = entry.lastSeenAt;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }

  /** Build the throttle key from the request ip + attempted username. */
  static key(ip: string | null | undefined, username: string): string {
    return loginThrottleKey(ip, username);
  }

  /** Whether this key may attempt a login now. */
  check(key: string): ThrottleDecision {
    const t = this.now();
    this.prune(t);
    const e = this.entries.get(key);
    if (e && e.lockedUntil > t) {
      e.lastSeenAt = t;
      return { allowed: false, retryAfterMs: e.lockedUntil - t };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Record a failed attempt; locks the key once the threshold is crossed. */
  recordFailure(key: string): void {
    const t = this.now();
    this.prune(t);
    let e = this.entries.get(key);
    if (!e || t - e.firstFailureAt > this.windowMs) {
      if (!e) this.makeRoom();
      e = { failures: 0, firstFailureAt: t, lockedUntil: 0, lastSeenAt: t };
      this.entries.set(key, e);
    }
    e.lastSeenAt = t;
    e.failures += 1;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = t + this.lockoutMs;
    }
  }

  /** Clear a key after a successful login. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Bounded diagnostic count; never exposes keys or attempted usernames. */
  get trackedEntries(): number {
    this.prune(this.now(), true);
    return this.entries.size;
  }
}
