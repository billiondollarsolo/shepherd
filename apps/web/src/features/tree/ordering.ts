/**
 * "Needs attention" ordering for the session tree (US-23, FR-ST6, FR-UI3).
 *
 * The status-bearing tree is the single most important Codex-parity behavior
 * (spec Appendix A.4): the sessions that need the user float to the top. We reuse
 * the shared, app-agnostic `compareByAttention` comparator (`@flock/shared`,
 * status.ts) so the ranking (awaiting_input, then error, then the rest) is never
 * duplicated and stays in lockstep with the orchestrator + Web Push policy.
 *
 * Pure + DOM-free so it unit-tests under `pnpm test:unit` without jsdom.
 */
import { compareByAttention, ringsSidebar, statusPolicy, type Status } from '@flock/shared';

/** Minimal shape needed to order a session in the tree. */
export interface OrderableSession {
  /** The single authoritative session id (spec §4.2). */
  readonly id: string;
  /** Live status (from the in-memory map fanned out over the `status` WS). */
  readonly status: Status;
}

/**
 * Stable sort of sessions by "needs attention" (FR-ST6/FR-UI3).
 *
 * `awaiting_input` sorts first, then `error`, then `done`, `idle`, `starting`,
 * `running`, and finally `disconnected` — exactly the shared
 * `STATUS_POLICY.attentionRank` ordering. Ties (same status) preserve input
 * order (`Array.prototype.sort` is stable on modern engines), so a caller may
 * pre-sort by name/recency and trust that secondary order to survive.
 *
 * Returns a NEW array; the input is not mutated.
 */
export function sortSessionsByAttention<T extends OrderableSession>(sessions: readonly T[]): T[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const byAttention = compareByAttention(a.session.status, b.session.status);
      return byAttention !== 0 ? byAttention : a.index - b.index;
    })
    .map((entry) => entry.session);
}

/**
 * True when ANY session in the group needs attention (`awaiting_input`/`error`).
 * Drives the "this branch has something for you" cue on collapsed Node/Project
 * rows so the user sees it without expanding (FR-UI3). Derives from the shared
 * `ringsSidebar()` policy so a collapsed branch rings for EXACTLY the same states
 * a single session does — the policy is never re-decided here.
 */
export function groupNeedsAttention(sessions: readonly OrderableSession[]): boolean {
  return sessions.some((s) => ringsSidebar(s.status));
}

/**
 * How many sessions in the group need attention — the per-branch "N need you"
 * rollup shown on a Node header so the count is visible without expanding
 * (FR-UI3). Counts exactly the `ringsSidebar()` states (awaiting_input/error).
 */
export function groupAttentionCount(sessions: readonly OrderableSession[]): number {
  let count = 0;
  for (const s of sessions) if (ringsSidebar(s.status)) count += 1;
  return count;
}

/**
 * The single MOST-URGENT needs-you status in the group (by
 * `STATUS_POLICY.attentionRank`: `awaiting_input` outranks `error`), or `null`
 * when nothing rings. Colours the pulsing dot on a collapsed Node/Project header
 * so it reads identically to the top session inside the branch (FR-UI3). Only
 * ever returns a `ringsSidebar()` status — the collapsed cue and the expanded
 * session dot are the same signal.
 */
export function groupAttentionStatus(sessions: readonly OrderableSession[]): Status | null {
  let best: Status | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const s of sessions) {
    if (!ringsSidebar(s.status)) continue;
    const rank = statusPolicy(s.status).attentionRank;
    if (rank < bestRank) {
      bestRank = rank;
      best = s.status;
    }
  }
  return best;
}

/**
 * The attention rank of a whole branch (Node or Project), for US-32's
 * "supervision dashboard" ordering (FR-UI3): a branch is ranked by its single
 * most-urgent session, so the Node/Project that needs the user bubbles to the
 * top of the tree exactly like an individual session does.
 *
 * Returns the BEST (lowest) `STATUS_POLICY.attentionRank` among the branch's
 * sessions — the same scale as `compareByAttention`. An empty branch ranks
 * below everything (`+Infinity`): there is nothing to supervise there.
 */
export function groupAttentionRank(sessions: readonly OrderableSession[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const s of sessions) {
    const rank = statusPolicy(s.status).attentionRank;
    if (rank < best) best = rank;
  }
  return best;
}

/**
 * Stable sort of branches (Nodes or Projects) by "needs attention" so the whole
 * tree reads as a "which agent needs me" dashboard (US-32, FR-UI3). Each branch
 * is ranked by `groupAttentionRank` over its sessions (extracted via
 * `sessionsOf`); ties preserve input order so the tree's spatial layout stays
 * stable when nothing is urgent.
 *
 * Returns a NEW array; the input is not mutated.
 */
export function sortGroupsByAttention<T>(
  groups: readonly T[],
  sessionsOf: (group: T) => readonly OrderableSession[],
): T[] {
  return groups
    .map((group, index) => ({ group, index, rank: groupAttentionRank(sessionsOf(group)) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index))
    .map((entry) => entry.group);
}
