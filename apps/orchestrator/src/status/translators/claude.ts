/**
 * US-16 — Claude Code status translator (spec §7.1, PRD §7.1).
 *
 * A PURE, framework-free function mapping a recorded Claude Code hook payload to
 * the unified {@link Status} (StatusEnum, `@flock/shared`). This is the
 * first-class, exhaustively tested per-agent translator the hook dispatcher
 * (`hooks/translate.ts`) delegates to; the contract is pinned by the
 * recorded-fixture test `claude.test.ts`.
 *
 * Source → status mapping (spec §7.1 Claude column):
 *
 *   SessionStart                    -> starting
 *   PreToolUse                      -> running
 *   PostToolUse (exit 0 / no code)  -> running
 *   PostToolUse (nonzero exit code) -> error
 *   Notification:permission_prompt  -> awaiting_input   (the money state, FR-ST4)
 *   Notification:idle_prompt        -> idle
 *   Stop                            -> idle   (turn complete; `done` = session end)
 *   StopFailure                     -> error
 *
 * `disconnected` is NOT produced here — it is orchestrator-derived (SSH/tunnel
 * down, spec §7.1). An unrecognized / malformed event returns `null` ("no
 * transition"): the hook endpoint still acks (202) and still logs the raw event
 * (NFR-PERF1), it simply does not mutate the live status map.
 *
 * The payload is validated against the single source of truth — the shared
 * `ClaudeHookPayload` zod schema — so the mapping is never driven by a
 * duplicated shape (type-sharing non-negotiable).
 */
import { ClaudeHookPayload, type AgentType, type Status } from '@flock/shared';

/** A derived live-status transition. `null` means the event maps to nothing. */
export interface ClaudeTransition {
  readonly status: Status;
  /** Optional human-facing detail (e.g. the tool name, or the prompt kind). */
  readonly detail: string | null;
}

/** The agent_type this translator handles (matches the dispatcher's switch). */
export const CLAUDE_AGENT_TYPE: AgentType = 'claude-code';

/**
 * Translate a raw Claude Code hook payload into a unified status transition, or
 * `null` if the event maps to no transition. Pure: no IO, no DB, no throw.
 *
 * @param body the raw agent event JSON (validated against `ClaudeHookPayload`).
 */
/**
 * Classify a Claude `Notification` from its message text when the structured
 * subtype isn't on the body (current Claude carries the subtype as the hook
 * matcher). Permission/approval phrasing -> the money state; "waiting for your
 * input" / idle phrasing -> soft idle; anything else -> ambiguous (null).
 */
function classifyNotification(
  message?: string | null,
): 'permission_prompt' | 'idle_prompt' | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes('permission') || m.includes('approve') || m.includes('wants to')) {
    return 'permission_prompt';
  }
  if (m.includes('waiting for your input') || m.includes('idle')) {
    return 'idle_prompt';
  }
  return null;
}

export function translateClaudeHook(body: unknown): ClaudeTransition | null {
  const parsed = ClaudeHookPayload.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data;

  switch (e.hook_event_name) {
    case 'SessionStart':
      // Booted + ready (waiting for you) = idle, NOT starting. A launched agent you
      // haven't prompted fires ONLY SessionStart, so 'starting' left it stuck
      // "starting" forever; idle reflects "ready".
      return { status: 'idle', detail: null };

    case 'PreToolUse':
      return { status: 'running', detail: e.tool_name ?? null };

    case 'PostToolUse':
      // A nonzero tool exit code is a failure (spec §7.1: nonzero PostToolUse
      // -> error). Exit 0, or an absent code, is normal tool progress.
      if (typeof e.tool_response_exit_code === 'number' && e.tool_response_exit_code !== 0) {
        return { status: 'error', detail: e.tool_name ?? null };
      }
      return { status: 'running', detail: e.tool_name ?? null };

    case 'PostToolUseFailure':
      return { status: 'error', detail: e.tool_name ?? null };

    case 'Notification': {
      // The notification subtype distinguishes the money state (a permission
      // prompt blocking on the user) from soft idle. Current Claude Code delivers
      // the subtype as the hook MATCHER, not reliably as a body field — so derive
      // it from `notification_type` if present, ELSE from the message text (robust
      // across versions: e.g. "Claude needs your permission…" vs "…waiting for
      // your input"). Without a recognized signal it's ambiguous -> no transition.
      const kind = e.notification_type ?? classifyNotification(e.message);
      if (kind === 'permission_prompt') {
        return { status: 'awaiting_input', detail: 'permission_prompt' };
      }
      if (kind === 'idle_prompt') {
        return { status: 'idle', detail: 'idle_prompt' };
      }
      return null;
    }

    case 'Stop':
      // Turn complete = idle (calm), NOT done: `done` is reserved for actual
      // session end (SessionEnd / the PTY-exit path), so a Web Push fires when an
      // agent needs you / errors / ENDS — not on every turn. Consistent everywhere.
      return { status: 'idle', detail: null };

    case 'StopFailure':
      return { status: 'error', detail: null };

    case 'SessionEnd':
      // A genuine session end (the user ran out / cleared / logged out) -> done,
      // which fires the "session finished" Web Push.
      return { status: 'done', detail: null };

    default:
      return null;
  }
}
