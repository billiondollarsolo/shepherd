/**
 * Shared session-ordering helpers so the sidebar, the top tabs, and the grid
 * panes all show a project's sessions in the SAME order — the user's manual
 * drag-set order (from the paddock store), with any sessions not yet in that
 * order (freshly created) falling to the end by creation time.
 */
import type { Session } from '@flock/shared';

/** dataTransfer MIME for session drag-reorder (distinct from file/path drops). */
export const SESSION_DND = 'application/x-flock-session';

/**
 * Sort a project's sessions by the user's manual order; unordered sessions go
 * last, oldest-first (so a new terminal appends to the right / bottom). Pure +
 * non-mutating.
 */
export function orderSessions(list: Session[], orderedIds: readonly string[] | undefined): Session[] {
  const idx = new Map((orderedIds ?? []).map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ai = idx.has(a.id) ? idx.get(a.id)! : Number.POSITIVE_INFINITY;
    const bi = idx.has(b.id) ? idx.get(b.id)! : Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Return a new id list with `fromId` moved to `toId`'s position (inserted before
 * it). Used on drop to compute the project's new manual order from the currently
 * displayed order. No-op if either id is missing or they're the same.
 */
export function moveBefore(ids: string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return ids;
  const arr = ids.filter((id) => id !== fromId);
  const to = arr.indexOf(toId);
  if (to < 0 || !ids.includes(fromId)) return ids;
  arr.splice(to, 0, fromId);
  return arr;
}
