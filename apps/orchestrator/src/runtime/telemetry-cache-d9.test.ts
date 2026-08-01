/**
 * D9 multi-hop (orchestrator half): after agentd JSON carries "unseenIdle":false,
 * mergeAgentMeta must clear a sticky previous true — not keep the badge.
 */
import { describe, expect, it } from 'vitest';

import { mergeAgentMeta } from './telemetry-cache.js';

describe('mergeAgentMeta D9 unseenIdle wire clear', () => {
  it('clears sticky true when incoming JSON field is explicit false', () => {
    // Simulate JSON.parse of agentd status frame after focus-clear.
    const wire = JSON.parse(
      JSON.stringify({ state: 'idle', unseenIdle: false }),
    ) as { state: string; unseenIdle?: boolean };

    expect(wire).toHaveProperty('unseenIdle', false);
    expect(typeof wire.unseenIdle).toBe('boolean');

    const merged = mergeAgentMeta(
      { unseenIdle: true, tokens: 1 },
      { unseenIdle: wire.unseenIdle },
    );
    expect(merged.unseenIdle).toBe(false);
  });

  it('keeps previous when wire omits unseenIdle (nil pointer path)', () => {
    const wire = JSON.parse(JSON.stringify({ state: 'running' })) as {
      unseenIdle?: boolean;
    };
    expect(wire.unseenIdle).toBeUndefined();
    const merged = mergeAgentMeta({ unseenIdle: true }, { ...wire });
    expect(merged.unseenIdle).toBe(true);
  });

  it('sets true when wire says true', () => {
    const merged = mergeAgentMeta({ unseenIdle: false }, { unseenIdle: true });
    expect(merged.unseenIdle).toBe(true);
  });
});
