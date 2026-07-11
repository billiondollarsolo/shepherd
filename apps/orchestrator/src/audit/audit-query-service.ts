/**
 * AuditQueryService — the owner read side of the audit surface (US-40, FR-A3).
 *
 * US-40 acceptance: "login, node add/remove, session create/terminate, browser
 * takeover, secret access all produce audit rows (FR-A3); the owner can read them."
 * The WRITE side is the shared {@link AuditLogger}/`AuditSink` (audit.ts); this
 * module is the read side that backs the owner-only `GET /api/audit` route.
 *
 * It normalizes the query (default + max page size, default offset) and delegates
 * the actual fetch to an injected {@link AuditReadStore} — the Drizzle-backed
 * store in production, an in-memory fake in tests. Reading the audit log is a
 * durable-store read that is NEVER on the live status path (spec §6.6): it only
 * ever touches the injected read-store, never the in-memory status map.
 */
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  type AuditAction,
  type AuditEntry,
  type ListAuditResponse,
} from '@flock/shared';

/** The (already-normalized) filter handed to the read store. */
export interface AuditQueryFilter {
  /** Filter to a single action, or undefined for all actions. */
  action?: AuditAction;
  /** Filter to one acting user, or undefined for all users. */
  userId?: string;
  /** Page size (1..AUDIT_MAX_LIMIT). Always set by the service. */
  limit: number;
  /** Rows to skip, newest-first. Always set by the service. */
  offset: number;
}

/**
 * Persistence seam for reading audit rows (newest-first). Implemented over
 * Drizzle/Postgres in the app and over an array in tests, mirroring the write
 * side's `AuditSink` seam.
 */
export interface AuditReadStore {
  /** Return matching rows ordered newest-first (descending `ts`). */
  list(filter: AuditQueryFilter): Promise<AuditEntry[]>;
}

/** The raw (un-normalized) query, as parsed from the shared `ListAuditQuery`. */
export interface ListAuditInput {
  action?: AuditAction;
  userId?: string;
  limit?: number;
  offset?: number;
}

export class AuditQueryService {
  constructor(private readonly store: AuditReadStore) {}

  /**
   * List audit entries newest-first (FR-A3 owner read). Applies the default page
   * size and clamps to the max so a caller can never request an unbounded page.
   */
  async list(input: ListAuditInput): Promise<ListAuditResponse> {
    const limit = Math.min(
      AUDIT_MAX_LIMIT,
      Math.max(1, Math.trunc(input.limit ?? AUDIT_DEFAULT_LIMIT)),
    );
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));

    const filter: AuditQueryFilter = { limit, offset };
    if (input.action !== undefined) filter.action = input.action;
    if (input.userId !== undefined) filter.userId = input.userId;

    const entries = await this.store.list(filter);
    return { entries };
  }
}
