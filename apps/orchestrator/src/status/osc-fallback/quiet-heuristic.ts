/**
 * US-20 — Output-then-quiet fallback heuristic.
 *
 * For hook-less agents that emit neither structured hooks nor OSC/BEL signals, we
 * infer activity purely from the rhythm of PTY output (spec §7.1 "Universal
 * fallback"):
 *
 *   - output activity (bytes after quiet)  -> `running`  (output-resumed)
 *   - output then a quiet period (>quietMs) -> `idle`     (output-quiet)
 *   - a BEL then a quiet period            -> `done`     (bell-then-quiet)
 *
 * The "bell-then-quiet -> done" refinement is driven by the caller marking a
 * pending bell via {@link OutputQuietHeuristic.markBell} (the OSC/BEL parser
 * detects the bell; this heuristic owns the quiet timer). The heuristic is
 * deliberately tiny and timer-driven so it can be unit-tested with fake timers
 * over "timed byte sequences".
 */
import type { FallbackReason, FallbackStatus, StatusSignal } from './types.js';

export interface OutputQuietHeuristicOptions {
  /** Milliseconds of silence after the last output before we declare idle/done. */
  readonly quietMs: number;
  /** Invoked when the heuristic derives a new status. */
  readonly onSignal: (signal: StatusSignal) => void;
}

/** Default quiet threshold (ms) used when none is supplied by the caller. */
export const DEFAULT_QUIET_MS = 1500;

type Activity = 'active' | 'quiet';

export class OutputQuietHeuristic {
  private readonly quietMs: number;
  private readonly onSignal: (signal: StatusSignal) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Tracks whether we have already announced "active". Starts `quiet` so the
   * very first burst of output produces an `output-resumed` only if it follows
   * a prior idle/done — i.e. we do NOT emit `running` on the initial burst.
   */
  private activity: Activity = 'quiet';
  /** Whether any output has been seen at all (gates the initial-burst behaviour). */
  private seenOutput = false;
  /** Set when a BEL has been seen since the last quiet resolution. */
  private bellPending = false;

  constructor(options: OutputQuietHeuristicOptions) {
    this.quietMs = options.quietMs;
    this.onSignal = options.onSignal;
  }

  /**
   * Record a chunk of PTY output. Empty chunks are treated as no activity and
   * never arm the timer.
   */
  onOutput(chunk: Buffer | Uint8Array): void {
    if (chunk.length === 0) return;

    // Output after a quiet period means the agent became active again.
    if (this.seenOutput && this.activity === 'quiet') {
      this.activity = 'active';
      this.emit('running', 'output-resumed');
    } else {
      this.activity = 'active';
    }
    this.seenOutput = true;

    this.armQuietTimer();
  }

  /**
   * Note that a BEL was observed in the stream. Per spec §7.1, a bell followed
   * by a quiet period resolves to `done` rather than `idle`. The BEL bytes are
   * already delivered through {@link onOutput} by the caller (they are part of
   * the PTY stream), so this only flips the pending flag — it does not re-arm
   * the timer itself.
   */
  markBell(): void {
    this.bellPending = true;
  }

  /** Cancel any pending quiet timer (e.g. on session end). */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private armQuietTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.activity = 'quiet';
      if (this.bellPending) {
        this.bellPending = false;
        this.emit('done', 'bell-then-quiet');
      } else {
        this.emit('idle', 'output-quiet');
      }
    }, this.quietMs);
  }

  private emit(status: FallbackStatus, reason: FallbackReason): void {
    this.onSignal({ status, reason });
  }
}
