import type {
  ScreencastBandwidthControls,
  UnfocusedPolicy,
} from '@flock/shared';

/**
 * US-29 — Screencast bandwidth controls (NFR-PERF3) orchestrator-internal types.
 *
 * The cross-app config/contract shapes (`ScreencastBandwidthControls`,
 * `UnfocusedPolicy`, the control messages) live in `@flock/shared`
 * (screencast-controls.ts) and are NEVER redefined here. This module adds only
 * the orchestrator-internal seams the {@link BandwidthController} drives — the
 * effective per-stream parameters and the screencast engine it commands.
 */

export type { ScreencastBandwidthControls, UnfocusedPolicy };

/**
 * The concrete `Page.startScreencast` parameters the controller computes for a
 * stream given its config + focus state — the resolved output of the four
 * controls for one pane.
 */
export interface EffectiveStreamParams {
  /** JPEG quality (1..100) — control #3, reduced when unfocused+throttle. */
  quality: number;
  /** Send every Nth frame — throttle, raised when unfocused+throttle. */
  everyNthFrame: number;
  /**
   * Whether frames should flow at all. `false` for an unfocused pane under the
   * `pause` policy — the bandwidth-floor of control #2 (zero frames). The
   * critical NFR-PERF3 property: a backgrounded session streams nothing.
   */
  streaming: boolean;
}

/**
 * The minimal screencast engine the {@link BandwidthController} commands. The
 * existing Layer C `ScreencastManager` (US-27) satisfies this; modeling just the
 * slice the controller needs keeps it unit-testable with a fake and decoupled
 * from the manager's internals.
 */
export interface ScreencastEngine {
  /** Begin (or no-op if already) streaming a session at the given params. */
  start(sessionId: string): Promise<void>;
  /** Stop a session's stream (zero further frames). Returns whether one was live. */
  stop(sessionId: string): Promise<boolean>;
  /** True iff the session is currently streaming. */
  isStreaming(sessionId: string): boolean;
  /** Number of currently active streams (for the cap). */
  activeCount(): number;
  /** Adjust the live JPEG quality for a session. */
  setQuality(sessionId: string, quality: number): void;
  /** Adjust the live frame-skip throttle for a session. */
  setEveryNthFrame(sessionId: string, everyNthFrame: number): void;
}

/** Per-session focus state the controller tracks to apply control #2. */
export type PaneFocus = 'focused' | 'unfocused';
