/**
 * EventReadService — the READ side of the per-session event log (US-21/US-34).
 *
 * Events are written by the WriteBehindEventQueue (off the live path, spec §6.6);
 * this exposes them for the paddock's Activity timeline + artifacts. Reads are a
 * cold path (the live status comes over /ws/status), so a plain DB query is fine.
 * Newest-first, capped, mapped to the shared `Event` contract (never duplicated).
 */
import { and, desc, eq, sql } from 'drizzle-orm';
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
   * Recent activity ACROSS the whole fleet (US-1d audit timeline) — every agent's
   * status transitions in one chronological stream, newest-first, capped. Filtered
   * to status-bearing events (the meaningful "what each agent did/became" spine,
   * not every raw frame). One query, cold path. No competitor ships a cross-agent
   * audit timeline — this is the open-field differentiator.
   */
  async recentFleetActivity(limit = 60): Promise<Event[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(sql`${events.status} is not null`)
      .orderBy(desc(events.seq))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map(rowToEvent);
  }

  /**
   * The latest chat message per session (for the Paddock fleet cards — triage what
   * every agent is saying/asking at a glance, in ONE query instead of N per-card
   * fetches). Scans the most recent chat events newest-first and keeps the first
   * (= latest) seen per session. Covers all currently-active sessions; a session
   * whose last chat is far in the past simply isn't included.
   */
  async latestChats(): Promise<Record<string, { role: string; text: string }>> {
    const rows = await this.db
      .select({ sessionId: events.sessionId, raw: events.agentEventRaw })
      .from(events)
      .where(sql`jsonb_exists(${events.agentEventRaw}, 'chat')`)
      .orderBy(desc(events.seq))
      .limit(500);
    const out: Record<string, { role: string; text: string }> = {};
    for (const r of rows) {
      if (out[r.sessionId]) continue; // newest-first → first seen is the latest
      const chat = (r.raw as { chat?: { role?: string; text?: string } } | null)?.chat;
      if (chat && typeof chat.text === 'string' && chat.text.trim().length > 0) {
        out[r.sessionId] = { role: chat.role ?? 'assistant', text: chat.text };
      }
    }
    return out;
  }

  /**
   * The most recent chat/assistant messages for ONE session (oldest→newest) — the
   * orchestration `read_output` tool, so an agent can inspect what a sibling
   * produced. Reads the session's `chat` events newest-first then reverses.
   */
  async recentChats(
    sessionId: string,
    limit: number,
  ): Promise<Array<{ role: string; text: string }>> {
    const rows = await this.db
      .select({ raw: events.agentEventRaw })
      .from(events)
      .where(
        and(eq(events.sessionId, sessionId), sql`jsonb_exists(${events.agentEventRaw}, 'chat')`),
      )
      .orderBy(desc(events.seq))
      .limit(Math.min(Math.max(limit, 1), 50));
    const out: Array<{ role: string; text: string }> = [];
    for (const r of rows) {
      const chat = (r.raw as { chat?: { role?: string; text?: string } } | null)?.chat;
      if (chat && typeof chat.text === 'string' && chat.text.trim().length > 0) {
        out.push({ role: chat.role ?? 'assistant', text: chat.text });
      }
    }
    return out.reverse(); // oldest→newest
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
