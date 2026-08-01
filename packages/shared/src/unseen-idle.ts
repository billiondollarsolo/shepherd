/**
 * Unseen-idle attention metadata (D9).
 *
 * Wire status stays `idle` for turn-complete; this flag drives UI badges /
 * attention lists only. `done` remains session-end only.
 */

/**
 * Compute the next `unseenIdle` flag for a status/focus transition.
 *
 * Rules (D9):
 * - if nextStatus is idle and !focused → true
 * - if focused → false (user has seen the session / "input" path clears via focus)
 * - if next is done/error → false
 * - becoming idle from running while unfocused → true
 * - stay true if already unseen and still idle unfocused
 */
export function nextUnseenIdle(args: {
  prevStatus: string;
  nextStatus: string;
  focused: boolean;
  prevUnseenIdle: boolean;
}): boolean {
  const { nextStatus, focused } = args;

  if (focused) return false;
  if (nextStatus === 'done' || nextStatus === 'error') return false;
  if (nextStatus === 'idle') return true;
  return false;
}
