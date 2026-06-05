/**
 * US-22 — the Web Push trigger predicate (spec §7 table, FR-ST4).
 *
 * A transition INTO a status fires an away-from-keyboard Web Push ONLY for the
 * three "you are needed / it is over" states:
 *   - `awaiting_input` — the money state: an agent is blocked on YOU
 *   - `done`           — the agent finished
 *   - `error`          — the agent failed
 * Every other transition (`starting`, `running`, `idle`, `disconnected`) is
 * NOTfied — it does not pull the user back to their phone (spec §7 table).
 *
 * The single source of truth for this policy is `@flock/shared`'s
 * `STATUS_POLICY[status].pushes` (surfaced as `shouldNotify`). We deliberately
 * REUSE it here rather than re-encode the predicate, so the orchestrator's push
 * trigger can never drift from the shared status model the UI sidebar also
 * reads. `should-notify.test.ts` exhaustively pins every StatusEnum value so a
 * new status cannot silently slip through unhandled.
 */
import { shouldNotify, type Status } from '@flock/shared';

/**
 * True iff a transition INTO `status` should send a Web Push (FR-ST4).
 *
 * Thin, named alias over the shared `shouldNotify` so call sites in the push
 * module read intention-first ("should we send a push?") and the dependency on
 * the shared status policy stays explicit and singular.
 */
export function shouldSendPush(status: Status): boolean {
  return shouldNotify(status);
}
