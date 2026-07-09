/**
 * Per-user fleet selection store (herdr-aligned shell plan Phase 1).
 * In-memory default for unit tests; optional file/DB-backed in production wiring.
 */
import {
  FleetSelectionPayloadSchema,
  type FleetSelectionPayload,
  mergeFleetSelectionLww,
} from '@flock/shared';

export type FleetSelectionSink = (userId: string, payload: FleetSelectionPayload) => void;

export class FleetSelectionStore {
  private readonly map = new Map<string, FleetSelectionPayload>();
  private readonly fans = new Set<FleetSelectionSink>();

  get(userId: string): FleetSelectionPayload | null {
    return this.map.get(userId) ?? null;
  }

  put(userId: string, incoming: FleetSelectionPayload): FleetSelectionPayload {
    const parsed = FleetSelectionPayloadSchema.parse(incoming);
    const local = this.map.get(userId) ?? null;
    const merged = mergeFleetSelectionLww(local, parsed);
    this.map.set(userId, merged);
    for (const fan of this.fans) fan(userId, merged);
    return merged;
  }

  subscribe(fan: FleetSelectionSink): () => void {
    this.fans.add(fan);
    return () => this.fans.delete(fan);
  }
}
