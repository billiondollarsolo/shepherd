/**
 * Roadmap F5 — the canonical agent runtime-event taxonomy.
 *
 * One normalized vocabulary that EVERY transport projects into — the raw-PTY
 * status path today, and the structured ACP/SDK transport (F6) next. Modeled on
 * Synara's `ProviderRuntimeEvent` union (`synara/packages/contracts/src/
 * providerRuntime.ts`): session/turn lifecycle, streamed content (assistant vs
 * reasoning vs plan vs command output), tool calls, token usage, plan/tasks,
 * approval + user-input requests, and errors. Each event keeps an optional `raw`
 * pointer back to its source payload.
 *
 * The existing unified {@link Status} is DERIVABLE from this union — see
 * {@link agentEventToStatus} — so adopting it is additive, not a rewrite: the
 * chat view (P3), the control plane (P1/P2), and telemetry all consume this one
 * stream.
 */
import { z } from 'zod';
import type { Status } from './status.js';

/** Which logical stream a content delta belongs to. */
export const ContentStreamKind = z.enum([
  'assistant_text',
  'reasoning_text',
  'plan_text',
  'command_output',
  'user_text',
]);
export type ContentStreamKind = z.infer<typeof ContentStreamKind>;

/** A tool call's lifecycle state. */
export const AgentToolStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);
export type AgentToolStatus = z.infer<typeof AgentToolStatus>;

/** A plan/todo item (matches the existing PlanItem shape). */
export const AgentPlanItem = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type AgentPlanItem = z.infer<typeof AgentPlanItem>;

/**
 * One hunk of a unified diff (Claude's `structuredPatch` entry). All fields are
 * optional so a partial/absent hunk still validates (graceful degradation).
 */
export const DiffHunk = z.object({
  oldStart: z.number().optional(),
  oldLines: z.number().optional(),
  newStart: z.number().optional(),
  newLines: z.number().optional(),
  lines: z.array(z.string()).optional(),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

/** Fields every event carries: the session it belongs to + an optional raw source. */
const base = { sessionId: z.string(), raw: z.unknown().optional() };

/**
 * The canonical runtime event. A discriminated union on `kind` so consumers get
 * exhaustive type-narrowing.
 */
export const AgentEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session.started'), ...base }),
  z.object({ kind: z.literal('session.ended'), reason: z.string().optional(), ...base }),

  z.object({ kind: z.literal('turn.started'), ...base }),
  z.object({ kind: z.literal('turn.completed'), ...base }),
  z.object({ kind: z.literal('turn.aborted'), ...base }),

  z.object({
    kind: z.literal('content.delta'),
    streamKind: ContentStreamKind,
    text: z.string(),
    ...base,
  }),

  z.object({
    kind: z.literal('tool.started'),
    toolId: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    /** The tool's args object (e.g. {file_path, content} or {command}); opaque. */
    toolInput: z.unknown().optional(),
    ...base,
  }),
  z.object({
    kind: z.literal('tool.updated'),
    toolId: z.string(),
    status: AgentToolStatus,
    /** The tool result's text output, when the transport carries it. */
    toolOutput: z.string().optional(),
    /** Claude's structuredPatch (unified-diff hunks), when present. */
    toolDiff: z.array(DiffHunk).optional(),
    ...base,
  }),

  z.object({ kind: z.literal('plan.updated'), items: z.array(AgentPlanItem), ...base }),

  // The agent's DYNAMIC slash-command catalog (Claude stream-json `init`).
  z.object({ kind: z.literal('commands.updated'), commands: z.array(z.string()), ...base }),

  z.object({
    kind: z.literal('usage.updated'),
    model: z.string().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    contextWindow: z.number().optional(),
    ...base,
  }),

  // The "money state": the agent is blocked waiting on the user (approval / input).
  z.object({
    kind: z.literal('request.opened'),
    requestId: z.string(),
    requestKind: z.enum(['permission', 'input']),
    title: z.string().optional(),
    ...base,
  }),
  z.object({ kind: z.literal('request.resolved'), requestId: z.string(), ...base }),

  z.object({ kind: z.literal('error'), message: z.string(), ...base }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/**
 * Project a canonical event onto the unified {@link Status}, or `null` for a
 * telemetry-only event (no status change). This is the bridge that lets the
 * structured transport feed the existing status map unchanged.
 */
export function agentEventToStatus(event: AgentEvent): Status | null {
  switch (event.kind) {
    case 'session.started':
      return 'starting';
    case 'turn.started':
    case 'content.delta':
    case 'tool.started':
      return 'running';
    case 'request.opened':
      return 'awaiting_input';
    case 'turn.completed':
    case 'turn.aborted':
      return 'idle';
    case 'request.resolved':
      // The block cleared; the agent resumes work.
      return 'running';
    case 'session.ended':
      return 'done';
    case 'error':
      return 'error';
    // Telemetry-only — no status transition.
    case 'tool.updated':
    case 'plan.updated':
    case 'usage.updated':
    case 'commands.updated':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Wire contract — the `agentEventRaw` shapes agentd POSTs to the hook endpoint
// and the web `chatTimeline` reads back verbatim. These are DISTINCT from the
// canonical {@link AgentEvent} union above: they carry NO `sessionId` (the URL
// path segment identifies the session) and are stored opaquely as `jsonb`.
// Typed here so producers (agentd contract mirror) and the web consumer agree
// on the EXACT shapes. All are `.passthrough()` + optional so a missing field
// renders what's there and never drops the event.
// ---------------------------------------------------------------------------

/** EXISTING transcript path: a whole user/assistant/tool message. */
export const ChatEventRaw = z
  .object({
    chat: z.object({
      role: z.string(),
      text: z.string(),
    }),
  })
  .passthrough();
export type ChatEventRaw = z.infer<typeof ChatEventRaw>;

/** A tool call started: name/title + the tool's args object. */
export const ToolStartedEventRaw = z
  .object({
    kind: z.literal('tool.started'),
    toolId: z.string(),
    title: z.string(),
    toolInput: z.unknown().optional().nullable(),
  })
  .passthrough();
export type ToolStartedEventRaw = z.infer<typeof ToolStartedEventRaw>;

/** A tool call finished: terminal status + optional result text and diff. */
export const ToolUpdatedEventRaw = z
  .object({
    kind: z.literal('tool.updated'),
    toolId: z.string(),
    status: z.enum(['completed', 'error', 'in_progress']),
    toolOutput: z.string().optional().nullable(),
    toolDiff: z.array(DiffHunk).optional().nullable(),
  })
  .passthrough();
export type ToolUpdatedEventRaw = z.infer<typeof ToolUpdatedEventRaw>;

/** The agent's dynamic slash-command catalog (Claude stream-json `init`). */
export const CommandsUpdatedEventRaw = z
  .object({
    kind: z.literal('commands.updated'),
    commands: z.array(z.string()),
  })
  .passthrough();
export type CommandsUpdatedEventRaw = z.infer<typeof CommandsUpdatedEventRaw>;

/**
 * The full set of `agentEventRaw` shapes the hook endpoint stores. A parse
 * helper rather than a strict gate — the endpoint accepts ANY object (schema
 * drift never drops an event); this is for typed producers/consumers.
 */
export const AgentEventRaw = z.union([
  ChatEventRaw,
  ToolStartedEventRaw,
  ToolUpdatedEventRaw,
  CommandsUpdatedEventRaw,
]);
export type AgentEventRaw = z.infer<typeof AgentEventRaw>;
