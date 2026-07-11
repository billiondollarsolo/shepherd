import type { Project, Session } from '@flock/shared';

/** Render/query one bounded page at a time for large fleets. */
export const FLEET_PAGE_SIZE = 30;

export interface FleetIndex {
  readonly projectsByNode: ReadonlyMap<string, readonly Project[]>;
  readonly openSessionsByNode: ReadonlyMap<string, readonly Session[]>;
}

/**
 * Build the node rollups in one pass. Filtering every project/session inside
 * every card becomes quadratic at 200 nodes and made telemetry refreshes costly.
 */
export function buildFleetIndex(
  projects: readonly Project[],
  sessions: readonly Session[],
): FleetIndex {
  const projectsByNode = new Map<string, Project[]>();
  const openSessionsByNode = new Map<string, Session[]>();

  for (const project of projects) {
    const bucket = projectsByNode.get(project.nodeId);
    if (bucket) bucket.push(project);
    else projectsByNode.set(project.nodeId, [project]);
  }
  for (const session of sessions) {
    if (session.closedAt !== null) continue;
    const bucket = openSessionsByNode.get(session.nodeId);
    if (bucket) bucket.push(session);
    else openSessionsByNode.set(session.nodeId, [session]);
  }
  return { projectsByNode, openSessionsByNode };
}

export function nextFleetLimit(current: number, total: number): number {
  return Math.min(total, current + FLEET_PAGE_SIZE);
}
