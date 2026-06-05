/**
 * OSC 9/777 + BEL + output-then-quiet fallback status source (US-20).
 *
 * Wires the OSC/BEL parser and the output-then-quiet heuristic together behind
 * one façade. The orchestrator feeds every raw PTY chunk for a generic
 * (non-first-class) session into {@link OscFallbackStatusSource.push}; the source
 * derives {@link StatusSignal}s and hands them to the caller-supplied sink, which
 * the status core reconciles into the in-memory status map (NFR-PERF1: never on
 * the DB path) and the async/write-behind event log.
 *
 * Spec §7.1 "Universal fallback" mapping realised here:
 *   - OSC 9 / OSC 777 ; notify / bare BEL  -> awaiting_input
 *   - output activity (bytes after quiet)  -> running
 *   - quiet timer (output then quiet)      -> idle
 *   - bell-then-quiet                      -> done
 *   - OSC 133 ; D                          -> done
 *
 * This module owns NO global state and NO persistence — it is a pure,
 * per-session signal deriver. Postgres is never on this path.
 */
import { OscBelParser } from './osc-parser.js';
import { DEFAULT_QUIET_MS, OutputQuietHeuristic } from './quiet-heuristic.js';
import type { StatusSignal } from './types.js';

export { OscBelParser } from './osc-parser.js';
export { OutputQuietHeuristic, DEFAULT_QUIET_MS } from './quiet-heuristic.js';
export type {
  FallbackReason,
  FallbackStatus,
  Status,
  StatusSignal,
  StatusSink,
} from './types.js';

export interface OscFallbackStatusSourceOptions {
  /** Sink for every derived status signal (OSC/BEL and quiet-heuristic alike). */
  readonly onSignal: (signal: StatusSignal) => void;
  /** Quiet threshold (ms) for the output-then-quiet heuristic. */
  readonly quietMs?: number;
}

/**
 * A per-session status source combining the OSC/BEL parser and the
 * output-then-quiet heuristic. Both consume the same raw PTY byte stream.
 */
export class OscFallbackStatusSource {
  private readonly parser: OscBelParser;
  private readonly heuristic: OutputQuietHeuristic;

  constructor(options: OscFallbackStatusSourceOptions) {
    const onSignal = options.onSignal;
    this.heuristic = new OutputQuietHeuristic({
      quietMs: options.quietMs ?? DEFAULT_QUIET_MS,
      onSignal,
    });
    this.parser = new OscBelParser((signal) => {
      // A BEL (standalone or OSC-9/777 notify) means "attention". Mark it so a
      // following quiet period resolves to `done` (bell-then-quiet, spec §7.1).
      if (
        signal.reason === 'bel' ||
        signal.reason === 'osc9-notify' ||
        signal.reason === 'osc777-notify'
      ) {
        this.heuristic.markBell();
      }
      onSignal(signal);
    });
  }

  /** Feed the next raw PTY chunk to both the OSC parser and the quiet heuristic. */
  push(chunk: Buffer | Uint8Array): void {
    // Parser first so a bell within this chunk is marked before the heuristic
    // arms its quiet timer from the same bytes.
    this.parser.push(chunk);
    this.heuristic.onOutput(chunk);
  }

  /** Stop the heuristic's pending timer (call on session end). */
  stop(): void {
    this.heuristic.stop();
  }
}
