import { z } from 'zod';
import { AuditActionEnum, AuditEntrySchema, IsoTimestamp, Uuid } from '../domain.js';

// --- agent plan / todo (US-34 Plan artifact) -------------------------------

/** A plan/todo item's lifecycle state (maps from Claude Code TodoWrite status). */
export const PlanItemStatus = z.enum(['pending', 'in_progress', 'completed']);
export type PlanItemStatus = z.infer<typeof PlanItemStatus>;

/** One step of the agent's current plan/todo list. */
export const PlanItem = z.object({
  content: z.string().min(1),
  status: PlanItemStatus,
});
export type PlanItem = z.infer<typeof PlanItem>;

/**
 * The agent's current plan — the latest TodoWrite snapshot (US-34 Plan artifact).
 * `updatedAt` is the event timestamp the snapshot was captured at.
 */
export const SessionPlan = z.object({
  items: z.array(PlanItem),
  updatedAt: IsoTimestamp,
});
export type SessionPlan = z.infer<typeof SessionPlan>;

/** GET /api/sessions/:id/plan — null when the agent has not emitted a plan. */
export const SessionPlanResponse = z.object({ plan: SessionPlan.nullable() });
export type SessionPlanResponse = z.infer<typeof SessionPlanResponse>;

// --- push ------------------------------------------------------------------

/** POST /api/push/subscribe (mirrors the W3C PushSubscription JSON shape). */
export const PushSubscribeRequest = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;
export const PushSubscribeResponse = z.object({ ok: z.literal(true) });
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponse>;

/** DELETE /api/push/subscribe */
export const PushUnsubscribeRequest = z.object({ endpoint: z.string().url() });
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequest>;

// --- browser control -------------------------------------------------------

/** POST /api/sessions/:id/browser/(start|stop|takeover|release) */
export const BrowserActionEnum = z.enum(['start', 'stop', 'takeover', 'release']);
export type BrowserAction = z.infer<typeof BrowserActionEnum>;

export const BrowserControlResponse = z.object({
  sessionId: Uuid,
  action: BrowserActionEnum,
  /** Opaque CDP ws endpoint when a browser is running, else null. */
  browserCdpEndpoint: z.string().url().nullable(),
  /** Whether THIS client now holds the single input-control lock. */
  inControl: z.boolean(),
});
export type BrowserControlResponse = z.infer<typeof BrowserControlResponse>;

// --- audit (US-40, FR-A3) --------------------------------------------------

/** Hard ceiling on how many audit rows one `GET /api/audit` page may return. */
export const AUDIT_MAX_LIMIT = 500;
/** Default page size when the caller does not specify `limit`. */
export const AUDIT_DEFAULT_LIMIT = 100;

/**
 * GET /api/audit query (owner-only, US-40). Supports newest-first pagination and
 * optional narrowing by `action` and/or acting `userId`, so the owner can answer
 * "show me every login" or "what did user X do". All fields are optional; the
 * route applies {@link AUDIT_DEFAULT_LIMIT} / {@link AUDIT_MAX_LIMIT}.
 *
 * `z.coerce` is used for `limit`/`offset` because query-string values arrive as
 * strings; this keeps the same schema usable for both URL parsing and tests.
 */
export const ListAuditQuery = z.object({
  /** Filter to a single audit action (e.g. `login`, `node_remove`). */
  action: AuditActionEnum.optional(),
  /** Filter to rows attributed to one acting user. */
  userId: Uuid.optional(),
  /** Page size (1..AUDIT_MAX_LIMIT); defaults to AUDIT_DEFAULT_LIMIT. */
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).optional(),
  /** Number of rows to skip (newest-first); defaults to 0. */
  offset: z.coerce.number().int().min(0).optional(),
});
export type ListAuditQuery = z.infer<typeof ListAuditQuery>;

/**
 * GET /api/audit response (owner-only, US-40). `entries` are ordered newest-first
 * (descending `ts`). The append-only audit log is read off the live status path
 * (spec §6.6); this is a durable-store read, never the in-memory status map.
 */
export const ListAuditResponse = z.object({ entries: z.array(AuditEntrySchema) });
export type ListAuditResponse = z.infer<typeof ListAuditResponse>;

// --- errors ----------------------------------------------------------------

/** Uniform error envelope for non-2xx REST responses. */
export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
