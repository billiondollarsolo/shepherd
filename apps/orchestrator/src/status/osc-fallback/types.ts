/**
 * Shared types for the OSC/BEL + output-then-quiet fallback status source (US-20).
 *
 * The canonical status union lives in `packages/shared` (spec §7 "StatusEnum"):
 *   starting | running | awaiting_input | idle | done | error | disconnected
 *
 * We import it type-only so it is erased at runtime, while still guaranteeing we
 * never duplicate the domain enum. A compile-time assertion below proves our
 * {@link FallbackStatus} subset is a real subset of the shared enum, so if the
 * canonical enum ever changes this file fails to typecheck (the gate catches it).
 *
 * NOTE: `packages/shared` exports the union under the name `Status` (the value
 * literals are the same regardless of the alias). If the shared export is named
 * differently this single import specifier is the only line to adjust.
 */
import type { Status } from '@flock/shared';

export type { Status };

/**
 * The subset of the canonical status union this fallback source can emit.
 *
 * Per spec §7.1 "Universal fallback":
 *   - OSC 9 / OSC 777 / standalone BEL        -> `awaiting_input`
 *   - output activity (bytes after quiet)     -> `running`
 *   - quiet timer (output-then-quiet)         -> `idle`
 *   - bell-then-quiet                         -> `done`
 *   - OSC 133 ; D (command finished)          -> `done`
 */
export type FallbackStatus = 'awaiting_input' | 'running' | 'idle' | 'done';

/**
 * Compile-time guarantee that every {@link FallbackStatus} is a member of the
 * canonical shared {@link Status} union. If `@flock/shared` drops/renames one of
 * these literals, this assignment fails `tsc --noEmit`.
 */
const _assertFallbackIsStatus: Status = 'awaiting_input' as FallbackStatus;
void _assertFallbackIsStatus;

/** Why a status change was produced — recorded on the event (source = 'osc'/'pty'). */
export type FallbackReason =
  | 'osc9-notify'
  | 'osc777-notify'
  | 'bel'
  | 'osc133-finished'
  | 'output-resumed'
  | 'output-quiet'
  | 'bell-then-quiet';

export interface StatusSignal {
  readonly status: FallbackStatus;
  readonly reason: FallbackReason;
  /** Optional human-readable text extracted from the OSC payload (e.g. notify body). */
  readonly text?: string;
}

/** Sink invoked whenever the fallback source derives a new status signal. */
export type StatusSink = (signal: StatusSignal) => void;
