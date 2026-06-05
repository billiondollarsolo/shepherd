import {
  DEFAULT_LAYER_C_CONFIG,
  ScreencastConcurrencyError,
  type CdpClientResolver,
  type CdpScreencastClient,
  type CdpScreencastFrame,
  type LayerCConfig,
  type ScreencastSink,
} from './types.js';
import { encodeScreencastFrame } from './protocol.js';

export interface ScreencastManagerDeps {
  /** Resolves a connected CDP client for a session's running browser. */
  resolveClient: CdpClientResolver;
  /** Forwards encoded frames to the `screencast:<id>` WS channel. */
  sink: ScreencastSink;
  /** Optional config overrides (quality/throttle/cap — NFR-PERF3). */
  config?: Partial<LayerCConfig>;
}

/** One active screencast stream (the live registry entry). */
interface ActiveStream {
  client: CdpScreencastClient;
  /** Unsubscribe handle returned by `Page.screencastFrame`. */
  unsubscribe: () => void;
  /** Per-stream JPEG quality (live-adjustable, NFR-PERF3). */
  quality: number;
}

/**
 * US-27 — Layer C: stream a session's isolated Chrome to the Browser tab via
 * CDP `Page.startScreencast`, **on demand only** (FR-B3, NFR-PERF3).
 *
 * On-demand semantics (the heart of US-27):
 *  - `start(sessionId)` is called when the user OPENS the Browser tab. Only then
 *    do we connect to CDP and issue `Page.startScreencast`. Nothing streams (or
 *    even subscribes) before a viewer exists.
 *  - `stop(sessionId)` is called when the user SWITCHES away from the tab. We
 *    issue `Page.stopScreencast`, drop the frame listener, and forward no more
 *    frames — so a backgrounded session stops consuming bandwidth.
 *
 * Bandwidth controls (NFR-PERF3): adjustable JPEG quality, frame throttling
 * (`everyNthFrame`), and a cap on concurrent active streams are all applied
 * here; pause/throttle of an unfocused pane is driven by the client calling
 * `stop()`/`setQuality()` from the Browser tab.
 *
 * Entirely local to the orchestrator VPS — nodes are never touched (PRD §6.4
 * dumb-node invariant). Builds on Layer A's per-session CDP endpoint (US-25) and
 * is the same Chrome the agent drives via Layer B (US-26).
 */
export class ScreencastManager {
  private readonly resolveClient: CdpClientResolver;
  private readonly sink: ScreencastSink;
  private readonly config: LayerCConfig;
  /** sessionId -> active stream. The live registry of streaming tabs. */
  private readonly active = new Map<string, ActiveStream>();
  /** Per-session start locks so a double tab-open can't race two startScreencasts. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(deps: ScreencastManagerDeps) {
    this.resolveClient = deps.resolveClient;
    this.sink = deps.sink;
    this.config = { ...DEFAULT_LAYER_C_CONFIG, ...deps.config };
  }

  /** Number of currently active (streaming) tabs. */
  activeCount(): number {
    return this.active.size;
  }

  /** True iff a screencast is currently streaming for this session. */
  isStreaming(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /**
   * Start streaming a session's browser to its `screencast:<id>` channel.
   *
   * Called ON DEMAND when the Browser tab opens (US-27). Idempotent per session:
   * a second call while already streaming is a no-op (no duplicate
   * `startScreencast`). Enforces the concurrent-stream cap before connecting.
   */
  async start(sessionId: string): Promise<void> {
    if (!sessionId) throw new Error('sessionId is required');

    if (this.active.has(sessionId)) return;

    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    // Cap counts running + in-flight starts so a burst can't blow past the limit.
    if (this.active.size + this.inflight.size >= this.config.maxConcurrentStreams) {
      throw new ScreencastConcurrencyError(this.config.maxConcurrentStreams);
    }

    const promise = this.doStart(sessionId);
    this.inflight.set(sessionId, promise);
    try {
      await promise;
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  private async doStart(sessionId: string): Promise<void> {
    const client = await this.resolveClient(sessionId);
    const quality = this.pendingQuality.get(sessionId) ?? this.config.quality;

    // Subscribe BEFORE starting so no first frame is missed.
    const unsubscribe = client.Page.screencastFrame((frame) =>
      this.onFrame(sessionId, client, frame),
    );

    try {
      await client.Page.startScreencast({
        format: this.config.format,
        quality,
        maxWidth: this.config.maxWidth,
        maxHeight: this.config.maxHeight,
        everyNthFrame: this.config.everyNthFrame,
      });
    } catch (err) {
      unsubscribe();
      throw err;
    }

    this.active.set(sessionId, { client, unsubscribe, quality });
  }

  /** Pending per-session quality set before/while (re)starting. */
  private readonly pendingQuality = new Map<string, number>();

  /**
   * Forward one CDP frame to the channel, then ack it so chrome sends the next.
   *
   * A frame can arrive after `stop()` (chrome's stop + our unsubscribe race a
   * frame already in flight); we guard on the live registry so a stopped stream
   * never forwards (US-27 "no further frames after switch").
   */
  private onFrame(
    sessionId: string,
    client: CdpScreencastClient,
    frame: CdpScreencastFrame,
  ): void {
    if (!this.active.has(sessionId)) return;
    this.sink.send(sessionId, encodeScreencastFrame(sessionId, frame));
    // Ack back-pressure: chrome will not send the next frame until acked.
    void client.Page.screencastFrameAck({ sessionId: frame.sessionId });
  }

  /**
   * Adjust JPEG quality for a session live (NFR-PERF3). Takes effect on the next
   * (re)start of the stream; recorded so a stop→start cycle re-applies it.
   */
  setQuality(sessionId: string, quality: number): void {
    const clamped = Math.max(0, Math.min(100, Math.trunc(quality)));
    this.pendingQuality.set(sessionId, clamped);
    const stream = this.active.get(sessionId);
    if (stream) stream.quality = clamped;
  }

  /**
   * Stop a session's screencast.
   *
   * Called ON DEMAND when the Browser tab is switched away (US-27). Issues
   * `Page.stopScreencast`, drops the frame listener, and removes the registry
   * entry so no further frames are forwarded. Idempotent: a no-op (and no CDP
   * call) when the session is not streaming.
   */
  async stop(sessionId: string): Promise<boolean> {
    const stream = this.active.get(sessionId);
    if (!stream) return false;

    // Remove from the registry FIRST so any in-flight frame is dropped (guard in
    // onFrame) even if stopScreencast is slow.
    this.active.delete(sessionId);
    stream.unsubscribe();

    try {
      await stream.client.Page.stopScreencast();
    } catch {
      // Best-effort: even if chrome already tore the page down, the stream is
      // gone from our perspective and no more frames will be forwarded.
    }
    return true;
  }

  /** Stop every active screencast (orchestrator shutdown / session terminate sweep). */
  async stopAll(): Promise<void> {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}
