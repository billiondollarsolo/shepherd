import { describe, expect, it } from 'vitest';
import type { Project, Session } from '@flock/shared';
import { buildFleetIndex, FLEET_PAGE_SIZE, nextFleetLimit } from './fleetModel';

describe('fleetModel', () => {
  it('indexes projects and only open sessions in linear passes', () => {
    const projects = [
      { id: 'p1', nodeId: 'n1' },
      { id: 'p2', nodeId: 'n1' },
      { id: 'p3', nodeId: 'n2' },
    ] as Project[];
    const sessions = [
      { id: 's1', nodeId: 'n1', closedAt: null },
      { id: 's2', nodeId: 'n1', closedAt: '2026-01-01' },
      { id: 's3', nodeId: 'n2', closedAt: null },
    ] as Session[];

    const index = buildFleetIndex(projects, sessions);
    expect(index.projectsByNode.get('n1')?.map(({ id }) => id)).toEqual(['p1', 'p2']);
    expect(index.openSessionsByNode.get('n1')?.map(({ id }) => id)).toEqual(['s1']);
    expect(index.openSessionsByNode.get('n2')?.map(({ id }) => id)).toEqual(['s3']);
  });

  it('advances bounded pages without exceeding the total', () => {
    expect(nextFleetLimit(FLEET_PAGE_SIZE, 200)).toBe(60);
    expect(nextFleetLimit(180, 200)).toBe(200);
  });
});
