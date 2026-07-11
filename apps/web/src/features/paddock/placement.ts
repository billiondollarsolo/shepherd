/**
 * Opt-in smart placement (#3b). A project binds to a node (sessions inherit it),
 * so "where should this agent run" is decided when you create the project. This
 * is the OPT-IN "Auto (best node)" resolver — manual node selection stays the
 * default; Auto is only used when the user explicitly picks it.
 *
 * "Best" = among REACHABLE nodes (optionally scoped to a pool), the one with the
 * fewest open sessions — a cheap, dependency-free load proxy (no metrics polling),
 * tiebroken by name for stable choices. A real load/CPU signal can refine this
 * later without changing the call sites.
 */
import type { Node, Session } from '@flock/shared';

/** Reachable for launching: a local node, or an ssh node that's connected. */
export function nodeReachable(n: Node): boolean {
  return n.kind === 'local' || n.connectionStatus === 'connected';
}

/** The least-busy reachable node (optionally within `pool`), or null if none. */
export function pickBestNode(
  nodes: readonly Node[],
  sessions: readonly Session[],
  pool?: string | null,
): Node | null {
  const open = sessions.filter((s) => s.closedAt === null);
  const load = (id: string): number => open.reduce((n, s) => n + (s.nodeId === id ? 1 : 0), 0);
  const pickable = nodes.filter((n) => nodeReachable(n) && (pool == null || n.pool === pool));
  if (pickable.length === 0) return null;
  return (
    [...pickable].sort((a, b) => load(a.id) - load(b.id) || a.name.localeCompare(b.name))[0] ?? null
  );
}
