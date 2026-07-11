import { describe, expect, it } from 'vitest';
import { BoundedTtlMap } from './bounded-ttl-map';

describe('BoundedTtlMap', () => {
  it('evicts the oldest insertion at its maximum', () => {
    const cache = new BoundedTtlMap<string, number>(2, 1_000, () => 0);
    cache.set('a', 1).set('b', 2).set('c', 3);
    expect(cache.entries()).toEqual([
      ['b', 2],
      ['c', 3],
    ]);
  });

  it('expires values deterministically under high churn', () => {
    let now = 0;
    const cache = new BoundedTtlMap<number, number>(100, 10, () => now);
    for (let i = 0; i < 10_000; i++) cache.set(i, i);
    expect(cache.size).toBe(100);
    now = 10;
    expect(cache.size).toBe(0);
  });
});
