/**
 * Build / repair project layouts for the stage (production path).
 *
 * Persistence contract:
 *   - Arrange mode + drag ratios are stored via PUT /api/projects/:id/layout.
 *   - On load / session-set changes we PRESERVE the stored tree (ratios, shape)
 *     whenever the open session set matches or can be pruned/extended.
 *   - Only an explicit rearrange (row/col/2×2 click) rebuilds equal panes.
 */
import {
  collectLeaves,
  defaultArrangeDirection,
  equalSessionLayout,
  isGrid2x2Layout,
  layoutArrangeMode,
  layoutSessionIds,
  pruneLayoutSessions,
  rebalanceEqualLeafWeights,
  sessionLayoutForMode,
  type ArrangeDirection,
  type ArrangeMode,
  type ProjectLayoutV1,
  type LayoutNode,
} from '@flock/shared';

export type { ArrangeDirection, ArrangeMode };
export const MAX_STAGE_SESSIONS = 4;

/** Layout covering all open sessions with equal pane sizes along `direction`. */
export function layoutFromSessions(
  projectId: string,
  sessionIds: readonly string[],
  focusedSessionId?: string | null,
  direction: ArrangeDirection = 'row',
): ProjectLayoutV1 | null {
  return equalSessionLayout(projectId, sessionIds, focusedSessionId, direction);
}

/**
 * Choose arrange mode when reconciling:
 *   1. explicit override (user toggle: row / col / 2×2)
 *   2. stored layout shape (2×2 grid, else primary direction)
 *   3. width-based default (narrow → stacked, wide → columns)
 */
export function resolveArrangeMode(opts: {
  explicit?: ArrangeMode | null;
  stored: ProjectLayoutV1 | null;
  projectId: string;
  stageWidthPx?: number | null;
}): ArrangeMode {
  if (opts.explicit === 'row' || opts.explicit === 'col' || opts.explicit === 'grid2x2') {
    return opts.explicit;
  }
  if (opts.stored && opts.stored.projectId === opts.projectId) {
    return layoutArrangeMode(opts.stored.root);
  }
  return defaultArrangeDirection(opts.stageWidthPx);
}

function focusLeafIdFor(layout: ProjectLayoutV1, focusedSessionId?: string | null): string {
  const leaves = collectLeaves(layout.root);
  if (leaves.length === 0) return layout.focusedLeafId;
  if (focusedSessionId) {
    const hit = leaves.find((l) => l.sessionId === focusedSessionId);
    if (hit) return hit.id;
  }
  if (leaves.some((l) => l.id === layout.focusedLeafId)) return layout.focusedLeafId;
  return leaves[0]!.id;
}

/**
 * Keep stored tree + ratios when the open set is the same; prune terminated;
 * keep newly discovered sessions out of the saved split tree until the user
 * explicitly adds them or applies an arrange preset.
 */
function preserveStoredLayout(
  projectId: string,
  openSessionIds: readonly string[],
  stored: ProjectLayoutV1,
  focusedSessionId?: string | null,
): ProjectLayoutV1 | null {
  if (stored.projectId !== projectId) return null;
  const openSet = new Set(openSessionIds);
  if (openSet.size === 0) return null;

  let base: ProjectLayoutV1 | null = stored;
  const storedSet = new Set(layoutSessionIds(stored.root));
  const retainedSet = new Set(
    layoutSessionIds(stored.root)
      .filter((id) => openSet.has(id))
      .slice(0, MAX_STAGE_SESSIONS),
  );

  // Drop terminated sessions and legacy panes beyond the four-slot cap while
  // preserving the remaining split ratios.
  if ([...storedSet].some((id) => !retainedSet.has(id))) {
    base = pruneLayoutSessions(stored, retainedSet);
    if (!base) return null;
  }

  // Every saved leaf must still be open. New open sessions are intentionally
  // allowed to be absent: merely starting an agent must not resize the stage.
  const finalIds = new Set(layoutSessionIds(base.root));
  if ([...finalIds].some((id) => !openSet.has(id))) {
    // Unexpected drift — refuse preserve so caller can rebuild.
    return null;
  }

  return {
    ...base,
    focusedLeafId: focusLeafIdFor(base, focusedSessionId),
    zoomedLeafId: null,
  };
}

/**
 * Merge server layout with live open sessions.
 *
 * Prefer preserving stored structure + drag ratios. Rebuild equal panes only
 * when there is no usable stored layout, or the caller forces a mode change
 * that differs from the stored arrange shape.
 */
export function reconcileProjectLayout(
  projectId: string,
  openSessionIds: readonly string[],
  stored: ProjectLayoutV1 | null,
  focusedSessionId?: string | null,
  opts?: {
    direction?: ArrangeMode | null;
    stageWidthPx?: number | null;
    /** When true, ignore preserve path (used only for hard resets). */
    forceRebuild?: boolean;
  },
): ProjectLayoutV1 | null {
  if (openSessionIds.length === 0) return null;

  const mode = resolveArrangeMode({
    explicit: opts?.direction,
    stored,
    projectId,
    stageWidthPx: opts?.stageWidthPx,
  });

  // Explicit arrange mode that differs from stored → rebuild (user clicked
  // row/col/2×2). Same-mode explicit (load path seeding from stored) preserves.
  const storedMode =
    stored && stored.projectId === projectId ? layoutArrangeMode(stored.root) : null;
  const modeChanged =
    opts?.direction != null && storedMode != null && opts.direction !== storedMode;

  if (!opts?.forceRebuild && !modeChanged && stored) {
    const preserved = preserveStoredLayout(projectId, openSessionIds, stored, focusedSessionId);
    if (preserved) return preserved;
  }

  // Focus preference for rebuild.
  let focus = focusedSessionId ?? null;
  if (!focus && stored?.projectId === projectId) {
    const prev = collectLeaves(stored.root).find((l) => l.id === stored.focusedLeafId);
    if (prev?.sessionId && openSessionIds.includes(prev.sessionId)) {
      focus = prev.sessionId;
    }
  }

  const stageSessionIds = openSessionIds.slice(0, MAX_STAGE_SESSIONS);
  if (focus && !stageSessionIds.includes(focus)) focus = stageSessionIds[0] ?? null;
  const layout = sessionLayoutForMode(projectId, stageSessionIds, mode, focus);
  if (!layout) return null;
  if (mode === 'grid2x2' || isGrid2x2Layout(layout.root)) {
    return layout;
  }
  return { ...layout, root: rebalanceEqualLeafWeights(layout.root) };
}

/**
 * Rebuild panes in a new arrange mode (row / col / 2×2), keeping focus.
 * This is the intentional "reset equal panes" path from the arrange toolbar.
 */
export function rearrangeProjectLayout(
  projectId: string,
  openSessionIds: readonly string[],
  mode: ArrangeMode,
  focusedSessionId?: string | null,
): ProjectLayoutV1 | null {
  return sessionLayoutForMode(
    projectId,
    openSessionIds.slice(0, MAX_STAGE_SESSIONS),
    mode,
    focusedSessionId,
  );
}

/** Put a session into an existing pane without changing split geometry. */
export function replaceLayoutLeafSession(
  layout: ProjectLayoutV1,
  leafId: string,
  sessionId: string,
): ProjectLayoutV1 {
  const replace = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') {
      return node.id === leafId ? { ...node, kind: 'session', sessionId } : node;
    }
    return { ...node, a: replace(node.a), b: replace(node.b) };
  };
  return { ...layout, root: replace(layout.root), focusedLeafId: leafId, zoomedLeafId: null };
}

/** After terminate: prune leaf and return null if empty. */
export function afterTerminateLayout(
  layout: ProjectLayoutV1 | null,
  remainingSessionIds: ReadonlySet<string>,
): ProjectLayoutV1 | null {
  if (!layout) return null;
  return pruneLayoutSessions(layout, remainingSessionIds);
}

/**
 * Focus = full-stage zoom of that agent; no selection = project multi-agent stage.
 *
 * - `selectedSessionId` set → focus that leaf AND zoom it (hide siblings).
 * - `selectedSessionId` null → clear zoom so every open agent is visible.
 */
export function applySelectionZoom(
  layout: ProjectLayoutV1,
  selectedSessionId: string | null,
): ProjectLayoutV1 {
  if (!selectedSessionId) {
    if (layout.zoomedLeafId == null) return layout;
    return { ...layout, zoomedLeafId: null };
  }
  const leaf = collectLeaves(layout.root).find((l) => l.sessionId === selectedSessionId);
  if (!leaf) return layout;
  if (layout.focusedLeafId === leaf.id && layout.zoomedLeafId === leaf.id) return layout;
  return { ...layout, focusedLeafId: leaf.id, zoomedLeafId: leaf.id };
}
