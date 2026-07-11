/**
 * Drizzle-backed audit recorders (FR-A3).
 *
 * Writes append-only rows into the `audit_log` table (spec §6). `detail` is
 * stored as a compact JSON string (the column is text). Auth audit writes
 * happen off the live status path, so a synchronous insert is fine here.
 *
 * Two shapes are exported because the codebase has two audit consumers:
 *   - {@link makeDbAuditSink}: an {@link AuditSink} for the shared `AuditLogger`
 *     (used by the SecretStore / nodes / sessions code).
 *   - {@link makeDbAuthAuditRecorder}: an {@link AuthAuditRecorder} typed with
 *     the SHARED `AuditAction` (covers `owner_setup`) for the auth service.
 * Both write the same table via the same row mapper.
 */
import type { AuditEntry, AuditSink } from '../audit/audit.js';
import type { AuditAction } from '@flock/shared';
import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema.js';
import type { AuthAuditEntry, AuthAuditRecorder } from './service.js';

interface InsertableAuditRow {
  action: AuditAction;
  userId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown> | null;
}

async function insertRow(db: Database, entry: InsertableAuditRow): Promise<void> {
  await db.insert(auditLog).values({
    userId: entry.userId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ip: entry.ip ?? null,
    detail: entry.detail == null ? null : JSON.stringify(entry.detail),
  });
}

/** {@link AuditSink} backed by Postgres (for the shared `AuditLogger`). */
export function makeDbAuditSink(db: Database): AuditSink {
  return {
    async write(entry: AuditEntry): Promise<void> {
      await insertRow(db, entry);
    },
  };
}

/** {@link AuthAuditRecorder} backed by Postgres (for the auth service). */
export function makeDbAuthAuditRecorder(db: Database): AuthAuditRecorder {
  return {
    async record(entry: AuthAuditEntry): Promise<void> {
      await insertRow(db, entry);
    },
  };
}
