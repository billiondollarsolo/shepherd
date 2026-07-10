/**
 * Project-on-node split layouts (Phase 3 / D4).
 * Opaque tree authored by the web; stored on agentd + orchestrator mirror.
 */
import { z } from 'zod';

export const LayoutLeafSchema = z.object({
  type: z.literal('leaf'),
  id: z.string().min(1),
  kind: z.enum(['session', 'shell']),
  sessionId: z.string().optional(),
  shellKey: z.string().optional(),
});
export type LayoutLeaf = z.infer<typeof LayoutLeafSchema>;

export type LayoutNode =
  | {
      type: 'split';
      id: string;
      direction: 'row' | 'col';
      ratio: number;
      a: LayoutNode;
      b: LayoutNode;
    }
  | LayoutLeaf;

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    LayoutLeafSchema,
    z.object({
      type: z.literal('split'),
      id: z.string().min(1),
      direction: z.enum(['row', 'col']),
      ratio: z.number().gt(0).lt(1),
      a: LayoutNodeSchema,
      b: LayoutNodeSchema,
    }),
  ]),
);

export const ProjectLayoutV1Schema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  focusedLeafId: z.string().min(1),
  zoomedLeafId: z.string().nullable().optional(),
  root: LayoutNodeSchema,
});
export type ProjectLayoutV1 = z.infer<typeof ProjectLayoutV1Schema>;

export function parseProjectLayout(raw: unknown): ProjectLayoutV1 | null {
  const r = ProjectLayoutV1Schema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Default single-leaf layout for one session. */
export function singleSessionLayout(projectId: string, sessionId: string): ProjectLayoutV1 {
  const leafId = `leaf-${sessionId}`;
  return {
    version: 1,
    projectId,
    focusedLeafId: leafId,
    zoomedLeafId: null,
    root: { type: 'leaf', id: leafId, kind: 'session', sessionId },
  };
}

/**
 * Count session/shell leaves under a node (for equal-weight split ratios).
 */
export function countLeaves(node: LayoutNode): number {
  if (node.type === 'leaf') return 1;
  return countLeaves(node.a) + countLeaves(node.b);
}

/**
 * Rebalance every split's `ratio` so each leaf gets equal space along the split
 * direction. Nested 0.5/0.5 trees otherwise give the first agent ~50% and the
 * rest ~25%/25% for three agents (or worse for more).
 *
 * Example (3 leaves, row): root ratio = 1/3 or 2/3 depending on tree shape, so
 * each column ends up at 1/3 width.
 */
export function rebalanceEqualLeafWeights(node: LayoutNode): LayoutNode {
  if (node.type === 'leaf') return node;
  const a = rebalanceEqualLeafWeights(node.a);
  const b = rebalanceEqualLeafWeights(node.b);
  const aN = countLeaves(a);
  const bN = countLeaves(b);
  const total = aN + bN;
  // Keep ratio in (0,1); zod rejects 0/1.
  const ratio = total > 0 ? Math.min(0.99, Math.max(0.01, aN / total)) : 0.5;
  return { ...node, a, b, ratio };
}

/** Split axis for multi-agent arrange (matches Herdr: right≈row, down≈col). */
export type ArrangeDirection = 'row' | 'col';

/**
 * Multi-agent arrange preset:
 *   - `row` / `col` — equal binary tree along one axis
 *   - `grid2x2` — 2×2 box (top row + bottom row), best for 3–4 agents
 */
export type ArrangeMode = ArrangeDirection | 'grid2x2';

/**
 * Read the primary arrange direction from a layout tree (root split, else row).
 * For a 2×2 grid (root col with row children) this returns `col` — use
 * {@link layoutArrangeMode} when the UI needs to know "2×2" specifically.
 */
export function layoutPrimaryDirection(root: LayoutNode): ArrangeDirection {
  if (root.type === 'leaf') return 'row';
  return root.direction;
}

/** True when the tree is a 2×2-style grid: root col, each side a row or leaf. */
export function isGrid2x2Layout(root: LayoutNode): boolean {
  if (root.type !== 'split' || root.direction !== 'col') return false;
  const rowOrLeaf = (n: LayoutNode): boolean =>
    n.type === 'leaf' || (n.type === 'split' && n.direction === 'row');
  // At least one side must actually be a row. A two-leaf vertical stack also
  // has a col root with leaf children, but it is the `col` preset—not a grid.
  const hasRow =
    (root.a.type === 'split' && root.a.direction === 'row') ||
    (root.b.type === 'split' && root.b.direction === 'row');
  return hasRow && rowOrLeaf(root.a) && rowOrLeaf(root.b);
}

/** Detect which arrange preset a live layout matches (for toolbar pressed state). */
export function layoutArrangeMode(root: LayoutNode): ArrangeMode {
  if (isGrid2x2Layout(root)) return 'grid2x2';
  return layoutPrimaryDirection(root);
}

/**
 * Default multi-agent arrange from stage width (Herdr-ish: columns when wide,
 * stacked rows when narrow). Threshold is CSS pixels of the stage, not viewport.
 */
export function defaultArrangeDirection(stageWidthPx: number | null | undefined): ArrangeDirection {
  if (stageWidthPx != null && stageWidthPx > 0 && stageWidthPx < 900) return 'col';
  return 'row';
}

/**
 * Build a balanced binary tree of session leaves with equal visual weight.
 * Prefer this over repeated splitLeaf(..., 0.5) which starves later agents.
 *
 * @param direction `row` = side-by-side columns; `col` = stacked rows.
 */
export function equalSessionLayout(
  projectId: string,
  sessionIds: readonly string[],
  focusedSessionId?: string | null,
  direction: ArrangeDirection = 'row',
): ProjectLayoutV1 | null {
  if (sessionIds.length === 0) return null;

  const build = (ids: readonly string[]): LayoutNode => {
    if (ids.length === 1) {
      const sid = ids[0]!;
      return { type: 'leaf', id: `leaf-${sid}`, kind: 'session', sessionId: sid };
    }
    const mid = Math.ceil(ids.length / 2);
    const left = ids.slice(0, mid);
    const right = ids.slice(mid);
    const a = build(left);
    const b = build(right);
    const ratio = left.length / ids.length;
    return {
      type: 'split',
      id: `split-${left[0]}-${right[right.length - 1]}`,
      direction,
      ratio: Math.min(0.99, Math.max(0.01, ratio)),
      a,
      b,
    };
  };

  const root = rebalanceEqualLeafWeights(build(sessionIds));
  const leaves = collectLeaves(root);
  let focusedLeafId = leaves[0]!.id;
  if (focusedSessionId) {
    const hit = leaves.find((l) => l.sessionId === focusedSessionId);
    if (hit) focusedLeafId = hit.id;
  }
  return {
    version: 1,
    projectId,
    focusedLeafId,
    zoomedLeafId: null,
    root,
  };
}

function sessionLeaf(sessionId: string): LayoutLeaf {
  return { type: 'leaf', id: `leaf-${sessionId}`, kind: 'session', sessionId };
}

/** One row of 1–2 session leaves (equal width when 2). */
function rowOfSessions(ids: readonly string[]): LayoutNode {
  if (ids.length === 0) {
    throw new Error('rowOfSessions requires at least one id');
  }
  if (ids.length === 1) return sessionLeaf(ids[0]!);
  const a = ids[0]!;
  const b = ids[1]!;
  return {
    type: 'split',
    id: `split-row-${a}-${b}`,
    direction: 'row',
    ratio: 0.5,
    a: sessionLeaf(a),
    b: sessionLeaf(b),
  };
}

/**
 * 2×2 box layout (row-major fill):
 *
 *   [ 0 | 1 ]
 *   [ 2 | 3 ]
 *
 * - 1 agent → single leaf
 * - 2 agents → one row (same as side-by-side)
 * - 3 agents → top row of 2, bottom full-width third
 * - 4 agents → true 2×2
 * - 5+ → fall back to equal row tree (use row/col presets for dense flocks)
 */
export function grid2x2SessionLayout(
  projectId: string,
  sessionIds: readonly string[],
  focusedSessionId?: string | null,
): ProjectLayoutV1 | null {
  if (sessionIds.length === 0) return null;
  if (sessionIds.length === 1) {
    return equalSessionLayout(projectId, sessionIds, focusedSessionId, 'row');
  }
  if (sessionIds.length === 2) {
    return equalSessionLayout(projectId, sessionIds, focusedSessionId, 'row');
  }
  if (sessionIds.length > 4) {
    return equalSessionLayout(projectId, sessionIds, focusedSessionId, 'row');
  }

  const top = sessionIds.slice(0, 2);
  const bottom = sessionIds.slice(2);
  const root: LayoutNode = {
    type: 'split',
    id: `split-grid2x2-${sessionIds[0]}-${sessionIds[sessionIds.length - 1]}`,
    direction: 'col',
    ratio: 0.5,
    a: rowOfSessions(top),
    b: rowOfSessions(bottom),
  };

  const leaves = collectLeaves(root);
  let focusedLeafId = leaves[0]!.id;
  if (focusedSessionId) {
    const hit = leaves.find((l) => l.sessionId === focusedSessionId);
    if (hit) focusedLeafId = hit.id;
  }
  return {
    version: 1,
    projectId,
    focusedLeafId,
    zoomedLeafId: null,
    root,
  };
}

/**
 * Build a layout for any arrange preset.
 */
export function sessionLayoutForMode(
  projectId: string,
  sessionIds: readonly string[],
  mode: ArrangeMode,
  focusedSessionId?: string | null,
): ProjectLayoutV1 | null {
  if (mode === 'grid2x2') {
    return grid2x2SessionLayout(projectId, sessionIds, focusedSessionId);
  }
  return equalSessionLayout(projectId, sessionIds, focusedSessionId, mode);
}

/** Collect all session ids referenced by leaves. */
export function layoutSessionIds(node: LayoutNode): string[] {
  if (node.type === 'leaf') {
    return node.kind === 'session' && node.sessionId ? [node.sessionId] : [];
  }
  return [...layoutSessionIds(node.a), ...layoutSessionIds(node.b)];
}

export function collectLeaves(node: LayoutNode): LayoutLeaf[] {
  if (node.type === 'leaf') return [node];
  return [...collectLeaves(node.a), ...collectLeaves(node.b)];
}

/**
 * D4: every session leaf must belong to allowedSessionIds (same project).
 * Returns false if any foreign session is present.
 */
export function layoutIsProjectScoped(
  layout: ProjectLayoutV1,
  allowedSessionIds: ReadonlySet<string>,
): boolean {
  for (const id of layoutSessionIds(layout.root)) {
    if (!allowedSessionIds.has(id)) return false;
  }
  return true;
}

/** Remove leaves whose session was terminated; collapse splits to remaining side. */
export function pruneLayoutSessions(
  layout: ProjectLayoutV1,
  liveSessionIds: ReadonlySet<string>,
): ProjectLayoutV1 | null {
  const pruned = pruneNode(layout.root, liveSessionIds);
  if (!pruned) return null;
  const leaves = collectLeaves(pruned);
  if (leaves.length === 0) return null;
  let focused = layout.focusedLeafId;
  if (!leaves.some((l) => l.id === focused)) {
    focused = leaves[0]!.id;
  }
  let zoomed = layout.zoomedLeafId ?? null;
  if (zoomed && !leaves.some((l) => l.id === zoomed)) {
    zoomed = null;
  }
  return {
    ...layout,
    root: pruned,
    focusedLeafId: focused,
    zoomedLeafId: zoomed,
  };
}

function pruneNode(node: LayoutNode, live: ReadonlySet<string>): LayoutNode | null {
  if (node.type === 'leaf') {
    if (node.kind === 'shell') return node;
    if (node.sessionId && live.has(node.sessionId)) return node;
    return null;
  }
  const a = pruneNode(node.a, live);
  const b = pruneNode(node.b, live);
  if (a && b) return { ...node, a, b };
  return a ?? b;
}

/** Split focused leaf: put existing leaf on side a, new leaf on b. */
export function splitLeaf(
  layout: ProjectLayoutV1,
  targetLeafId: string,
  direction: 'row' | 'col',
  newLeaf: LayoutLeaf,
  ratio = 0.5,
): ProjectLayoutV1 {
  const root = mapNode(layout.root, (n) => {
    if (n.type === 'leaf' && n.id === targetLeafId) {
      return {
        type: 'split' as const,
        id: `split-${targetLeafId}-${newLeaf.id}`,
        direction,
        ratio,
        a: n,
        b: newLeaf,
      };
    }
    return n;
  });
  return {
    ...layout,
    root,
    focusedLeafId: newLeaf.id,
    zoomedLeafId: null,
  };
}

function mapNode(node: LayoutNode, fn: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (node.type === 'leaf') return fn(node);
  const mapped: LayoutNode = {
    ...node,
    a: mapNode(node.a, fn),
    b: mapNode(node.b, fn),
  };
  return fn(mapped);
}

export function setFocusedLeaf(layout: ProjectLayoutV1, leafId: string): ProjectLayoutV1 {
  const leaves = collectLeaves(layout.root);
  if (!leaves.some((l) => l.id === leafId)) return layout;
  return { ...layout, focusedLeafId: leafId };
}

/**
 * Set the split ratio for a split node by id (drag-resize). Clamps to (0.05, 0.95)
 * so neither pane collapses fully. No-op when the id is missing or not a split.
 */
export function setSplitRatio(
  layout: ProjectLayoutV1,
  splitId: string,
  ratio: number,
): ProjectLayoutV1 {
  const clamped = Math.min(0.95, Math.max(0.05, ratio));
  let found = false;
  const root = mapNode(layout.root, (n) => {
    if (n.type === 'split' && n.id === splitId) {
      found = true;
      if (Math.abs(n.ratio - clamped) < 0.0005) return n;
      return { ...n, ratio: clamped };
    }
    return n;
  });
  return found ? { ...layout, root } : layout;
}

export function setZoomedLeaf(layout: ProjectLayoutV1, leafId: string | null): ProjectLayoutV1 {
  if (leafId === null) return { ...layout, zoomedLeafId: null };
  const leaves = collectLeaves(layout.root);
  if (!leaves.some((l) => l.id === leafId)) return layout;
  return { ...layout, zoomedLeafId: leafId };
}
