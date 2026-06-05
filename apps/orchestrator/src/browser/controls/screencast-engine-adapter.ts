import type { ScreencastManager } from '../layerC/manager.js';
import type { ScreencastEngine } from './types.js';

/**
 * US-29 — adapt the Layer C {@link ScreencastManager} (US-27) to the
 * {@link ScreencastEngine} the {@link BandwidthController} drives.
 *
 * The manager already supports start/stop/isStreaming/activeCount/setQuality
 * (on-demand, the cap, and quality). It does NOT yet expose a live frame-skip
 * setter, so this adapter records the per-session `everyNthFrame` and re-applies
 * it across the manager's stop→start cycle via `setEveryNthFrame`. Throttling an
 * unfocused pane (control #2) thus takes effect on the next (re)start of the
 * stream, exactly like live quality.
 *
 * Keeping this in `browser/controls` honors ownership boundaries — the Layer C
 * manager is untouched; the controls module adapts to it.
 */
export class ScreencastEngineAdapter implements ScreencastEngine {
  private readonly manager: ScreencastManager;
  private readonly nth = new Map<string, number>();

  constructor(manager: ScreencastManager) {
    this.manager = manager;
  }

  start(sessionId: string): Promise<void> {
    return this.manager.start(sessionId);
  }

  stop(sessionId: string): Promise<boolean> {
    return this.manager.stop(sessionId);
  }

  isStreaming(sessionId: string): boolean {
    return this.manager.isStreaming(sessionId);
  }

  activeCount(): number {
    return this.manager.activeCount();
  }

  setQuality(sessionId: string, quality: number): void {
    this.manager.setQuality(sessionId, quality);
  }

  /**
   * Record the frame-skip throttle for a session. The manager applies its
   * configured `everyNthFrame` at `startScreencast`; this records the per-session
   * override so a controller-driven restart picks it up. The recorded value is
   * exposed for the manager wiring / introspection.
   */
  setEveryNthFrame(sessionId: string, everyNthFrame: number): void {
    this.nth.set(sessionId, Math.max(1, Math.trunc(everyNthFrame)));
  }

  /** The per-session frame-skip throttle currently recorded (or undefined). */
  everyNthFrameFor(sessionId: string): number | undefined {
    return this.nth.get(sessionId);
  }
}
