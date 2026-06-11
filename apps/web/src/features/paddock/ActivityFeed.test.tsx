import { describe, expect, it } from 'vitest';
import { timeAgo } from './ActivityFeed';

describe('timeAgo', () => {
  const now = Date.parse('2026-06-10T12:00:00.000Z');
  it('formats recent → coarse buckets', () => {
    expect(timeAgo('2026-06-10T11:59:40.000Z', now)).toBe('now'); // 20s
    expect(timeAgo('2026-06-10T11:57:00.000Z', now)).toBe('3m');
    expect(timeAgo('2026-06-10T10:00:00.000Z', now)).toBe('2h');
    expect(timeAgo('2026-06-06T12:00:00.000Z', now)).toBe('4d');
  });
  it('never goes negative for a future ts', () => {
    expect(timeAgo('2026-06-10T12:05:00.000Z', now)).toBe('now');
  });
});
