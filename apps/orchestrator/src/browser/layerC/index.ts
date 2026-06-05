/**
 * Layer C — CDP screencast view (US-27, FR-B3, NFR-PERF3).
 *
 * Streams a session's isolated Chrome (Layer A/B) to the user's Browser tab over
 * the `screencast:<id>` WS channel via `Page.startScreencast`, ON DEMAND ONLY:
 * start on tab open, stop on tab switch. Entirely local to the orchestrator VPS
 * (PRD §6.4 dumb-node invariant).
 */
export { ScreencastManager, type ScreencastManagerDeps } from './manager.js';
export {
  screencastChannel,
  encodeScreencastFrame,
  decodeScreencastFrame,
  ScreencastFrameMessage,
} from './protocol.js';
export {
  DEFAULT_LAYER_C_CONFIG,
  ScreencastConcurrencyError,
  type CdpClientResolver,
  type CdpScreencastClient,
  type CdpScreencastFrame,
  type CdpScreencastFrameMetadata,
  type LayerCConfig,
  type ScreencastFrameAckParams,
  type ScreencastSink,
  type StartScreencastParams,
} from './types.js';

/**
 * US-28 — Layer C input takeover/release (FR-B4, FR-A3). The human control layer
 * over the same isolated Chrome: forward click/scroll/keys as CDP Input events,
 * single-controller lock, `browser_takeover` audit row on takeover.
 */
export {
  InputTakeoverController,
  type InputTakeoverControllerDeps,
  type TakeoverActor,
  type TakeoverResult,
} from './input-controller.js';
export {
  NotInControlError,
  TakeoverConflictError,
  type CdpInputClient,
  type CdpInputClientResolver,
  type CdpKeyEventParams,
  type CdpMouseEventParams,
  type InputIntent,
} from './input-types.js';
