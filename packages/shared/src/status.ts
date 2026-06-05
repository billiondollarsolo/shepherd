import { z } from 'zod';

/**
 * The unified status model — the heart of Flock (spec §7, PRD §7).
 *
 * The live value of a session's status is held in the orchestrator's in-memory
 * map and fanned out over the `status` WebSocket channel; Postgres only ever
 * holds a write-behind mirror (spec §6.6, NFR-PERF1). These are the canonical
 * status values shared by both apps.
 */
export const STATUS_VALUES = [
  'starting',
  'running',
  'awaiting_input',
  'idle',
  'done',
  'error',
  'disconnected',
] as const;

/** zod enum for the unified status model. */
export const StatusEnum = z.enum(STATUS_VALUES);

/** The unified status of an agent session. */
export type Status = z.infer<typeof StatusEnum>;

/** Human-facing label per status — the single source for status text in the UI. */
export const STATUS_LABEL: Readonly<Record<Status, string>> = {
  starting: 'Starting',
  running: 'Running',
  awaiting_input: 'Awaiting input',
  idle: 'Idle',
  done: 'Done',
  error: 'Error',
  disconnected: 'Disconnected',
};

/** Display label for a status (falls back to the raw value for safety). */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status as Status] ?? status;
}

/**
 * UX policy per status (spec §7 table).
 *  - `ringsSidebar`: the session ring/dot demands attention in the tree.
 *  - `pushes`: a Web Push is sent on transition INTO this status (FR-ST4).
 *  - `attentionRank`: lower sorts higher in the "needs attention" ordering
 *    (FR-ST6, FR-UI3); awaiting_input/error float to the top.
 */
export interface StatusPolicy {
  readonly ringsSidebar: boolean;
  readonly pushes: boolean;
  readonly attentionRank: number;
}

export const STATUS_POLICY: Readonly<Record<Status, StatusPolicy>> = {
  starting: { ringsSidebar: false, pushes: false, attentionRank: 4 },
  running: { ringsSidebar: false, pushes: false, attentionRank: 5 },
  awaiting_input: { ringsSidebar: true, pushes: true, attentionRank: 0 },
  idle: { ringsSidebar: false, pushes: false, attentionRank: 3 },
  done: { ringsSidebar: false, pushes: true, attentionRank: 2 },
  error: { ringsSidebar: true, pushes: true, attentionRank: 1 },
  disconnected: { ringsSidebar: false, pushes: false, attentionRank: 6 },
};

/** Returns the UX policy for a status. */
export function statusPolicy(status: Status): StatusPolicy {
  return STATUS_POLICY[status];
}

/** True if a transition INTO `status` should fire a Web Push (FR-ST4). */
export function shouldNotify(status: Status): boolean {
  return STATUS_POLICY[status].pushes;
}

/** True if `status` should ring/highlight the session in the sidebar. */
export function ringsSidebar(status: Status): boolean {
  return STATUS_POLICY[status].ringsSidebar;
}

/**
 * Live (non-terminal, connected) states. `done`/`error` are terminal and
 * `disconnected` is orchestrator-derived.
 */
export const LIVE_STATES = ['starting', 'running', 'awaiting_input', 'idle'] as const;

function isLive(s: Status): boolean {
  return (LIVE_STATES as readonly Status[]).includes(s);
}

/**
 * Allowed status transitions.
 *
 * The status model is deliberately permissive — agents are noisy and the
 * orchestrator may derive `disconnected` from any state — but a few moves are
 * nonsensical and are rejected so a buggy translator cannot, e.g., resurrect a
 * terminated session into `running` without first reconciling.
 *
 * Rules:
 *  - Self-transitions are always allowed (idempotent re-assertion).
 *  - `disconnected` may be entered from ANY state (SSH/tunnel down).
 *  - From `disconnected` you may reconcile back to ANY state (re-attach +
 *    ground-truth probe, spec §7.2).
 *  - `done`/`error` are terminal: the only exit is `disconnected`.
 *  - From any live state you may move to any other live state, plus `done`,
 *    `error`, or `disconnected`.
 */
export function canTransition(from: Status, to: Status): boolean {
  if (from === to) return true;
  if (to === 'disconnected') return true;
  if (from === 'disconnected') return true;
  if (from === 'done' || from === 'error') return false;
  if (isLive(from)) return isLive(to) || to === 'done' || to === 'error';
  return false;
}

/**
 * Applies a transition, returning the next status. Throws if the transition is
 * not allowed (defensive; callers on the hot path should prefer
 * `canTransition` and decide their own policy on rejection).
 */
export function transition(from: Status, to: Status): Status {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal status transition: ${from} -> ${to}`);
  }
  return to;
}

/**
 * Comparator for "needs attention" sidebar ordering (FR-ST6, FR-UI3).
 * Sorts awaiting_input and error to the top.
 */
export function compareByAttention(a: Status, b: Status): number {
  return STATUS_POLICY[a].attentionRank - STATUS_POLICY[b].attentionRank;
}
