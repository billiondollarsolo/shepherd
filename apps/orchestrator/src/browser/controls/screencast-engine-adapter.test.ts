import { describe, expect, it, vi } from 'vitest';
import { ScreencastEngineAdapter } from './screencast-engine-adapter.js';
import { BandwidthController } from './bandwidth-controller.js';
import type { ScreencastManager } from '../layerC/manager.js';

/**
 * US-29 — the adapter forwards the engine surface to the Layer C manager and
 * records the per-session frame-skip throttle (which the manager lacks natively).
 */

function makeFakeManager() {
  const live = new Set<string>();
  return {
    start: vi.fn(async (id: string) => {
      live.add(id);
    }),
    stop: vi.fn(async (id: string) => live.delete(id)),
    isStreaming: vi.fn((id: string) => live.has(id)),
    activeCount: vi.fn(() => live.size),
    setQuality: vi.fn(),
  } as unknown as ScreencastManager;
}

const A = 'aaaaaaaa-1111-4111-8111-111111111111';

describe('ScreencastEngineAdapter (US-29)', () => {
  it('forwards start/stop/isStreaming/activeCount/setQuality to the manager', async () => {
    const mgr = makeFakeManager();
    const adapter = new ScreencastEngineAdapter(mgr);

    await adapter.start(A);
    expect(mgr.start).toHaveBeenCalledWith(A);
    expect(adapter.isStreaming(A)).toBe(true);
    expect(adapter.activeCount()).toBe(1);

    adapter.setQuality(A, 40);
    expect(mgr.setQuality).toHaveBeenCalledWith(A, 40);

    await adapter.stop(A);
    expect(mgr.stop).toHaveBeenCalledWith(A);
  });

  it('records the per-session frame-skip throttle (clamped >= 1)', () => {
    const adapter = new ScreencastEngineAdapter(makeFakeManager());
    adapter.setEveryNthFrame(A, 8);
    expect(adapter.everyNthFrameFor(A)).toBe(8);
    adapter.setEveryNthFrame(A, 0);
    expect(adapter.everyNthFrameFor(A)).toBe(1);
  });

  it('drives a real BandwidthController end-to-end through the adapter', async () => {
    const mgr = makeFakeManager();
    const ctrl = new BandwidthController({
      engine: new ScreencastEngineAdapter(mgr),
      controls: { unfocusedPolicy: 'pause' },
    });

    await ctrl.open(A);
    expect(mgr.isStreaming(A)).toBe(true);

    // Backgrounding the pane must stop the underlying manager stream (NFR-PERF3).
    await ctrl.blur(A);
    expect(mgr.isStreaming(A)).toBe(false);
    expect(mgr.stop).toHaveBeenCalledWith(A);
  });
});
