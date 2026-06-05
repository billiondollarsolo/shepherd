/**
 * DrizzleAuditReadStore — Postgres-backed read store for the audit log (US-40).
 *
 * Reads the append-only `audit_log` table (spec §6) newest-first, with optional
 * `action` / `userId` filters and a bounded page (limit/offset). It is the
 * production impl of {@link AuditReadStore}; tests use an in-memory fake.
 *
 * Postgres is the durable system of record here, NOT the live status path (spec
 * §6.6): the admin audit read is intentionally off the hot path. Rows are mapped
 * to the shared `AuditEntry` via `rowToAuditEntry` so the domain type is never
 * duplicated.
 */
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { AuditEntry } from '@flock/shared';

import type { Database } from '../db/client.js';
import { rowToAuditEntry } from '../db/mappers.js';
import { auditLog } from '../db/schema.js';
import type { AuditQueryFilter, AuditReadStore } from './audit-query-service.js';

export class DrizzleAuditReadStore implements AuditReadStore {
  constructor(private readonly db: Database) {}

  async list(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    const conditions: SQL[] = [];
    if (filter.action !== undefined) {
      conditions.push(
        eq(auditLog.action, filter.action as (typeof auditLog.$inferSelect)['action']),
      );
    }
    if (filter.userId !== undefined) {
      conditions.push(eq(auditLog.userId, filter.userId));
    }

    // drizzle's `and` is variadic and returns undefined for an empty list and
    // the lone condition for a single one, so no manual length ladder is needed.
    const where = conditions.length ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.ts))
      .limit(filter.limit)
      .offset(filter.offset);

    return rows.map(rowToAuditEntry);
  }
}
