import { describe, it, expect } from 'vitest';
import { lookupModel, contextPct, estimateCostUsd } from './model-info.js';

describe('model-info (T19)', () => {
  it('resolves by longest prefix; 1m variants get the larger window', () => {
    expect(lookupModel('claude-opus-4-8').contextLimit).toBe(200_000);
    expect(lookupModel('claude-opus-4-8[1m]').contextLimit).toBe(1_000_000);
    expect(lookupModel('claude-sonnet-4-6-20251101').contextLimit).toBe(200_000);
  });

  it('falls back to a conservative default for unknown models', () => {
    const info = lookupModel('some-future-model-x');
    expect(info.contextLimit).toBe(200_000);
    expect(info.inputPer1M).toBeGreaterThan(0);
  });

  it('contextPct is occupancy over the model limit, capped at 100', () => {
    expect(contextPct('claude-opus-4-8', 100_000)).toBe(50); // 100k / 200k
    expect(contextPct('claude-opus-4-8[1m]', 100_000)).toBe(10); // 100k / 1M
    expect(contextPct('claude-opus-4-8', 999_999)).toBe(100); // capped
    expect(contextPct('claude-opus-4-8', 0)).toBeUndefined();
    expect(contextPct('claude-opus-4-8', undefined)).toBeUndefined();
  });

  it('prefers an agent-reported context limit over the table (T60)', () => {
    // Codex reports model_context_window=258400 for gpt-5.5; use it exactly
    // instead of the table guess.
    expect(contextPct('gpt-5.5', 129200, 258400)).toBe(50);
    // A zero/absent reported limit falls back to the table.
    expect(contextPct('claude-opus-4-8', 100000, 0)).toBe(50);
  });

  it('estimateCostUsd applies a blended rate and rounds', () => {
    // opus 4.5+ blended = 5*0.8 + 25*0.2 = 9 $/1M → 1M tokens ≈ $9
    expect(estimateCostUsd('claude-opus-4-8', 1_000_000)).toBeCloseTo(9, 4);
    expect(estimateCostUsd('claude-opus-4-8', 0)).toBeUndefined();
    expect(estimateCostUsd('claude-opus-4-8', undefined)).toBeUndefined();
    // a cheaper model costs less for the same tokens
    expect(estimateCostUsd('claude-haiku-4-5', 1_000_000)!).toBeLessThan(
      estimateCostUsd('claude-opus-4-8', 1_000_000)!,
    );
  });
});
