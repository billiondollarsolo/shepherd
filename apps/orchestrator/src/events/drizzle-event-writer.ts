/**
 * US-21 — Drizzle-backed {@link EventWriter} (spec §6 events table).
 *
 * The production sink for {@link WriteBehindEventQueue}: inserts one row into the
 * append-only `events` table. This is the ONLY part of the write-behind path
 * that touches Postgres, and it runs exclusively off the live path (driven by
 * the queue's background drain loop) — so a slow insert here can never delay a
 * status transition or its WS fan-out (NFR-PERF1, spec §6.6).
 *
 * Column mapping (EventRecord → `events`):
 *   sessionId     → session_id
 *   type          → type
 *   source        → source
 *   mappedStatus  → mapped_status (`status` in the Drizzle model)
 *   agentEventRaw → agent_event_raw
 *   detail        → detail
 * (`id`, `seq`, `ts` are DB-generated.)
 */
import type { Database } from '../db/client.js';
import { events } from '../db/schema.js';

import type { EventRecord, EventWriter } from './queue.js';

/**
 * Build an {@link EventWriter} bound to a Drizzle client. Each call performs a
 * single INSERT into `events`; the queue handles batching cadence, retries, and
 * error containment.
 */
export function createDrizzleEventWriter(db: Database): EventWriter {
  return async (record: EventRecord): Promise<void> => {
    await db.insert(events).values({
      sessionId: record.sessionId,
      type: record.type,
      source: record.source,
      // The Drizzle column is `status` (DB column `mapped_status`).
      status: record.mappedStatus,
      // jsonb column; `undefined` would omit it, so coerce null explicitly.
      agentEventRaw: record.agentEventRaw ?? null,
      detail: record.detail,
    });
  };
}
