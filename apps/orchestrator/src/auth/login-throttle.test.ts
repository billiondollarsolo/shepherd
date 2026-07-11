import { describe, it, expect } from 'vitest';
import { LoginThrottle } from './login-throttle.js';

describe('LoginThrottle (T6)', () => {
  it('allows until the failure threshold, then locks out', () => {
    const now = 1_000;
    const t = new LoginThrottle({
      maxFailures: 3,
      windowMs: 60_000,
      lockoutMs: 10_000,
      now: () => now,
    });
    const k = LoginThrottle.key('1.2.3.4', 'admin');

    expect(t.check(k).allowed).toBe(true);
    t.recordFailure(k); // 1
    t.recordFailure(k); // 2
    expect(t.check(k).allowed).toBe(true); // not yet locked
    t.recordFailure(k); // 3 → locked
    const d = t.check(k);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBeGreaterThan(0);
  });

  it('unlocks after the lockout window elapses', () => {
    let now = 0;
    const t = new LoginThrottle({
      maxFailures: 1,
      windowMs: 60_000,
      lockoutMs: 5_000,
      now: () => now,
    });
    const k = LoginThrottle.key('ip', 'u');
    t.recordFailure(k); // locks immediately (max=1)
    expect(t.check(k).allowed).toBe(false);
    now += 5_001;
    expect(t.check(k).allowed).toBe(true);
  });

  it('a success clears the counter', () => {
    const now = 0;
    const t = new LoginThrottle({ maxFailures: 2, now: () => now });
    const k = LoginThrottle.key('ip', 'u');
    t.recordFailure(k);
    t.recordSuccess(k);
    t.recordFailure(k); // back to 1, not locked
    expect(t.check(k).allowed).toBe(true);
  });

  it('keys by ip AND username (independent counters)', () => {
    const t = new LoginThrottle({ maxFailures: 1, lockoutMs: 1000 });
    t.recordFailure(LoginThrottle.key('ipA', 'u'));
    expect(t.check(LoginThrottle.key('ipA', 'u')).allowed).toBe(false);
    expect(t.check(LoginThrottle.key('ipB', 'u')).allowed).toBe(true);
  });

  it('bounds unique failed keys and evicts idle entries', () => {
    let now = 0;
    const t = new LoginThrottle({
      maxEntries: 3,
      idleTtlMs: 100,
      windowMs: 50,
      lockoutMs: 50,
      now: () => now,
    });
    for (let i = 0; i < 20; i += 1) {
      t.recordFailure(LoginThrottle.key(`ip-${i}`, 'owner'));
      now += 1;
    }
    expect(t.trackedEntries).toBeLessThanOrEqual(3);
    now += 101;
    expect(t.trackedEntries).toBe(0);
  });
});
