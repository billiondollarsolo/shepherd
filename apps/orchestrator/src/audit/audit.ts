/**
 * Minimal, reusable audit-log utility (FR-A3, spec §6 `audit_log`).
 *
 * Append-only record of security-relevant actions. Kept deliberately tiny so
 * later phases (auth login, node add/remove, session create/terminate, browser
 * takeover, secret access) can all write rows through the same seam.
 *
 * The util does NOT own a DB connection. It takes an {@link AuditSink} —
 * anything that can persist one row — so it is trivially testable with an
 * in-memory fake and swappable for the real Drizzle insert wired up by US-2.
 *
 * Spec §6 audit_log columns:
 *   id, ts, user_id, action, target_type, target_id, ip, detail
 */

/**
 * Security-relevant actions recorded in the audit log (FR-A3, spec §6).
 *
 * Kept in lock-step with the SHARED `AuditActionEnum` (`@flock/shared`) and the
 * `audit_log` column enum (`db/schema.ts`) — those are the source of truth; this
 * local union is a convenience that must not drift from them.
 */
export type AuditAction =
  | 'login'
  | 'logout'
  | 'node_add'
  | 'node_update'
  | 'node_remove'
  | 'session_create'
  | 'session_terminate'
  | 'browser_takeover'
  | 'browser_release'
  | 'secret_access'
  | 'user_create';

/** A single audit-log entry to persist. `id`/`ts` are filled by the writer. */
export interface AuditEntry {
  /** Acting user, if any. System-originated rows (e.g. boot reconcile) may omit. */
  userId?: string | null;
  action: AuditAction;
  /** Kind of thing acted on, e.g. 'secret', 'node', 'session'. */
  targetType?: string | null;
  /** Identifier of the thing acted on, e.g. the secret id. */
  targetId?: string | null;
  /** Source IP when the action came over the network. */
  ip?: string | null;
  /** Free-form structured context (never include plaintext secrets). */
  detail?: Record<string, unknown> | null;
}

/**
 * Persistence seam for audit rows. Implemented over Drizzle/Postgres in the app
 * and over an array in tests. Async because the real sink writes to the DB.
 *
 * Audit writes are off the live status path; failures here must not break the
 * caller's primary operation (the caller decides how to handle rejection).
 */
export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/** A no-op sink (e.g. for unit tests that don't assert on audit rows). */
export const nullAuditSink: AuditSink = {
  async write() {
    /* intentionally empty */
  },
};

/**
 * The audit logger. A thin wrapper over an {@link AuditSink} that normalizes
 * optional fields to `null` so every persisted row has a consistent shape.
 */
export class AuditLogger {
  constructor(private readonly sink: AuditSink) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.sink.write({
      userId: entry.userId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ?? null,
      detail: entry.detail ?? null,
    });
  }

  /** Convenience for the secret store: records a `secret_access` row on decrypt. */
  async recordSecretAccess(opts: {
    secretId: string;
    userId?: string | null;
    ip?: string | null;
    keyVersion?: number;
  }): Promise<void> {
    await this.record({
      action: 'secret_access',
      targetType: 'secret',
      targetId: opts.secretId,
      userId: opts.userId ?? null,
      ip: opts.ip ?? null,
      detail:
        opts.keyVersion === undefined ? null : { keyVersion: opts.keyVersion },
    });
  }

  /** Convenience for the nodes route: records a `node_add` row (FR-A3, US-40). */
  async recordNodeAdd(opts: {
    nodeId: string;
    userId?: string | null;
    ip?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.record({
      action: 'node_add',
      targetType: 'node',
      targetId: opts.nodeId,
      userId: opts.userId ?? null,
      ip: opts.ip ?? null,
      detail: opts.detail ?? null,
    });
  }

  /** Convenience for the nodes route: records a `node_update` row (FR-A3, US-40). */
  async recordNodeUpdate(opts: {
    nodeId: string;
    userId?: string | null;
    ip?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.record({
      action: 'node_update',
      targetType: 'node',
      targetId: opts.nodeId,
      userId: opts.userId ?? null,
      ip: opts.ip ?? null,
      detail: opts.detail ?? null,
    });
  }

  /** Convenience for the nodes route: records a `node_remove` row (FR-A3, US-40). */
  async recordNodeRemove(opts: {
    nodeId: string;
    userId?: string | null;
    ip?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.record({
      action: 'node_remove',
      targetType: 'node',
      targetId: opts.nodeId,
      userId: opts.userId ?? null,
      ip: opts.ip ?? null,
      detail: opts.detail ?? null,
    });
  }

  /** Convenience for session create: records a `session_create` row (FR-A3, US-40). */
  async recordSessionCreate(opts: {
    sessionId: string;
    userId?: string | null;
    ip?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.record({
      action: 'session_create',
      targetType: 'session',
      targetId: opts.sessionId,
      userId: opts.userId ?? null,
      ip: opts.ip ?? null,
      detail: opts.detail ?? null,
    });
  }
}
