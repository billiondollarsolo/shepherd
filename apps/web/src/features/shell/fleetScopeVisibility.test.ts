import { describe, expect, it } from 'vitest';
import { shouldShowFleetScope } from './fleetScopeVisibility';

describe('shouldShowFleetScope', () => {
  it('shows scope on fleet-level surfaces', () => {
    expect(
      shouldShowFleetScope({
        selectedSessionId: null,
        selectedProjectId: null,
        nodeInfoNodeId: null,
      }),
    ).toBe(true);
  });

  it.each([
    { selectedSessionId: 'session', selectedProjectId: null, nodeInfoNodeId: null },
    { selectedSessionId: null, selectedProjectId: 'project', nodeInfoNodeId: null },
    { selectedSessionId: null, selectedProjectId: null, nodeInfoNodeId: 'node' },
  ])('hides scope when the main surface is entity-specific', (selection) => {
    expect(shouldShowFleetScope(selection)).toBe(false);
  });
});
