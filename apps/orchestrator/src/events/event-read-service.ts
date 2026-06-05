/**
 * EventReadService — the READ side of the per-session event log (US-21/US-34).
 *
 * Events are written by the WriteBehindEventQueue (off the live path, spec §6.6);
 * this exposes them for the paddock's Activity timeline + artifacts. Reads are a
 * cold path (the live status comes over /ws/status), so a plain DB query is fine.
 * Newest-first, capped, mapped to the shared `Event` contract (never duplicated).
 */
import { and, desc, eq } from 'drizzle-orm';
import { SessionPlan, type Event } from '@flock/shared';

import type { Database } from '../db/client.js';
import { events } from '../db/schema.js';

const DEFAULT_LIMIT = 200;

type EventRow = typeof events.$inferSelect;

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    sessionId: row.sessionId,
    ts: row.ts.toISOString(),
    type: row.type,
    source: row.source as Event['source'],
    agentEventRaw: row.agentEventRaw ?? null,
    mappedStatus: (row.status as Event['mappedStatus']) ?? null, // column is `mapped_status`
    detail: row.detail ?? null,
  };
}

export class EventReadService {
  constructor(private readonly db: Database) {}

  /** The most recent events for a session, newest-first (capped). */
  async listForSession(sessionId: string, limit = DEFAULT_LIMIT): Promise<Event[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(desc(events.seq))
      .limit(limit);
    return rows.map(rowToEvent);
  }

  /**
   * The agent's latest plan/todo snapshot (US-34 Plan artifact), or null when it
   * has never emitted one. Reads the most recent `plan` event (written by the
   * hook endpoint from a Claude TodoWrite) and stamps it with the event ts.
   */
  async getLatestPlan(sessionId: string): Promise<SessionPlan | null> {
    const [row] = await this.db
      .select()
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, 'plan')))
      .orderBy(desc(events.seq))
      .limit(1);
    if (!row) return null;
    const raw = row.agentEventRaw;
    const items = raw && typeof raw === 'object' ? (raw as { items?: unknown }).items : undefined;
    const parsed = SessionPlan.safeParse({ items, updatedAt: row.ts.toISOString() });
    return parsed.success ? parsed.data : null;
  }
}
