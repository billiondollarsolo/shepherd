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

export interface LoginThrottleOptions {
  maxFailures?: number;
  windowMs?: number;
  lockoutMs?: number;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
}

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;

  constructor(opts: LoginThrottleOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 8;
    this.windowMs = opts.windowMs ?? 5 * 60_000; // 5 min window
    this.lockoutMs = opts.lockoutMs ?? 15 * 60_000; // 15 min lockout
    this.now = opts.now ?? Date.now;
  }

  /** Build the throttle key from the request ip + attempted username. */
  static key(ip: string | null | undefined, username: string): string {
    return `${ip ?? 'unknown'}|${username.toLowerCase()}`;
  }

  /** Whether this key may attempt a login now. */
  check(key: string): ThrottleDecision {
    const e = this.entries.get(key);
    const t = this.now();
    if (e && e.lockedUntil > t) {
      return { allowed: false, retryAfterMs: e.lockedUntil - t };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Record a failed attempt; locks the key once the threshold is crossed. */
  recordFailure(key: string): void {
    const t = this.now();
    let e = this.entries.get(key);
    if (!e || t - e.firstFailureAt > this.windowMs) {
      e = { failures: 0, firstFailureAt: t, lockedUntil: 0 };
      this.entries.set(key, e);
    }
    e.failures += 1;
    if (e.failures >= this.maxFailures) {
      e.lockedUntil = t + this.lockoutMs;
    }
  }

  /** Clear a key after a successful login. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }
}
