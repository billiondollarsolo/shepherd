/**
 * US-29 — Screencast bandwidth controls (NFR-PERF3, all four controls).
 *
 * The orchestrator-side owner of the four screencast bandwidth controls — cap
 * concurrent streams, throttle/pause the unfocused pane, adjustable JPEG quality,
 * on-demand only — driving the Layer C `ScreencastManager` (US-27/US-28).
 * Entirely local to the orchestrator VPS (PRD §6.4 dumb-node invariant).
 */
export {
  BandwidthController,
  computeEffectiveParams,
  type BandwidthControllerDeps,
} from './bandwidth-controller.js';
export { ScreencastEngineAdapter } from './screencast-engine-adapter.js';
export {
  type EffectiveStreamParams,
  type PaneFocus,
  type ScreencastBandwidthControls,
  type ScreencastEngine,
  type UnfocusedPolicy,
} from './types.js';
