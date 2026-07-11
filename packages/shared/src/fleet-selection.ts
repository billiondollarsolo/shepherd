/**
 * Per-user multi-device fleet selection (Phase 1).
 * Last-write-wins merge by updatedAt.
 */
import { z } from 'zod';

export const FleetSelectionPayloadSchema = z.object({
  selectedSessionId: z.string().nullable(),
  activeProjectId: z.string().nullable(),
  lens: z.enum(['mission', 'agents']).optional(),
  /** ISO-8601 timestamp; LWW key. */
  updatedAt: z.string().min(1),
});
export type FleetSelectionPayload = z.infer<typeof FleetSelectionPayloadSchema>;

/**
 * Last-write-wins merge. Prefer the side with the later updatedAt.
 * Equal timestamps → prefer `incoming` (remote write after local).
 */
export function mergeFleetSelectionLww(
  local: FleetSelectionPayload | null,
  incoming: FleetSelectionPayload,
): FleetSelectionPayload {
  if (!local) return incoming;
  const localT = Date.parse(local.updatedAt);
  const inT = Date.parse(incoming.updatedAt);
  if (Number.isNaN(inT)) return local;
  if (Number.isNaN(localT)) return incoming;
  if (inT >= localT) return incoming;
  return local;
}

/** True if follower should apply remote (follow enabled and remote wins LWW). */
export function shouldApplyRemoteSelection(
  followEnabled: boolean,
  local: FleetSelectionPayload | null,
  remote: FleetSelectionPayload,
): boolean {
  if (!followEnabled) return false;
  const merged = mergeFleetSelectionLww(local, remote);
  return merged === remote || merged.updatedAt === remote.updatedAt;
}
