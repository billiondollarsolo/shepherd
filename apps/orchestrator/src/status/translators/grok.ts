/**
 * Grok status translator (xAI Grok Build CLI).
 *
 * A PURE, framework-free function mapping a recorded Grok hook event to the
 * unified {@link Status}. Analogous to the Claude/Codex/OpenCode translators; the
 * hook dispatcher (`hooks/translate.ts`) delegates here by `agent_type`.
 *
 * Grok fires Claude-Code-compatible lifecycle hooks (it scans the claude/cursor
 * hook sources), but with its OWN payload shape — camelCase fields, snake_case
 * event-name values — so it needs its own mapping. Flock receives these via the
 * same per-session hook forwarder as the other agents.
 *
 *   session_start                  -> idle             (booted + ready for you)
 *   pre_tool_use                   -> running          (detail = the tool name)
 *   post_tool_use (success)        -> running          (detail = the tool name)
 *   post_tool_use (failure)        -> error
 *   stop                           -> idle   (turn complete; `done` = session end)
 *   notification (xai_session …)   -> (status: null)   recognized meta → NO
 *                                     transition, and NOT logged (high-churn:
 *                                     Grok emits a hook-execution notification
 *                                     for every hook it runs).
 *
 * An unrecognized / malformed event returns `null` ("no transition") and IS
 * logged as a raw event for debugging.
 */
import { GrokHookPayload, type AgentType, type Status } from '@flock/shared';

/** A derived live transition. `status: null` = recognized but no transition. */
export interface GrokTransition {
  readonly status: Status | null;
  readonly detail: string | null;
}

/** The agent_type this translator handles (matches the dispatcher's switch). */
export const GROK_AGENT_TYPE: AgentType = 'grok';

/** True when a post_tool_use event reports a failed tool (permissive across versions). */
function toolFailed(e: { success?: boolean; exitCode?: number; exit_code?: number }): boolean {
  if (e.success === false) return true;
  const code = e.exitCode ?? e.exit_code;
  return typeof code === 'number' && code !== 0;
}

/**
 * Normalize a grok event name to canonical snake_case. Grok emitted snake_case
 * values on the build we validated (2026-06-04), but the xAI docs use PascalCase;
 * this collapses both (`PreToolUse` → `pre_tool_use`) so the switch is build-agnostic.
 */
function normalizeGrokEvent(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Translate a raw Grok hook event into a unified status transition, or `null` if
 * the event maps to nothing. Pure: no IO, no DB, no throw.
 */
export function translateGrokHook(body: unknown): GrokTransition | null {
  const parsed = GrokHookPayload.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data;

  // Accept either field name + either casing (see schema note); normalize to snake.
  const raw = e.hookEventName ?? e.hook_event_name;
  if (!raw) return null;
  const name = normalizeGrokEvent(raw);
  const tool = e.toolName ?? e.tool_name ?? null;

  switch (name) {
    case 'session_start':
      // Booted + ready (waiting for you) = idle, NOT starting. A launched agent
      // you haven't prompted only fires session_start; 'starting' left it stuck
      // until the first tool. Matches Claude/Gemini SessionStart → idle.
      return { status: 'idle', detail: null };
    case 'pre_tool_use':
      return { status: 'running', detail: tool };
    case 'post_tool_use':
      return toolFailed(e)
        ? { status: 'error', detail: tool }
        : { status: 'running', detail: tool };
    case 'post_tool_use_failure':
      return { status: 'error', detail: tool };
    case 'stop':
      // Turn complete = idle (calm), not done — done is reserved for session end
      // (SessionEnd / PTY exit), so Web Push fires on needs-you/error/end, not turn.
      return { status: 'idle', detail: null };
    case 'session_end':
      return { status: 'done', detail: null };
    case 'notification':
      // Grok emits a hook-execution notification (notificationType "xai_session")
      // for every hook it runs — pure meta. Recognize it (status: null) so the
      // endpoint drops it from the timeline + event log instead of treating it as
      // an unknown event.
      return { status: null, detail: null };
    default:
      return null;
  }
}
