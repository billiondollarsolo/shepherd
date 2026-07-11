import { describe, expect, it } from 'vitest';
import { mergeAgentMeta } from './telemetry-cache.js';

describe('mergeAgentMeta', () => {
  it('retains omitted values and replaces fresh telemetry', () => {
    const merged = mergeAgentMeta(
      { model: 'claude-sonnet-4', tokens: 10, tool: 'Read', contextTokens: 5 },
      { tokens: 20, tool: 'Edit' },
    );
    expect(merged).toMatchObject({
      model: 'claude-sonnet-4',
      tokens: 20,
      tool: 'Edit',
      contextTokens: 5,
    });
  });
});
