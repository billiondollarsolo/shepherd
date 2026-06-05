/**
 * Layer C types — the per-session CDP screencast (US-27, FR-B3, NFR-PERF3).
 *
 * Layer C streams the SAME isolated Chrome the agent drives (Layer A/B) to the
 * user's Browser tab via `Page.startScreencast`. It is the third layer over one
 * Chrome (spec §6.5) and is entirely local to the orchestrator VPS — nodes are
 * never touched (PRD §6.4 dumb-node invariant).
 *
 * These are the minimal slices of `chrome-remote-interface` Layer C uses, so the
 * manager is unit-testable with a fake CDP client (the integration test wires a
 * real chrome via the resolver from Layer A).
 */

/**
 * The CDP `Page.screencastFrame` event payload (the subset Layer C forwards).
 * @see https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-screencastFrame
 */
export interface CdpScreencastFrame {
  /** Base64-encoded compressed image (JPEG when format='jpeg'). */
  data: string;
  /** Frame metadata describing the captured viewport. */
  metadata: CdpScreencastFrameMetadata;
  /** Frame number; must be acked via `Page.screencastFrameAck`. */
  sessionId: number;
}

/** CDP `Page.ScreencastFrameMetadata` (the fields we surface to the client). */
export interface CdpScreencastFrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  /** Frame ordinal supplied by chrome (optional). */
  timestamp?: number;
}

/** Options for `Page.startScreencast` (subset). */
export interface StartScreencastParams {
  format: 'jpeg' | 'png';
  /** JPEG quality 0..100 (NFR-PERF3 adjustable quality). */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Send every Nth frame (NFR-PERF3 throttle). */
  everyNthFrame?: number;
}

/** Params for `Page.screencastFrameAck`. */
export interface ScreencastFrameAckParams {
  /** Echoes the `sessionId` from the frame being acknowledged. */
  sessionId: number;
}

/**
 * The minimal CDP client surface Layer C drives. `chrome-remote-interface`
 * returns a client whose `Page` domain exposes these; modeling just this slice
 * keeps the manager testable with a fake and free of a hard dependency in unit
 * tests.
 */
export interface CdpScreencastClient {
  Page: {
    /** Begin streaming frames (we only start ON DEMAND — US-27). */
    startScreencast(params: StartScreencastParams): Promise<unknown>;
    /** Stop streaming frames (on tab switch / no viewer — US-27). */
    stopScreencast(): Promise<unknown>;
    /** Ack a delivered frame so chrome sends the next (back-pressure). */
    screencastFrameAck(params: ScreencastFrameAckParams): Promise<unknown>;
    /** Subscribe to frame events; returns an unsubscribe handle. */
    screencastFrame(listener: (frame: CdpScreencastFrame) => void): () => void;
  };
  /** Close the CDP connection (called when Layer C is the sole owner). */
  close?(): Promise<void>;
}

/**
 * Resolves a connected CDP client for a session's running browser. Injected so
 * the manager is unit-testable without a real chrome; the orchestrator wires the
 * real `chrome-remote-interface` connection keyed off Layer A's `cdpEndpoint`.
 */
export type CdpClientResolver = (
  sessionId: string,
) => Promise<CdpScreencastClient>;

/**
 * The sink Layer C forwards encoded frames to — one logical `screencast:<id>`
 * WebSocket channel (spec §8.2). Injected so the manager is transport-agnostic
 * and unit-testable; the orchestrator wires the real `ws` server.
 */
export interface ScreencastSink {
  /**
   * Forward one screencast frame to subscribers of `screencast:<sessionId>`.
   * The payload is the wire frame produced by {@link encodeScreencastFrame}.
   */
  send(sessionId: string, payload: string): void;
}

/** Tunable Layer C configuration (NFR-PERF3 bandwidth controls). */
export interface LayerCConfig {
  /** JPEG quality 0..100 (adjustable per NFR-PERF3). */
  quality: number;
  /** Capture format. */
  format: 'jpeg' | 'png';
  maxWidth: number;
  maxHeight: number;
  /** Throttle: send every Nth frame. */
  everyNthFrame: number;
  /** Cap on concurrent ACTIVE screencast streams (NFR-PERF3). */
  maxConcurrentStreams: number;
}

/** Default Layer C config (override per-deploy). */
export const DEFAULT_LAYER_C_CONFIG: LayerCConfig = {
  quality: 60,
  format: 'jpeg',
  maxWidth: 1280,
  maxHeight: 720,
  everyNthFrame: 1,
  maxConcurrentStreams: 5,
};

/** Raised when the concurrent active-stream cap is reached (NFR-PERF3, spec §10). */
export class ScreencastConcurrencyError extends Error {
  constructor(public readonly cap: number) {
    super(`screencast active-stream cap reached (${cap})`);
    this.name = 'ScreencastConcurrencyError';
  }
}
