import { describe, expect, it } from 'vitest';
import { reconnectDelay } from './utils';

describe('shared reconnect policy', () => {
  it('uses deterministic bounded exponential backoff with injected jitter', () => {
    expect(reconnectDelay(0, 100, 500, () => 0)).toBe(80);
    expect(reconnectDelay(1, 100, 500, () => 0.5)).toBe(200);
    expect(reconnectDelay(20, 100, 500, () => 1)).toBe(600);
  });
});
