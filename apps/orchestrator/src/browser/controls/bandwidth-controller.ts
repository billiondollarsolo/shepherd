import {
  DEFAULT_SCREENCAST_BANDWIDTH_CONTROLS,
  ScreencastBandwidthControls,
  type ScreencastBandwidthControlMessage,
} from '@flock/shared';
import { ScreencastConcurrencyError } from '../layerC/types.js';
import { type EffectiveStreamParams, type PaneFocus, type ScreencastEngine } from './types.js';

const Q_MIN = 1;
const Q_MAX = 100;

function clampQuality(q: number): number {
  return Math.max(Q_MIN, Math.min(Q_MAX, Math.trunc(q)));
}

/**
 * Pure resolver: given the bandwidth config and a pane's focus state, compute the
 * effective `Page.startScreencast` parameters — the heart of controls #2 and #3.
 *
 *  - focused           → full quality, full frame rate, streaming.
 *  - unfocused + pause → NOT streaming (zero frames → zero bandwidth, NFR-PERF3).
 *  - unfocused+throttle→ reduced quality + raised frame-skip, still streaming.
 *
 * Side-effect-free so it is trivially unit-testable and reused by the controller.
 */
export function computeEffectiveParams(
  controls: Pick<
    ScreencastBandwidthControls,
    'quality' | 'everyNthFrame' | 'unfocusedPolicy' | 'unfocusedQuality' | 'unfocusedEveryNthFrame'
  > &
    Partial<ScreencastBandwidthControls>,
  focus: PaneFocus,
): EffectiveStreamParams {
  const merged = { ...DEFAULT_SCREENCAST_BANDWIDTH_CONTROLS, ...controls };
  if (focus === 'focused') {
    return {
      quality: merged.quality,
      everyNthFrame: merged.everyNthFrame,
      streaming: true,
    };
  }
  // Unfocused.
  if (merged.unfocusedPolicy === 'pause') {
    return { quality: merged.quality, everyNthFrame: merged.everyNthFrame, streaming: false };
  }
  return {
    quality: merged.unfocusedQuality,
    everyNthFrame: merged.unfocusedEveryNthFrame,
    streaming: true,
  };
}

export interface BandwidthControllerDeps {
  /** The screencast engine driven by the controls (Layer C `ScreencastManager`). */
  engine: ScreencastEngine;
  /** Partial overrides of the four-control config (validated + defaulted). */
  controls?: Partial<ScreencastBandwidthControls>;
}

/** Per-session control state the controller tracks. */
interface PaneState {
  focus: PaneFocus;
  /** True iff the tab is open (on-demand control #4) — vs fully closed. */
  open: boolean;
  /** Per-session quality override the user set (control #3). */
  quality: number;
}

/**
 * US-29 — Screencast bandwidth controls (NFR-PERF3).
 *
 * The single place that owns ALL FOUR controls and drives the Layer C screencast
 * engine accordingly:
 *
 *   1. **Cap concurrent active streams** — `open()` refuses past
 *      `maxConcurrentStreams`; a PAUSED (backgrounded) stream frees its slot, so
 *      a backgrounded session neither consumes bandwidth nor a concurrency slot.
 *   2. **Throttle/pause the unfocused pane** — `blur()` applies `unfocusedPolicy`:
 *      `pause` stops the stream entirely (zero frames → zero bandwidth, the
 *      headline NFR-PERF3 property); `throttle` lowers quality + raises the
 *      frame-skip while keeping a trickle. `focus()` restores full rate/quality.
 *   3. **Adjustable JPEG quality** — `setQuality()` applies a clamped live value.
 *   4. **On-demand only** — nothing streams until `open()` (tab opened);
 *      `close()` (tab switched/closed) stops it. The controller issues no CDP
 *      work for a session with no open pane.
 *
 * Entirely local to the orchestrator VPS — nodes are never touched (PRD §6.4
 * dumb-node invariant). Sits above the Layer C `ScreencastManager` (US-27/US-28).
 */
export class BandwidthController {
  private readonly engine: ScreencastEngine;
  private readonly controls: ScreencastBandwidthControls;
  /** sessionId -> control state. */
  private readonly panes = new Map<string, PaneState>();

  constructor(deps: BandwidthControllerDeps) {
    this.engine = deps.engine;
    this.controls = ScreencastBandwidthControls.parse({ ...deps.controls });
  }

  /** Current effective config (after defaulting/validation). */
  config(): ScreencastBandwidthControls {
    return this.controls;
  }

  /** True iff frames are currently flowing for this session. */
  isStreaming(sessionId: string): boolean {
    return this.engine.isStreaming(sessionId);
  }

  /** True iff the pane is open but paused (backgrounded under the pause policy). */
  isPaused(sessionId: string): boolean {
    const pane = this.panes.get(sessionId);
    return !!pane && pane.open && !this.engine.isStreaming(sessionId);
  }

  /**
   * Control #4 (on-demand) + #1 (cap): open a session's Browser tab and begin
   * streaming. A newly opened pane is FOCUSED. Enforces the concurrent-stream cap
   * before starting — only ACTIVE (streaming) panes count toward it, so a
   * backgrounded/paused pane does not occupy a slot.
   */
  async open(sessionId: string): Promise<void> {
    if (!sessionId) throw new Error('sessionId is required');

    const existing = this.panes.get(sessionId);
    if (existing?.open && this.engine.isStreaming(sessionId)) return;

    // Cap counts only currently-active streams (paused panes are free).
    if (
      !this.engine.isStreaming(sessionId) &&
      this.engine.activeCount() >= this.controls.maxConcurrentStreams
    ) {
      throw new ScreencastConcurrencyError(this.controls.maxConcurrentStreams);
    }

    const pane: PaneState = existing ?? {
      focus: 'focused',
      open: true,
      quality: this.controls.quality,
    };
    pane.open = true;
    pane.focus = 'focused';
    this.panes.set(sessionId, pane);

    await this.apply(sessionId);
  }

  /**
   * Control #4: close (tab switched away / fully closed). Stops the stream and
   * forgets the pane so no further bandwidth is consumed (the on-demand floor).
   */
  async close(sessionId: string): Promise<void> {
    this.panes.delete(sessionId);
    await this.engine.stop(sessionId);
  }

  /**
   * Control #2: the pane gained focus → full quality + frame rate; resumes a
   * paused stream. Re-checks the cap when un-pausing (a paused pane gave up its
   * slot, so another pane may have taken it).
   */
  async focus(sessionId: string): Promise<void> {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    const wasPaused = !this.engine.isStreaming(sessionId);
    pane.focus = 'focused';
    if (wasPaused && this.engine.activeCount() >= this.controls.maxConcurrentStreams) {
      throw new ScreencastConcurrencyError(this.controls.maxConcurrentStreams);
    }
    await this.apply(sessionId);
  }

  /**
   * Control #2 (the headline NFR-PERF3 property): the pane lost focus →
   * background. Under `pause` the stream is STOPPED (zero frames → zero
   * bandwidth) and its concurrency slot is freed; under `throttle` it keeps
   * streaming at reduced quality + frame rate.
   */
  async blur(sessionId: string): Promise<void> {
    const pane = this.panes.get(sessionId);
    if (!pane) return;
    pane.focus = 'unfocused';
    await this.apply(sessionId);
  }

  /**
   * Control #3: adjust the JPEG quality for a session live. Clamped to [1,100];
   * remembered so a pause→resume cycle re-applies it. Only takes immediate effect
   * while the pane is focused + streaming.
   */
  setQuality(sessionId: string, quality: number): void {
    const clamped = clampQuality(quality);
    const pane = this.panes.get(sessionId);
    if (pane) pane.quality = clamped;
    if (pane?.focus === 'focused' && this.engine.isStreaming(sessionId)) {
      this.engine.setQuality(sessionId, clamped);
    }
  }

  /**
   * Apply the effective params for a pane: start/stop to match `streaming`, then
   * push quality + frame-skip when streaming. The single funnel through which all
   * four controls reach the engine.
   */
  private async apply(sessionId: string): Promise<void> {
    const pane = this.panes.get(sessionId);
    if (!pane || !pane.open) return;

    const params = computeEffectiveParams({ ...this.controls, quality: pane.quality }, pane.focus);

    if (!params.streaming) {
      // Pause: stop the stream entirely — zero frames, zero bandwidth.
      await this.engine.stop(sessionId);
      return;
    }

    if (!this.engine.isStreaming(sessionId)) {
      await this.engine.start(sessionId);
    }
    this.engine.setQuality(sessionId, params.quality);
    this.engine.setEveryNthFrame(sessionId, params.everyNthFrame);
  }

  /**
   * Route an inbound shared {@link ScreencastBandwidthControlMessage} (from the web
   * Browser tab over the `screencast:<id>` channel) to the matching control. The
   * single entry point the WS layer calls so the four controls share one dispatcher.
   */
  async handleControlMessage(msg: ScreencastBandwidthControlMessage): Promise<void> {
    switch (msg.action) {
      case 'start':
        await this.open(msg.sessionId);
        return;
      case 'stop':
        await this.close(msg.sessionId);
        return;
      case 'focus':
        await this.focus(msg.sessionId);
        return;
      case 'blur':
        await this.blur(msg.sessionId);
        return;
      case 'quality':
        this.setQuality(msg.sessionId, msg.quality);
        return;
    }
  }

  /** Stop every open pane (orchestrator shutdown / terminate sweep). */
  async stopAll(): Promise<void> {
    const ids = [...this.panes.keys()];
    this.panes.clear();
    await Promise.all(ids.map((id) => this.engine.stop(id)));
  }
}
