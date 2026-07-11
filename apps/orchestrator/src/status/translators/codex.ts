/**
 * US-17 — Codex status translator (spec §7.1, PRD §7.1).
 *
 * A PURE, framework-free function mapping a recorded Codex hook payload to the
 * unified {@link Status} (StatusEnum, `@flock/shared`). Analogous to the Claude
 * translator (US-16): the hook dispatcher (`hooks/translate.ts`) delegates to it
 * by `agent_type`, and the contract is pinned by the recorded-fixture test
 * `codex.test.ts`.
 *
 * Source → status mapping (spec §7.1 Codex column):
 *
 *   PreToolUse                          -> running
 *   PostToolUse (success / exit 0)      -> running
 *   PostToolUse (failure / nonzero exit)-> error
 *   PermissionRequest                   -> awaiting_input   (the money state, FR-ST4)
 *   TurnComplete (turn-complete+quiet)  -> idle
 *   Stop                                -> idle   (turn complete; done = session end)
 *
 * On `TurnComplete` the spec is "turn-complete **+ quiet** -> idle". The quiet
 * timer is an orchestrator concern (it lives in the status engine, not in this
 * pure function — a translator has no clock and does no IO). This translator
 * emits the `idle` candidate for the turn-complete signal; the engine debounces
 * it against subsequent activity. Keeping the timer out of here preserves the
 * function's purity and keeps the contract test deterministic.
 *
 * `disconnected` is NOT produced here — it is orchestrator-derived (SSH/tunnel
 * down, spec §7.1). An unrecognized / malformed event returns `null` ("no
 * transition"): the hook endpoint still acks (202) and still logs the raw event
 * (NFR-PERF1), it simply does not mutate the live status map.
 *
 * The payload is validated against the single source of truth — the shared
 * `CodexHookPayload` zod schema — so the mapping is never driven by a duplicated
 * shape (type-sharing non-negotiable).
 */
import { CodexHookPayload, type AgentType, type Status } from '@flock/shared';

/** A derived live-status transition. `null` means the event maps to nothing. */
export interface CodexTransition {
  readonly status: Status;
  /** Optional human-facing detail (e.g. the tool name, or the prompt kind). */
  readonly detail: string | null;
}

/** The agent_type this translator handles (matches the dispatcher's switch). */
export const CODEX_AGENT_TYPE: AgentType = 'codex';

/**
 * Translate a raw Codex hook payload into a unified status transition, or `null`
 * if the event maps to no transition. Pure: no IO, no DB, no throw.
 *
 * @param body the raw agent event JSON (validated against `CodexHookPayload`).
 */
export function translateCodexHook(body: unknown): CodexTransition | null {
  const parsed = CodexHookPayload.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data;

  // Current Codex uses `hook_event_name`/`tool_name`; older/guessed payloads used
  // `event`/`tool` — accept whichever is present (the schema allows both).
  const name = e.hook_event_name ?? e.event;
  const tool = e.tool_name ?? e.tool ?? null;

  switch (name) {
    case 'SessionStart':
      // Booted + ready = idle, not starting (else a launched-idle agent sticks).
      return { status: 'idle', detail: null };

    case 'UserPromptSubmit':
      return { status: 'running', detail: null };

    case 'PreToolUse':
      return { status: 'running', detail: tool };

    case 'PostToolUse': {
      // A PostToolUse is a failure when the agent reports `success: false` or a
      // nonzero exit code (spec §7.1: PostToolUse failure -> error). Otherwise
      // it is normal tool progress.
      const failed = e.success === false || (typeof e.exit_code === 'number' && e.exit_code !== 0);
      return failed ? { status: 'error', detail: tool } : { status: 'running', detail: tool };
    }

    case 'PostToolUseFailure':
      return { status: 'error', detail: tool };

    case 'PermissionRequest':
      // The money state: Codex is about to ask for approval (FR-ST4).
      return { status: 'awaiting_input', detail: 'permission_request' };

    case 'TurnComplete':
    case 'Stop':
      // Turn complete = idle (calm), not done — consistent with the other agents;
      // `done` is session-end only (SessionEnd / the PTY-exit path).
      return { status: 'idle', detail: null };

    case 'SessionEnd':
      return { status: 'done', detail: null };

    default:
      return null;
  }
}
