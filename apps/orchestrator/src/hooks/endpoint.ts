/**
 * US-15 — Hook endpoint service + per-session token auth (spec §8.1, §15;
 * NFR-SEC3, NFR-PERF1).
 *
 * `POST /api/hooks/:sessionId` is the ONE path that must be fast and DB-free on
 * the hot path (spec §15: "treat any synchronous DB call there as a bug"). This
 * module holds the auth + dispatch logic; the Fastify wiring lives in
 * `routes.ts`.
 *
 * The flow, in order, with ZERO synchronous Postgres access:
 *   1. resolve the session's auth material from the IN-MEMORY live binding
 *      (a `Map` lookup, not a DB read); unknown session → 404 (spec §10);
 *   2. compare the presented per-session token against the stored
 *      `hook_token_hash` (NFR-SEC3); missing/invalid → 401;
 *   3. translate the agent event to a {@link Status} (pure per-agent function)
 *      and update the in-memory status map (the live path, fanned out over WS);
 *   4. ENQUEUE the raw event for the async/write-behind `events` log — never
 *      awaited inline, so a slow/blocked/failing DB cannot delay the ack
 *      (NFR-PERF1).
 *
 * Auth is the per-session token in the `Authorization` header, NEVER a cookie
 * (spec §8.1 line 187). Token verification (SHA-256 + constant-time compare — the
 * token is 256-bit CSPRNG so it needs no salt/memory-hardness) is injected so the
 * unit tests stay fast and the hot-path cost is explicit.
 */
import { AgentTypeEnum, type AgentType, type HookTelemetry, type Status } from '@flock/shared';

import { translateHookEvent } from './translate.js';
import { extractPlan, planEventFields } from './plan.js';
import { OpenCodeChatAssembler } from './opencode-chat.js';

/**
 * Resolve which agent translator/plan extractor to use. Prefer the live session
 * binding (always known for a Flock-managed session) over body inference — Claude
 * and Gemini both use `hook_event_name`, Codex can too, and Grok may emit either
 * camelCase or snake_case field names. Body `agentType` (OpenCode plugin) and
 * payload-shape inference remain as fallbacks.
 */
function resolveAgentType(
  inputAgentType: AgentType | undefined,
  sessionAgentType: AgentType | undefined,
  body: unknown,
): AgentType | undefined {
  if (inputAgentType) return inputAgentType;
  if (sessionAgentType) return sessionAgentType;
  if (body !== null && typeof body === 'object' && 'agentType' in body) {
    const raw = (body as { agentType?: unknown }).agentType;
    const parsed = AgentTypeEnum.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Errors (mapped to HTTP status codes by the route layer)
// ---------------------------------------------------------------------------

/** The session does not exist (or is closed) → 404, no map mutation (spec §10). */
export class HookSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`No live session for id ${sessionId}.`);
    this.name = 'HookSessionNotFoundError';
  }
}

/** Missing or invalid per-session token → 401 (NFR-SEC3). */
export class HookUnauthorizedError extends Error {
  constructor(message = 'Invalid or missing hook token.') {
    super(message);
    this.name = 'HookUnauthorizedError';
  }
}

// ---------------------------------------------------------------------------
// Collaborator seams (all in-memory / off the live path; no DB on the hot path)
// ---------------------------------------------------------------------------

/** The minimal auth material the endpoint needs for one session. */
export interface HookSessionAuth {
  readonly sessionId: string;
  /** Hash of the per-session hook token (NFR-SEC3); never the plaintext. */
  readonly hookTokenHash: string;
  /**
   * Agent type for translator/plan dispatch without a DB read. Optional for
   * back-compat with older in-memory bindings; when absent, falls back to body
   * `agentType` or payload-shape inference.
   */
  readonly agentType?: AgentType;
}

/**
 * The IN-MEMORY live binding lookup (spec §6.6). Backed by the live session map
 * (e.g. {@link SessionCreateService.getSession}) in production; a plain object
 * in tests. MUST be synchronous and DB-free — this is the hot path.
 */
export interface HookSessionLookup {
  getHookAuth(sessionId: string): HookSessionAuth | undefined;
}

/**
 * Verifies a presented plaintext token against the stored hash. Returns a
 * boolean; never throws on a malformed hash (returns false). Production uses
 * SHA-256 + constant-time compare (see hooks/hook-token.ts); injected for tests.
 */
export type HookTokenVerifier = (hash: string, token: string) => Promise<boolean>;

/**
 * A live frame to apply to the in-memory status map (US-14). `status: null` is a
 * TELEMETRY-ONLY frame: it carries `telemetry` but changes no status (the sink
 * fans the telemetry out status-preservingly).
 */
export interface HookTransition {
  readonly sessionId: string;
  readonly status: Status | null;
  readonly detail: string | null;
  /** Raw per-turn telemetry (model/tokens/cost), when the event carries it. */
  readonly telemetry?: HookTelemetry;
}

/** Applies a transition to the in-memory status map + WS fan-out (US-14). */
export type HookTransitionSink = (t: HookTransition) => void;

/** A raw agent event to append to the async write-behind `events` log (US-21). */
export interface HookEventRecord {
  readonly sessionId: string;
  /** Always `hook` for this endpoint (spec §6 `events.source`). */
  readonly source: 'hook';
  /** The mapped status, or null when the event yielded no transition. */
  readonly mappedStatus: Status | null;
  /** The raw agent event JSON exactly as received (spec §6 `agent_event_raw`). */
  readonly agentEventRaw: unknown;
  /** Optional human-facing detail derived from the event. */
  readonly detail: string | null;
  /**
   * Optional explicit `events.type`. Omitted → derived from the payload (the
   * hook event name). Set to `plan` for the extracted plan snapshot (US-34) so
   * the read side can find the latest plan without parsing every raw event.
   */
  readonly type?: string;
}

/**
 * Enqueues an event for the async/write-behind log. Fire-and-forget: its
 * returned promise is NEVER awaited on the hot path (NFR-PERF1).
 */
export type HookEventEnqueue = (e: HookEventRecord) => Promise<void> | void;

export interface HookEndpointServiceDeps {
  /** In-memory live binding (DB-free). */
  lookup: HookSessionLookup;
  /** Per-session token verifier (SHA-256 + constant-time compare in production). */
  verifyToken: HookTokenVerifier;
  /** Apply a live status transition (in-memory map + WS fan-out). */
  onTransition: HookTransitionSink;
  /** Enqueue the raw event for the async write-behind log. */
  enqueueEvent: HookEventEnqueue;
}

/** Inputs to {@link HookEndpointService.handle} (assembled by the route). */
export interface HandleHookInput {
  readonly sessionId: string;
  /** The token parsed from the Authorization header, or null if absent. */
  readonly token: string | null;
  /** The agent event JSON body (any object). */
  readonly body: unknown;
  /** Optional agent type so the right translator is chosen without a DB read. */
  readonly agentType?: AgentType;
}

/** The fast 202 ack — the shared {@link HookCallbackResponse} shape. */
export interface HookCallbackAck {
  readonly ok: true;
}

// ---------------------------------------------------------------------------
// Authorization header parsing
// ---------------------------------------------------------------------------

/**
 * Extract the per-session token from an `Authorization` header value.
 *
 * Accepts `Bearer <token>` (scheme case-insensitive) or a bare token (some
 * agents send the raw value). Returns null when no usable token is present.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  const match = /^bearer\s+(.+)$/i.exec(trimmed);
  if (match) {
    const token = match[1]!.trim();
    return token.length > 0 ? token : null;
  }

  // A bare scheme word ("Bearer" with nothing after) is not a token.
  if (/^bearer$/i.test(trimmed)) return null;

  // No recognized scheme: treat the whole value as the token.
  return trimmed;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class HookEndpointService {
  private readonly lookup: HookSessionLookup;
  private readonly verifyToken: HookTokenVerifier;
  private readonly onTransition: HookTransitionSink;
  private readonly enqueueEvent: HookEventEnqueue;
  /** Assembles OpenCode's streamed message parts into whole Chat messages. */
  private readonly opencodeChat = new OpenCodeChatAssembler();

  constructor(deps: HookEndpointServiceDeps) {
    this.lookup = deps.lookup;
    this.verifyToken = deps.verifyToken;
    this.onTransition = deps.onTransition;
    this.enqueueEvent = deps.enqueueEvent;
  }

  /**
   * Fire-and-forget write-behind enqueue: never awaited, and neither an async
   * rejection nor a synchronous throw from the sink can break the hook ack
   * (NFR-PERF1 — the DB is a mirror; a failed mirror write never affects the
   * live path).
   */
  private safeEnqueue(event: Parameters<HookEventEnqueue>[0]): void {
    try {
      void Promise.resolve(this.enqueueEvent(event)).catch(() => {
        /* swallowed: write-behind mirror; retry/logging is the wiring's job. */
      });
    } catch {
      /* a synchronous throw from the sink is likewise contained. */
    }
  }

  /**
   * Authenticate + dispatch a hook callback. Resolves the fast 202 ack on
   * success; rejects with {@link HookSessionNotFoundError} (404) for an unknown
   * session or {@link HookUnauthorizedError} (401) for a missing/invalid token.
   * Performs NO synchronous DB access.
   */
  async handle(input: HandleHookInput): Promise<HookCallbackAck> {
    // 1) Resolve the session from the IN-MEMORY live binding (DB-free).
    //    An unknown/closed session never reaches token comparison and never
    //    mutates the map (spec §10).
    const auth = this.lookup.getHookAuth(input.sessionId);
    if (!auth) {
      throw new HookSessionNotFoundError(input.sessionId);
    }

    // 2) Per-session token auth (NFR-SEC3). A missing token is rejected without
    //    a (costly) hash comparison; an invalid one fails verification. Either
    //    way we mutate nothing.
    if (input.token === null) {
      throw new HookUnauthorizedError('Hook token is required.');
    }
    const ok = await this.verifyToken(auth.hookTokenHash, input.token);
    if (!ok) {
      throw new HookUnauthorizedError();
    }

    // 3) Resolve agent type (session binding → body tag → shape inference) then
    //    translate. Without a reliable agentType, Claude/Gemini/Codex payloads
    //    that share `hook_event_name` mis-route, and Grok/OpenCode plan/chat
    //    extraction can silently no-op.
    const agentType = resolveAgentType(input.agentType, auth.agentType, input.body);
    const mapped = translateHookEvent(input.body, agentType);
    if (mapped) {
      this.onTransition({
        sessionId: input.sessionId,
        status: mapped.status,
        detail: mapped.detail,
        telemetry: mapped.telemetry,
      });
    }

    // A TELEMETRY-ONLY frame (status null, e.g. OpenCode `message.updated`) is
    // high-churn and live-only — it rides the WS via the sink above but is NOT
    // mirrored to the events log (no milestone), so it never spams the timeline.
    const telemetryOnly = mapped !== null && mapped.status === null;

    // 4) Enqueue the raw event for the async write-behind log. Fire-and-forget:
    //    never awaited, and a rejection cannot break the ack (NFR-PERF1). The DB
    //    is a mirror; a failed mirror write never affects the live path.
    if (!telemetryOnly) {
      this.safeEnqueue({
        sessionId: input.sessionId,
        source: 'hook',
        mappedStatus: mapped?.status ?? null,
        agentEventRaw: input.body,
        detail: mapped?.detail ?? null,
      });
    }

    // 5) US-34 Plan artifact: if the event carries the agent's plan/todo (Claude
    //    TodoWrite / OpenCode todo.updated), append a normalized `plan` snapshot.
    //    Same fire-and-forget contract — never awaited, never breaks the ack.
    const plan = extractPlan(input.body, agentType);
    const planFields = plan ? planEventFields(input.sessionId, plan.items) : null;
    if (planFields) {
      this.safeEnqueue({ sessionId: input.sessionId, source: 'hook', ...planFields });
    }

    // 6) OpenCode structured Chat: its text streams as message PARTS, so assemble
    //    whole messages (by message id + role) and, on turn end (`session.idle`),
    //    enqueue them as `chat` events the web Chat tab reads (agentEventRaw.chat).
    const ocBody = (input.body as { agentType?: string; type?: string } | null) ?? null;
    if (agentType === 'opencode' || ocBody?.agentType === 'opencode') {
      this.opencodeChat.observe(input.sessionId, input.body);
      const eventType = ocBody?.type;
      if (eventType === 'session.idle') {
        for (const msg of this.opencodeChat.flush(input.sessionId)) {
          this.safeEnqueue({
            sessionId: input.sessionId,
            source: 'hook',
            type: 'chat',
            mappedStatus: null,
            agentEventRaw: { chat: msg },
            detail: null,
          });
        }
      } else if (eventType === 'session.error' || eventType === 'session.complete') {
        this.opencodeChat.forget(input.sessionId);
      }
    }

    return { ok: true };
  }
}
