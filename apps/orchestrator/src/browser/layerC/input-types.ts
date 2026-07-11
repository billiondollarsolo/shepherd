/**
 * Layer C input-takeover types — US-28 (FR-B4, FR-A3).
 *
 * Layer C lets the USER take control of the SAME isolated Chrome the agent
 * drives (Layer A/B): user click/scroll/key intents are forwarded to chrome as
 * CDP `Input.*` events. Control is single-controller (one holder at a time); a
 * second takeover is rejected while a controller holds the lock (spec §10 edge
 * case "two takeover requests on one browser → second is rejected or queued").
 *
 * The cross-app intent contract (`InputIntent`, `CdpMouseEventParams`,
 * `CdpKeyEventParams`) lives in `@flock/shared` (browser-input.ts) and is
 * re-exported here for ergonomics — it is NEVER redefined locally. This module
 * adds only the orchestrator-internal CDP `Input` client slice + the resolver +
 * the control errors, which never cross the app boundary.
 *
 * Entirely local to the orchestrator VPS — nodes are never touched (PRD §6.4
 * dumb-node invariant).
 *
 * @see https://chromedevtools.github.io/devtools-protocol/tot/Input/
 */
import type { CdpKeyEventParams, CdpMouseEventParams, InputIntent } from '@flock/shared';

export type { CdpKeyEventParams, CdpMouseEventParams, InputIntent };

/**
 * The minimal CDP client surface the takeover layer drives — the `Input` domain.
 * Modeled as its own slice (separate from `CdpScreencastClient`'s `Page`) so the
 * controller stays unit-testable with a fake and free of a hard chrome dep in
 * unit tests. The orchestrator wires the real `chrome-remote-interface` client,
 * which exposes BOTH `Page` and `Input`.
 */
export interface CdpInputClient {
  Input: {
    /** Forward a mouse/scroll event to the page (click/scroll). */
    dispatchMouseEvent(params: CdpMouseEventParams): Promise<unknown>;
    /** Forward a key event to the page (keys). */
    dispatchKeyEvent(params: CdpKeyEventParams): Promise<unknown>;
  };
}

/**
 * Resolves a connected CDP `Input` client for a session's running browser.
 * Injected so the controller is unit-testable without a real chrome; the
 * orchestrator wires the real `chrome-remote-interface` connection keyed off
 * Layer A's `cdpEndpoint` (the SAME chrome Layer B drives and Layer C streams).
 */
export type CdpInputClientResolver = (sessionId: string) => Promise<CdpInputClient>;

/** Raised when a takeover is requested but another controller already holds it. */
export class TakeoverConflictError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly currentControllerId: string,
  ) {
    super(`session ${sessionId} is already controlled by ${currentControllerId}`);
    this.name = 'TakeoverConflictError';
  }
}

/** Raised when an input is forwarded by a client that does not hold control. */
export class NotInControlError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly controllerId: string,
  ) {
    super(`client ${controllerId} does not hold control of session ${sessionId}`);
    this.name = 'NotInControlError';
  }
}
