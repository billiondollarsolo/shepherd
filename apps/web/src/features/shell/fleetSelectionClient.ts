/**
 * Per-user multi-device fleet selection client (Phase 1).
 * REST + LWW merge using shared helpers.
 */
import {
  FleetSelectionPayloadSchema,
  mergeFleetSelectionLww,
  shouldApplyRemoteSelection,
  type FleetSelectionPayload,
} from '@flock/shared';

const BASE = '/api/me/selection';

export async function fetchFleetSelection(
  fetchImpl: typeof fetch = fetch,
): Promise<FleetSelectionPayload | null> {
  const res = await fetchImpl(BASE, { credentials: 'include' });
  if (!res.ok) return null;
  const body = (await res.json()) as { selection: unknown };
  if (body.selection == null) return null;
  const parsed = FleetSelectionPayloadSchema.safeParse(body.selection);
  return parsed.success ? parsed.data : null;
}

export async function putFleetSelection(
  payload: FleetSelectionPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<FleetSelectionPayload | null> {
  const res = await fetchImpl(BASE, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { selection: unknown };
  const parsed = FleetSelectionPayloadSchema.safeParse(body.selection);
  return parsed.success ? parsed.data : null;
}

/** Apply remote selection if follow is on and remote wins LWW. */
export function resolveRemoteSelection(
  followEnabled: boolean,
  local: FleetSelectionPayload | null,
  remote: FleetSelectionPayload,
): FleetSelectionPayload | null {
  if (!shouldApplyRemoteSelection(followEnabled, local, remote)) return null;
  return mergeFleetSelectionLww(local, remote);
}

export function selectionFromStore(state: {
  selectedSessionId: string | null;
  selectedProjectId: string | null;
  lens: FleetSelectionPayload['lens'];
}): FleetSelectionPayload {
  return {
    selectedSessionId: state.selectedSessionId,
    activeProjectId: state.selectedProjectId,
    lens: state.lens,
    updatedAt: new Date().toISOString(),
  };
}
