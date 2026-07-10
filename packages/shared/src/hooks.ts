import { z } from 'zod';
import { AgentTypeEnum } from './domain.js';

/**
 * Agent hook payload schemas + the hook callback contract (spec §7.1, §8.1).
 *
 * `POST /api/hooks/:sessionId` is the ONE path that must be fast and DB-free on
 * the hot path (spec §15). Auth is the per-session token in the `Authorization`
 * header (NOT a cookie); the body is the agent's raw event JSON. We validate
 * the body loosely (passthrough) so an unexpected field never drops an event —
 * the per-agent translators (orchestrator) consume these shapes to derive
 * StatusEnum.
 */

// ---------------------------------------------------------------------------
// Claude Code (spec §7.1)
//   SessionStart -> starting; PreToolUse/PostToolUse -> running;
//   Notification:permission_prompt -> awaiting_input;
//   Notification:idle_prompt -> idle; Stop -> done;
//   StopFailure / nonzero PostToolUse -> error.
// ---------------------------------------------------------------------------

export const ClaudeHookEventNameEnum = z.enum([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure', // real event in current Claude Code (we also detect via exit code)
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd', // genuine session end -> done (current Claude Code)
]);
export type ClaudeHookEventName = z.infer<typeof ClaudeHookEventNameEnum>;

/** Sub-kind for the Notification event (drives awaiting_input vs idle). */
export const ClaudeNotificationKindEnum = z.enum(['permission_prompt', 'idle_prompt']);
export type ClaudeNotificationKind = z.infer<typeof ClaudeNotificationKindEnum>;

export const ClaudeHookPayload = z
  .object({
    hook_event_name: ClaudeHookEventNameEnum,
    session_id: z.string().optional(),
    notification_type: ClaudeNotificationKindEnum.optional(),
    /** Notification body text — current Claude carries the subtype here (the
     *  structured kind is the hook matcher), so we classify from it as a fallback. */
    message: z.string().optional(),
    /** Present on PostToolUse; nonzero => error. */
    tool_response_exit_code: z.number().int().optional(),
    tool_name: z.string().optional(),
  })
  .passthrough();
export type ClaudeHookPayload = z.infer<typeof ClaudeHookPayload>;

// ---------------------------------------------------------------------------
// Codex (spec §7.1)
//   PreToolUse/PostToolUse -> running; PermissionRequest -> awaiting_input;
//   turn-complete+quiet -> idle; Stop -> done; PostToolUse failure -> error.
// ---------------------------------------------------------------------------

export const CodexHookEventNameEnum = z.enum([
  // Current Codex hook events (Claude-compatible naming):
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest', // the approval / awaiting-input signal
  'Stop', // turn complete
  'SessionEnd',
  // Legacy/guessed name kept for tolerance:
  'TurnComplete',
]);
export type CodexHookEventName = z.infer<typeof CodexHookEventNameEnum>;

export const CodexHookPayload = z
  .object({
    // Current Codex delivers `hook_event_name` + `tool_name` (Claude-compatible);
    // `event`/`tool` were guessed names — accept EITHER so the parser is robust to
    // whichever the installed codex build emits.
    hook_event_name: CodexHookEventNameEnum.optional(),
    event: CodexHookEventNameEnum.optional(),
    session_id: z.string().optional(),
    /** Present on PostToolUse; false/nonzero => error. */
    success: z.boolean().optional(),
    exit_code: z.number().int().optional(),
    tool_name: z.string().optional(),
    tool: z.string().optional(),
  })
  .passthrough();
export type CodexHookPayload = z.infer<typeof CodexHookPayload>;

// ---------------------------------------------------------------------------
// OpenCode (spec §7.1)
//   plugin events: session.idle; permission/question -> awaiting_input;
//   error -> error; completion -> done.
// ---------------------------------------------------------------------------

export const OpenCodeHookEventNameEnum = z.enum([
  // CURRENT OpenCode bus event names (verified against the SDK Event union):
  'session.created',
  'session.idle', // turn-complete (there is no separate completion event)
  'session.error',
  'permission.updated', // the approval/awaiting-input signal
  'tool.execute.before',
  'tool.execute.after',
  'todo.updated', // plan/todo artifact (analog of Claude TodoWrite / codex update_plan)
  // Telemetry-bearing events (no status transition): the assistant message and
  // session objects carry `properties.info` with modelID + token usage + cost.
  'message.updated',
  'session.updated',
  // Legacy/guessed names kept for tolerance across versions (harmless if unused):
  'session.start',
  'session.complete',
  'permission.request',
  'question.ask',
]);
export type OpenCodeHookEventName = z.infer<typeof OpenCodeHookEventNameEnum>;

export const OpenCodeHookPayload = z
  .object({
    type: OpenCodeHookEventNameEnum,
    sessionID: z.string().optional(),
    properties: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type OpenCodeHookPayload = z.infer<typeof OpenCodeHookPayload>;

// ---------------------------------------------------------------------------
// Grok (xAI Grok Build CLI). Grok fires Claude-Code-compatible lifecycle hooks
// but with its OWN payload shape: camelCase fields (`hookEventName`, `toolName`,
// `toolInput`, `toolUseId`) and snake_case event-name VALUES. It reaches Flock's
// hook endpoint via the same per-session forwarder the claude/opencode hooks use.
//   session_start -> idle (ready); pre_tool_use/post_tool_use -> running;
//   stop -> idle; session_end -> done; notification (xai_session) ignored.
// ---------------------------------------------------------------------------

export const GrokHookEventNameEnum = z.enum([
  // snake_case values — EMPIRICALLY observed on the live grok build (2026-06-04):
  'session_start',
  'pre_tool_use',
  'post_tool_use',
  'post_tool_use_failure',
  'stop',
  'notification',
  'session_end',
  // PascalCase values — current xAI docs convention (tolerated so either build works):
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'Notification',
  'SessionEnd',
]);
export type GrokHookEventName = z.infer<typeof GrokHookEventNameEnum>;

export const GrokHookPayload = z
  .object({
    // Accept BOTH the camelCase field (observed) and snake_case `hook_event_name`
    // (Claude-compatible / docs), with either snake_case or PascalCase VALUES — the
    // translator normalizes. This makes the parser robust to whichever the installed
    // grok build emits (see the snake-vs-Pascal uncertainty in the integration audit).
    hookEventName: GrokHookEventNameEnum.optional(),
    hook_event_name: GrokHookEventNameEnum.optional(),
    /** The tool being run (pre/post_tool_use), e.g. "run_terminal_command". */
    toolName: z.string().optional(),
    tool_name: z.string().optional(),
    /** Sub-kind for `notification` (e.g. "xai_session" = internal meta noise). */
    notificationType: z.string().optional(),
    notification_type: z.string().optional(),
    /** Present on post_tool_use; nonzero/false signals a failed tool. */
    exitCode: z.number().int().optional(),
    exit_code: z.number().int().optional(),
    success: z.boolean().optional(),
  })
  .passthrough();
export type GrokHookPayload = z.infer<typeof GrokHookPayload>;

// ---------------------------------------------------------------------------
// Gemini CLI (Google). Gemini CLI v0.26.0+ ships Claude-Code-style lifecycle
// hooks (settings.json `hooks` block, stdin-JSON delivery). Events:
//   SessionStart -> starting; Before/After Agent/Model + tools -> running;
//   Notification (tool-permission alert) -> awaiting_input; AfterAgent -> idle;
//   SessionEnd -> done.  (Doc-based; validate field casing on a live authed gemini.)
// ---------------------------------------------------------------------------

export const GeminiHookEventNameEnum = z.enum([
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeModel',
  'AfterModel',
  'BeforeTool',
  'BeforeToolSelection',
  'AfterTool',
  'Notification',
  'PreCompress',
]);
export type GeminiHookEventName = z.infer<typeof GeminiHookEventNameEnum>;

export const GeminiHookPayload = z
  .object({
    // Gemini delivers `hook_event_name` on stdin; accept the camelCase variant too.
    hook_event_name: GeminiHookEventNameEnum.optional(),
    hookEventName: GeminiHookEventNameEnum.optional(),
    session_id: z.string().optional(),
    tool_name: z.string().optional(),
    toolName: z.string().optional(),
    /** Notification text (alert kind), used to keep awaiting_input precise. */
    message: z.string().optional(),
  })
  .passthrough();
export type GeminiHookPayload = z.infer<typeof GeminiHookPayload>;

/**
 * RAW per-turn telemetry a hook event can carry (distinct from the COMPUTED
 * {@link AgentTelemetry} the UI consumes): the agent's own model id, token total,
 * current context occupancy (prompt size, for context-%), and — when the agent
 * reports it (OpenCode does) — an exact USD cost. The orchestrator turns this
 * into AgentTelemetry (context-% via the model-info table; agent cost preferred
 * over the estimate). Today only OpenCode's message/session events populate it.
 */
export const HookTelemetry = z.object({
  model: z.string().optional(),
  tokens: z.number().optional(),
  contextTokens: z.number().optional(),
  /** The model's exact context-window size, when the agent reports it. Preferred
   *  over the model-info table so the context-% reflects the ACTUAL running model
   *  (e.g. Opus 200k vs Opus-1M) rather than an inferred default. */
  contextLimit: z.number().optional(),
  costUsd: z.number().optional(),
});
export type HookTelemetry = z.infer<typeof HookTelemetry>;

// ---------------------------------------------------------------------------
// Generic / fallback — any JSON object accepted; status derived from OSC/PTY.
// ---------------------------------------------------------------------------

export const GenericHookPayload = z.record(z.unknown());
export type GenericHookPayload = z.infer<typeof GenericHookPayload>;

// ---------------------------------------------------------------------------
// Discriminated union by agent + the hook-endpoint request/response contract.
// ---------------------------------------------------------------------------

/** Tagged hook payload (the `agentType` tag is supplied by the route, not the
 * agent body); useful for translators and recorded contract fixtures. */
export const AgentHookPayload = z.union([
  ClaudeHookPayload,
  CodexHookPayload,
  OpenCodeHookPayload,
  GrokHookPayload,
  GenericHookPayload,
]);
export type AgentHookPayload = z.infer<typeof AgentHookPayload>;

/**
 * Body of `POST /api/hooks/:sessionId`. The agent posts its raw event JSON; we
 * accept any object so the fast path never rejects on schema drift (the
 * translator decides). `agentType` is optional and, when present, lets the
 * orchestrator pick the right translator without a DB lookup.
 */
export const HookCallbackRequest = z
  .object({
    agentType: AgentTypeEnum.optional(),
  })
  .passthrough();
export type HookCallbackRequest = z.infer<typeof HookCallbackRequest>;

/** Hook endpoint acknowledges fast (202); never returns derived status. */
export const HookCallbackResponse = z.object({ ok: z.literal(true) });
export type HookCallbackResponse = z.infer<typeof HookCallbackResponse>;
