/**
 * Gemini CLI status translator (spec §7.1).
 *
 * A PURE function mapping a Gemini CLI hook event to the unified {@link Status}.
 * Gemini CLI (v0.26.0+) ships Claude-Code-style lifecycle hooks configured in
 * `~/.gemini/settings.json` under a `hooks` block, delivering a JSON payload on
 * stdin with `hook_event_name` (+ `tool_name`, etc.). Shepherd seeds those hooks
 * (config-injection `gemini` case) and forwards each to `POST /api/hooks/:id`;
 * this translator derives the status — replacing the old PTY-activity heuristic
 * (which couldn't tell idle from awaiting_input).
 *
 * Source → status mapping:
 *   SessionStart                 -> starting
 *   BeforeAgent                  -> running   (the agent turn began)
 *   BeforeModel / AfterModel     -> running
 *   BeforeTool / AfterTool       -> running   (detail = the tool name)
 *   Notification                 -> awaiting_input   (tool-permission alert, FR-ST4)
 *   AfterAgent                   -> idle      (turn complete; done = session end)
 *   SessionEnd                   -> done
 *   (PreCompress / BeforeToolSelection -> no transition)
 *
 * `disconnected` is orchestrator-derived. An unrecognized/malformed event returns
 * `null` (no transition). Doc-based until validated against a live authed gemini —
 * the schema tolerates both `hook_event_name`/`hookEventName` field casings.
 */
import { GeminiHookPayload, type AgentType, type Status } from '@flock/shared';

export interface GeminiTransition {
  readonly status: Status | null;
  readonly detail: string | null;
}

/** The agent_type this translator handles (matches the dispatcher's switch). */
export const GEMINI_AGENT_TYPE: AgentType = 'gemini';

export function translateGeminiHook(body: unknown): GeminiTransition | null {
  const parsed = GeminiHookPayload.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data;

  const name = e.hook_event_name ?? e.hookEventName;
  if (!name) return null;
  const tool = e.tool_name ?? e.toolName ?? null;

  switch (name) {
    case 'SessionStart':
      // Booted + ready = idle, not starting (else a launched-idle agent sticks).
      return { status: 'idle', detail: null };

    case 'BeforeAgent':
    case 'BeforeModel':
    case 'AfterModel':
      return { status: 'running', detail: null };

    case 'BeforeTool':
    case 'AfterTool':
      return { status: 'running', detail: tool };

    case 'Notification':
      // The money state: a tool-permission prompt blocking on the user (FR-ST4).
      return { status: 'awaiting_input', detail: e.message ?? null };

    case 'AfterAgent':
      // Turn complete = idle (calm); `done` is reserved for session end.
      return { status: 'idle', detail: null };

    case 'SessionEnd':
      return { status: 'done', detail: null };

    default:
      // BeforeToolSelection / PreCompress — no meaningful status transition.
      return null;
  }
}
