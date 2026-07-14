/**
 * DrizzleSessionRegistry — the production {@link SessionRegistry} backed by the
 * Postgres `agent_sessions` table (FR-S3, spec §6).
 *
 * It uses the shared row<->domain mappers so the `Session` domain type is never
 * duplicated, upholding the single authoritative record invariant (spec §4.2):
 * the row `id` (the session_id) threads the tmux name, hook token hash, node,
 * project, and owner into ONE row.
 *
 * Postgres is the durable REGISTRY/identity store, NOT the live status path
 * (spec §6.6, NFR-PERF1): these writes/reads happen at create time and at boot
 * re-attach, never on the per-transition status hot path.
 */
import { eq, isNull } from 'drizzle-orm';

import type { SessionRecord } from '@flock/shared';

import type { Database } from '../db/client.js';
import { rowToSession, sessionToRow } from '../db/mappers.js';
import { agentSessions } from '../db/schema.js';

export class DrizzleSessionRegistry {
  constructor(private readonly db: Database) {}

  /** Insert the new authoritative session record; return the stored row mapped. */
  async insertSession(session: SessionRecord): Promise<SessionRecord> {
    const [row] = await this.db.insert(agentSessions).values(sessionToRow(session)).returning();
    if (!row) {
      throw new Error('Failed to persist agent_session record.');
    }
    return rowToSession(row);
  }

  /**
   * Load the authoritative record by session_id (US-13 terminate), or null when
   * it does not exist. Reads the identity/registry store, never the live path.
   */
  async getSession(id: string): Promise<SessionRecord | null> {
    const [row] = await this.db.select().from(agentSessions).where(eq(agentSessions.id, id));
    return row ? rowToSession(row) : null;
  }

  /**
   * All records that are still open (`closed_at IS NULL`) — the boot re-attach
   * candidate set (FR-S4). A session that was explicitly terminated has a
   * `closed_at` and is excluded.
   */
  async listOpenSessions(): Promise<SessionRecord[]> {
    const rows = await this.db.select().from(agentSessions).where(isNull(agentSessions.closedAt));
    return rows.map(rowToSession);
  }

  /** Mark a record closed (its tmux session is gone / it was terminated). */
  async markClosed(id: string, closedAt: string): Promise<void> {
    await this.db
      .update(agentSessions)
      .set({ closedAt: new Date(closedAt) })
      .where(eq(agentSessions.id, id));
  }
}
