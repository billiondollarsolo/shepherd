import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCREENCAST_BANDWIDTH_CONTROLS,
  ScreencastBandwidthControls,
  ScreencastBandwidthControlMessage,
  ScreencastBandwidthSettings,
  parseScreencastBandwidthControlMessage,
  SCREENCAST_QUALITY_MAX,
  SCREENCAST_QUALITY_MIN,
} from './screencast-controls.js';

/**
 * US-29 — Screencast bandwidth controls contract (NFR-PERF3, all four controls).
 * The shared shapes both apps import; pinned here so a divergence fails the gate.
 */

const SID = '11111111-1111-4111-8111-111111111111';

describe('ScreencastBandwidthControls (US-29)', () => {
  it('parses an empty object into the four-control defaults', () => {
    const c = ScreencastBandwidthControls.parse({});
    expect(c).toEqual(DEFAULT_SCREENCAST_BANDWIDTH_CONTROLS);
    // All four controls are represented.
    expect(c.maxConcurrentStreams).toBeGreaterThanOrEqual(1); // #1 cap
    expect(c.unfocusedPolicy).toBe('pause'); // #2 throttle/pause unfocused
    expect(c.quality).toBeGreaterThanOrEqual(SCREENCAST_QUALITY_MIN); // #3 quality
    expect(c.quality).toBeLessThanOrEqual(SCREENCAST_QUALITY_MAX);
  });

  it('rejects an out-of-range quality', () => {
    expect(() => ScreencastBandwidthControls.parse({ quality: 0 })).toThrow();
    expect(() => ScreencastBandwidthControls.parse({ quality: 101 })).toThrow();
  });

  it('rejects a zero/negative concurrency cap', () => {
    expect(() => ScreencastBandwidthControls.parse({ maxConcurrentStreams: 0 })).toThrow();
  });

  it('rejects unknown keys (strict contract)', () => {
    expect(() => ScreencastBandwidthControls.parse({ bogus: true })).toThrow();
  });

  it('accepts a throttle policy with reduced unfocused quality + frame skip', () => {
    const c = ScreencastBandwidthControls.parse({
      unfocusedPolicy: 'throttle',
      unfocusedQuality: 15,
      unfocusedEveryNthFrame: 12,
    });
    expect(c.unfocusedPolicy).toBe('throttle');
    expect(c.unfocusedQuality).toBe(15);
    expect(c.unfocusedEveryNthFrame).toBe(12);
  });
});

describe('ScreencastBandwidthSettings (user-adjustable slice)', () => {
  it('is partial and omits the server-side concurrency cap', () => {
    const s = ScreencastBandwidthSettings.parse({ quality: 30 });
    expect(s.quality).toBe(30);
    // Cap is not user-settable through the settings slice.
    expect('maxConcurrentStreams' in s).toBe(false);
    expect(() =>
      // @ts-expect-error — cap is intentionally not part of the settings slice
      ScreencastBandwidthSettings.parse({ maxConcurrentStreams: 9 }),
    ).toThrow();
  });
});

describe('ScreencastBandwidthControlMessage', () => {
  it('round-trips a quality control message', () => {
    const msg = parseScreencastBandwidthControlMessage({
      channel: 'screencast',
      action: 'quality',
      sessionId: SID,
      quality: 25,
    });
    expect(msg.action).toBe('quality');
    if (msg.action === 'quality') expect(msg.quality).toBe(25);
  });

  it('accepts focus/blur/start/stop actions', () => {
    for (const action of ['start', 'stop', 'focus', 'blur'] as const) {
      const msg = ScreencastBandwidthControlMessage.parse({
        channel: 'screencast',
        action,
        sessionId: SID,
      });
      expect(msg.action).toBe(action);
    }
  });

  it('rejects a quality message without a quality field', () => {
    expect(() =>
      parseScreencastBandwidthControlMessage({
        channel: 'screencast',
        action: 'quality',
        sessionId: SID,
      }),
    ).toThrow();
  });

  it('rejects an unknown action', () => {
    expect(() =>
      parseScreencastBandwidthControlMessage({
        channel: 'screencast',
        action: 'explode',
        sessionId: SID,
      }),
    ).toThrow();
  });
});
