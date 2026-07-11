import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { RequestBudget, makeRejectionReporter, withinRequestBudget } from './request-budget.js';

function budget(
  overrides: Partial<ConstructorParameters<typeof RequestBudget>[0]> = {},
): RequestBudget {
  return new RequestBudget({
    maxRequests: 2,
    windowMs: 1_000,
    maxConcurrent: 2,
    maxConcurrentPerKey: 1,
    ...overrides,
  });
}

describe('RequestBudget', () => {
  it('enforces a sliding-window rate and reports the retry delay', () => {
    let now = 100;
    const guard = budget({ now: () => now });
    const first = guard.enter('key');
    expect(first.allowed).toBe(true);
    if (first.allowed) first.release();
    const second = guard.enter('key');
    expect(second.allowed).toBe(true);
    if (second.allowed) second.release();
    const blocked = guard.enter('key');
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterMs).toBe(1_000);
    now += 1_001;
    const recovered = guard.enter('key');
    expect(recovered.allowed).toBe(true);
    if (recovered.allowed) recovered.release();
  });

  it('bounds per-key and global concurrency with idempotent release', () => {
    const guard = budget({ maxRequests: 100 });
    const a = guard.enter('a');
    expect(a.allowed).toBe(true);
    expect(guard.enter('a')).toMatchObject({ allowed: false, reason: 'concurrency' });
    const b = guard.enter('b');
    expect(b.allowed).toBe(true);
    expect(guard.enter('c')).toMatchObject({ allowed: false, reason: 'concurrency' });
    if (a.allowed) {
      a.release();
      a.release();
    }
    if (b.allowed) b.release();
    expect(guard.snapshot().active).toBe(0);
  });

  it('evicts idle and oldest inactive keys at a hard maximum', () => {
    let now = 0;
    const guard = budget({
      maxRequests: 100,
      maxKeys: 3,
      idleTtlMs: 100,
      now: () => now,
    });
    for (let i = 0; i < 10_000; i += 1) {
      const permit = guard.enter(`invalid-${i}`);
      if (permit.allowed) permit.release();
      now += 1;
    }
    expect(guard.snapshot().trackedKeys).toBeLessThanOrEqual(3);
    now += 2_000;
    expect(guard.snapshot().trackedKeys).toBe(0);
  });

  it('keeps the rate map bounded even when every retained key is active', () => {
    const guard = budget({
      maxRequests: 100,
      maxKeys: 2,
      maxConcurrent: 3,
      maxConcurrentPerKey: 1,
    });
    const permits = ['a', 'b', 'c'].map((key) => guard.enter(key));
    expect(permits.every((permit) => permit.allowed)).toBe(true);
    expect(guard.snapshot().trackedKeys).toBe(2);
    for (const permit of permits) if (permit.allowed) permit.release();
  });

  it('counts rejections without retaining credentials', () => {
    const onReject = vi.fn();
    const guard = budget({ maxRequests: 1, onReject });
    const permit = guard.enter('opaque-key');
    if (permit.allowed) permit.release();
    guard.enter('opaque-key');
    expect(onReject).toHaveBeenCalledWith('rate');
    expect(guard.snapshot()).toMatchObject({ rejectedRate: 1 });
  });
});

describe('withinRequestBudget', () => {
  it('returns a consistent 429 with Retry-After and releases after success', async () => {
    const app = Fastify();
    const guard = budget({ maxRequests: 1 });
    app.get('/limited', async (_request, reply) =>
      withinRequestBudget(reply, guard, 'key', async () => ({ ok: true })),
    );
    try {
      expect((await app.inject('/limited')).statusCode).toBe(200);
      const blocked = await app.inject('/limited');
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('1');
      expect(blocked.json().error.code).toBe('too_many_requests');
      expect(guard.snapshot().active).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe('makeRejectionReporter', () => {
  it('reports aggregate powers of two without accepting caller material', () => {
    const log = vi.fn();
    const report = makeRejectionReporter('hooks', log);
    report('rate');
    report('rate');
    report('rate');
    report('rate');
    expect(log.mock.calls.flat()).toEqual([
      '[abuse] scope=hooks reason=rate rejected=1',
      '[abuse] scope=hooks reason=rate rejected=2',
      '[abuse] scope=hooks reason=rate rejected=4',
    ]);
  });
});
