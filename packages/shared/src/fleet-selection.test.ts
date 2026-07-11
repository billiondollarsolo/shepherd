import { describe, expect, it } from 'vitest';
import {
  mergeFleetSelectionLww,
  shouldApplyRemoteSelection,
  type FleetSelectionPayload,
} from './fleet-selection.js';

function sel(
  partial: Partial<FleetSelectionPayload> & { updatedAt: string },
): FleetSelectionPayload {
  return {
    selectedSessionId: partial.selectedSessionId ?? null,
    activeProjectId: partial.activeProjectId ?? null,
    lens: partial.lens,
    updatedAt: partial.updatedAt,
  };
}

describe('fleet-selection LWW', () => {
  it('prefers later updatedAt', () => {
    const local = sel({ selectedSessionId: 'a', updatedAt: '2026-01-01T00:00:00.000Z' });
    const remote = sel({ selectedSessionId: 'b', updatedAt: '2026-01-02T00:00:00.000Z' });
    expect(mergeFleetSelectionLww(local, remote).selectedSessionId).toBe('b');
    expect(mergeFleetSelectionLww(remote, local).selectedSessionId).toBe('b');
  });

  it('null local takes incoming', () => {
    const remote = sel({ selectedSessionId: 'x', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(mergeFleetSelectionLww(null, remote)).toEqual(remote);
  });

  it('follow disabled never applies remote', () => {
    const local = sel({ selectedSessionId: 'a', updatedAt: '2026-01-01T00:00:00.000Z' });
    const remote = sel({ selectedSessionId: 'b', updatedAt: '2026-01-03T00:00:00.000Z' });
    expect(shouldApplyRemoteSelection(false, local, remote)).toBe(false);
    expect(shouldApplyRemoteSelection(true, local, remote)).toBe(true);
  });
});
