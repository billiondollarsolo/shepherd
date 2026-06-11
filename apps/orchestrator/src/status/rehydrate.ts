/**
 * Roadmap F3 — rebuildable live status.
 *
 * The authoritative live status is the in-memory {@link StatusMap}; Postgres is a
 * write-behind MIRROR (`agent_sessions.status`). After an orchestrator restart
 * the map starts empty, so every session shows blank until its agent next emits.
 * This rehydrates the map from the mirror on boot so live status is correct
 * immediately.
 *
 * It uses {@link StatusMap.seed} — which writes NOTHING to the event log and does
 * not fan out a transition (clients get the state via the snapshot replay when
 * they connect). The DB read is injected so this is unit-testable, and the caller
 * runs it OFF the hot path (a slow/down DB must never block startup, NFR-PERF1).
 */
import type { Status } from '@flock/shared';
import type { StatusMap } from './map.js';

/** A session's last-known status from the write-behind mirror. */
export interface OpenStatusRow {
  readonly id: string;
  readonly status: Status;
}

/**
 * Seed the in-memory status map from the persisted mirror. Returns the number of
 * sessions seeded.
 */
export async function rehydrateStatus(
  statusMap: StatusMap,
  loadOpenStatuses: () => Promise<ReadonlyArray<OpenStatusRow>>,
): Promise<number> {
  const rows = await loadOpenStatuses();
  for (const row of rows) statusMap.seed(row.id, row.status);
  return rows.length;
}
