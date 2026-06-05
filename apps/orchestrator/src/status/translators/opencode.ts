/**
 * US-18 — OpenCode status translator (spec §7.1, PRD §7.1).
 *
 * A PURE, framework-free function mapping a recorded OpenCode plugin event to
 * the unified {@link Status} (StatusEnum, `@flock/shared`). Analogous to the
 * Claude (US-16) and Codex (US-17) translators: the hook dispatcher
 * (`hooks/translate.ts`) delegates to it by `agent_type`, and the contract is
 * pinned by the recorded-fixture test `opencode.test.ts`.
 *
 * OpenCode integrates via a plugin (`.opencode/plugin/`) that subscribes to the
 * OpenCode event bus and POSTs each event to `POST /api/hooks/:sessionId` with
 * the per-session hook token (the Flock plugin template lives at
 * `templates/opencode-plugin/flock.js`). The plugin forwards the raw OpenCode
 * event `{ type, properties }`, which this translator maps to a transition.
 *
 * Source → status mapping (spec §7.1 OpenCode column):
 *
 *   session.created                     -> starting   (was guessed `session.start`)
 *   tool.execute.before                 -> running
 *   tool.execute.after (success)        -> running
 *   tool.execute.after (failure)        -> error
 *   permission.updated                  -> awaiting_input   (money state; was `permission.request`)
 *   session.idle                        -> idle        (turn complete; done = PTY exit)
 *   session.error                       -> error
 *   message.updated / session.updated   -> (telemetry only)
 *
 * `disconnected` is NOT produced here — it is orchestrator-derived (SSH/tunnel
 * down, spec §7.1). An unrecognized / malformed event returns `null` ("no
 * transition"): the hook endpoint still acks (202) and still logs the raw event
 * (NFR-PERF1), it simply does not mutate the live status map.
 *
 * The payload is validated against the single source of truth — the shared
 * `OpenCodeHookPayload` zod schema — so the mapping is never driven by a
 * duplicated shape (type-sharing non-negotiable).
 */
import {
  OpenCodeHookPayload,
  type AgentType,
  type HookTelemetry,
  type Status,
} from '@flock/shared';

/**
 * A derived live transition. `status: null` is a TELEMETRY-ONLY frame (e.g.
 * `message.updated`) — it changes no status but carries `telemetry`. The outer
 * `translateOpenCodeHook` returns `null` when an event maps to nothing at all.
 */
export interface OpenCodeTransition {
  readonly status: Status | null;
  /** Optional human-facing detail (e.g. the tool name, or the prompt kind). */
  readonly detail: string | null;
  /** Raw per-turn telemetry (model/tokens/cost), when the event carries it. */
  readonly telemetry?: HookTelemetry;
}

/** The agent_type this translator handles (matches the dispatcher's switch). */
export const OPENCODE_AGENT_TYPE: AgentType = 'opencode';

/** Reads a string field out of the event's free-form `properties` bag. */
function prop(
  e: { properties?: Record<string, unknown> },
  key: string,
): string | null {
  const v = e.properties?.[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Returns true when a `tool.execute.after` event reports a failure. OpenCode is
 * permissive about how it signals failure across versions, so we honor both an
 * explicit `success: false` flag and a nonzero `exit`/`exitCode` code carried in
 * the event's `properties` bag (spec §7.1: a failed tool -> error).
 */
function toolFailed(e: { properties?: Record<string, unknown> }): boolean {
  const p = e.properties ?? {};
  if (p.success === false) return true;
  const code = p.exit ?? p.exitCode ?? p.exit_code;
  return typeof code === 'number' && code !== 0;
}

/** Reads a finite number out of an arbitrary value, or undefined. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Extract raw telemetry from an OpenCode `message.updated`/`session.updated`
 * event. Both carry `properties.info` — the assistant Message (modelID + cost +
 * `tokens {input,output,reasoning,cache:{read,write}}`) or the Session summary.
 * We read it defensively (shapes drift across OpenCode versions): a missing or
 * malformed field simply yields no telemetry, never a throw.
 *
 *   tokens   = input + output + reasoning + cache.read + cache.write  (turn total)
 *   context  = input + cache.read + cache.write  (prompt the model saw → context-%)
 */
function openCodeTelemetry(e: { properties?: Record<string, unknown> }): HookTelemetry | undefined {
  const info = e.properties?.info;
  if (!info || typeof info !== 'object') return undefined;
  const i = info as Record<string, unknown>;

  // model id: assistant Message uses `modelID`; a Session may nest it in `model`.
  const model =
    (typeof i.modelID === 'string' && i.modelID) ||
    (typeof (i.model as Record<string, unknown>)?.id === 'string'
      ? ((i.model as Record<string, unknown>).id as string)
      : undefined) ||
    undefined;

  const t = (i.tokens ?? {}) as Record<string, unknown>;
  const cache = (t.cache ?? {}) as Record<string, unknown>;
  const input = num(t.input) ?? 0;
  const output = num(t.output) ?? 0;
  const reasoning = num(t.reasoning) ?? 0;
  const cacheRead = num(cache.read) ?? 0;
  const cacheWrite = num(cache.write) ?? 0;

  const tokens = input + output + reasoning + cacheRead + cacheWrite;
  const contextTokens = input + cacheRead + cacheWrite;
  const tel: HookTelemetry = {
    model,
    tokens: tokens > 0 ? tokens : undefined,
    contextTokens: contextTokens > 0 ? contextTokens : undefined,
    costUsd: num(i.cost),
  };
  // Nothing usable → no telemetry frame.
  if (!tel.model && tel.tokens === undefined && tel.costUsd === undefined) return undefined;
  return tel;
}

/**
 * Translate a raw OpenCode plugin event into a unified status transition, or
 * `null` if the event maps to no transition. Pure: no IO, no DB, no throw.
 *
 * @param body the raw OpenCode event JSON (validated against
 *             `OpenCodeHookPayload`).
 */
export function translateOpenCodeHook(body: unknown): OpenCodeTransition | null {
  const parsed = OpenCodeHookPayload.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data;

  switch (e.type) {
    case 'message.updated':
    case 'session.updated': {
      // Telemetry-only: no status change, just model/tokens/cost (when present).
      const telemetry = openCodeTelemetry(e);
      return telemetry ? { status: null, detail: null, telemetry } : null;
    }

    // Session start: current OpenCode emits `session.created`; `session.start` was
    // a guessed name that never fires (kept for tolerance across versions).
    case 'session.created':
    case 'session.start':
      return { status: 'starting', detail: null };

    case 'tool.execute.before':
      return { status: 'running', detail: prop(e, 'tool') };

    case 'tool.execute.after':
      // A failed tool is an error; otherwise it is normal tool progress
      // (spec §7.1: a failed tool -> error).
      return toolFailed(e)
        ? { status: 'error', detail: prop(e, 'tool') }
        : { status: 'running', detail: prop(e, 'tool') };

    // The money state (FR-ST4): the agent is blocked waiting on the user. Current
    // OpenCode fires `permission.updated` (the spread Permission object — `type`/
    // `title` describe it); `permission.request`/`question.ask` were guessed names.
    case 'permission.updated':
    case 'permission.request':
    case 'question.ask':
      return { status: 'awaiting_input', detail: prop(e, 'title') ?? prop(e, 'type') ?? e.type };

    // Turn complete = idle (calm model; OpenCode has no separate completion event
    // — `session.idle` IS turn-complete). `done` is session-end (PTY-exit path).
    case 'session.idle':
      return { status: 'idle', detail: null };

    case 'session.error':
      return { status: 'error', detail: null };

    // `session.complete` was a guessed name (doesn't fire); harmless if a future
    // version adds it → treat as a genuine end.
    case 'session.complete':
      return { status: 'done', detail: null };

    default:
      return null;
  }
}
