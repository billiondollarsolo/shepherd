import { describe, expect, it, vi } from 'vitest';
import { ScreencastConcurrencyError } from '../layerC/types.js';
import { BandwidthController } from './bandwidth-controller.js';
import { computeEffectiveParams } from './bandwidth-controller.js';
import type { ScreencastEngine } from './types.js';

/**
 * US-29 — Screencast bandwidth controls (NFR-PERF3, all four controls):
 *   1. cap concurrent active streams,
 *   2. throttle/PAUSE an unfocused pane,
 *   3. adjustable JPEG quality,
 *   4. on-demand only.
 *
 * The headline acceptance criterion is verified directly: a BACKGROUNDED session
 * stops consuming bandwidth — under the default `pause` policy a blurred pane
 * issues `stop` and forwards ZERO further frames.
 *
 * Driven against a fake engine (no real chrome / ws) so the controls logic is
 * pinned in isolation; the Layer C integration test wires the real manager.
 */

/** A fake screencast engine that records every command + tracks live state. */
function makeFakeEngine() {
  const live = new Set<string>();
  const calls: string[] = [];
  const quality = new Map<string, number>();
  const nth = new Map<string, number>();
  const engine: ScreencastEngine & {
    calls: string[];
    quality: Map<string, number>;
    nth: Map<string, number>;
  } = {
    calls,
    quality,
    nth,
    async start(id) {
      calls.push(`start:${id}`);
      live.add(id);
    },
    async stop(id) {
      const was = live.delete(id);
      if (was) calls.push(`stop:${id}`);
      return was;
    },
    isStreaming(id) {
      return live.has(id);
    },
    activeCount() {
      return live.size;
    },
    setQuality(id, q) {
      calls.push(`quality:${id}=${q}`);
      quality.set(id, q);
    },
    setEveryNthFrame(id, n) {
      calls.push(`nth:${id}=${n}`);
      nth.set(id, n);
    },
  };
  return engine;
}

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';

describe('BandwidthController — control #4: on-demand only', () => {
  it('does not start any stream until open() is called', () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({ engine });
    expect(engine.calls).toEqual([]);
    expect(ctrl.isStreaming(A)).toBe(false);
  });

  it('open() starts and close() stops the stream (tab open/switch)', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({ engine });

    await ctrl.open(A);
    expect(engine.isStreaming(A)).toBe(true);

    await ctrl.close(A);
    expect(engine.isStreaming(A)).toBe(false);
    expect(engine.calls).toContain('start:' + A);
    expect(engine.calls).toContain('stop:' + A);
  });
});

describe('BandwidthController — control #1: concurrent-stream cap', () => {
  it('rejects opening more than the cap of concurrent streams', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({
      engine,
      controls: { maxConcurrentStreams: 1 },
    });

    await ctrl.open(A);
    await expect(ctrl.open(B)).rejects.toBeInstanceOf(
      ScreencastConcurrencyError,
    );
    expect(engine.isStreaming(B)).toBe(false);
  });

  it('frees a slot when a stream closes', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({
      engine,
      controls: { maxConcurrentStreams: 1 },
    });
    await ctrl.open(A);
    await ctrl.close(A);
    await expect(ctrl.open(B)).resolves.toBeUndefined();
    expect(engine.isStreaming(B)).toBe(true);
  });
});

describe('BandwidthController — control #3: adjustable JPEG quality', () => {
  it('applies a clamped live quality to a streaming pane', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({ engine });
    await ctrl.open(A);

    ctrl.setQuality(A, 25);
    expect(engine.quality.get(A)).toBe(25);

    // Clamp out-of-range into [1,100].
    ctrl.setQuality(A, 999);
    expect(engine.quality.get(A)).toBe(100);
    ctrl.setQuality(A, -5);
    expect(engine.quality.get(A)).toBe(1);
  });
});

describe('BandwidthController — control #2: throttle/pause unfocused (NFR-PERF3)', () => {
  it('BACKGROUNDED session stops consuming bandwidth under the pause policy', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({
      engine,
      controls: { unfocusedPolicy: 'pause' },
    });

    await ctrl.open(A);
    ctrl.focus(A);
    expect(engine.isStreaming(A)).toBe(true);

    // The pane goes to the background (window/tab blurred).
    await ctrl.blur(A);

    // The headline NFR-PERF3 assertion: ZERO frames flow — the stream is paused.
    expect(engine.isStreaming(A)).toBe(false);
    expect(engine.calls).toContain('stop:' + A);
    expect(ctrl.isPaused(A)).toBe(true);
  });

  it('resumes the stream when the pane is focused again (pause policy)', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({
      engine,
      controls: { unfocusedPolicy: 'pause' },
    });
    await ctrl.open(A);
    await ctrl.blur(A);
    expect(engine.isStreaming(A)).toBe(false);

    await ctrl.focus(A);
    expect(engine.isStreaming(A)).toBe(true);
    expect(ctrl.isPaused(A)).toBe(false);
  });

  it('a paused (backgrounded) stream does NOT count against the concurrency cap', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({
      engine,
      controls: { maxConcurrentStreams: 1, unfocusedPolicy: 'pause' },
    });
    await ctrl.open(A);
    await ctrl.blur(A); // A is now paused → 0 active

    // B can now open because A consumes no slot while backgrounded.
    await expect(ctrl.open(B)).resolves.toBeUndefined();
    expect(engine.isStreaming(B)).toBe(true);
  });

  it('THROTTLE policy keeps streaming but lowers quality + raises frame-skip', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({
      engine,
      controls: {
        unfocusedPolicy: 'throttle',
        quality: 60,
        everyNthFrame: 1,
        unfocusedQuality: 15,
        unfocusedEveryNthFrame: 12,
      },
    });
    await ctrl.open(A);
    await ctrl.blur(A);

    // Still streaming (throttle, not pause) but degraded.
    expect(engine.isStreaming(A)).toBe(true);
    expect(engine.quality.get(A)).toBe(15);
    expect(engine.nth.get(A)).toBe(12);

    // Refocus restores full quality + frame rate.
    await ctrl.focus(A);
    expect(engine.quality.get(A)).toBe(60);
    expect(engine.nth.get(A)).toBe(1);
  });
});

describe('BandwidthController — control-message dispatch', () => {
  it('routes shared ScreencastControlMessages to the right control', async () => {
    const engine = makeFakeEngine();
    const ctrl = new BandwidthController({ engine });
    const startSpy = vi.spyOn(ctrl, 'open');
    const blurSpy = vi.spyOn(ctrl, 'blur');

    await ctrl.handleControlMessage({
      channel: 'screencast',
      action: 'start',
      sessionId: A,
    });
    await ctrl.handleControlMessage({
      channel: 'screencast',
      action: 'quality',
      sessionId: A,
      quality: 33,
    });
    await ctrl.handleControlMessage({
      channel: 'screencast',
      action: 'blur',
      sessionId: A,
    });

    expect(startSpy).toHaveBeenCalledWith(A);
    expect(blurSpy).toHaveBeenCalledWith(A);
    expect(engine.quality.get(A)).toBe(33);
  });
});

describe('computeEffectiveParams (pure)', () => {
  it('focused → full quality, full frame rate, streaming', () => {
    const p = computeEffectiveParams(
      { quality: 60, everyNthFrame: 1, unfocusedPolicy: 'pause' },
      'focused',
    );
    expect(p).toEqual({ quality: 60, everyNthFrame: 1, streaming: true });
  });

  it('unfocused + pause → not streaming (zero bandwidth)', () => {
    const p = computeEffectiveParams(
      { quality: 60, everyNthFrame: 1, unfocusedPolicy: 'pause' },
      'unfocused',
    );
    expect(p.streaming).toBe(false);
  });

  it('unfocused + throttle → degraded but streaming', () => {
    const p = computeEffectiveParams(
      {
        quality: 60,
        everyNthFrame: 1,
        unfocusedPolicy: 'throttle',
        unfocusedQuality: 15,
        unfocusedEveryNthFrame: 10,
      },
      'unfocused',
    );
    expect(p).toEqual({ quality: 15, everyNthFrame: 10, streaming: true });
  });
});
