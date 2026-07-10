import { describe, expect, it } from 'vitest';
import {
  afterTerminateLayout,
  applySelectionZoom,
  layoutFromSessions,
  rearrangeProjectLayout,
  reconcileProjectLayout,
  resolveArrangeMode,
} from './projectLayoutState';
import {
  collectLeaves,
  isGrid2x2Layout,
  layoutArrangeMode,
  layoutIsProjectScoped,
  layoutPrimaryDirection,
  singleSessionLayout,
} from '@flock/shared';

describe('projectLayoutState (production reconcile)', () => {
  it('layoutFromSessions builds multi-leaf project-scoped layout with equal weights', () => {
    const layout = layoutFromSessions('p1', ['a', 'b', 'c'], 'b');
    expect(layout).not.toBeNull();
    const leaves = collectLeaves(layout!.root);
    expect(leaves).toHaveLength(3);
    expect(layoutIsProjectScoped(layout!, new Set(['a', 'b', 'c']))).toBe(true);
    expect(collectLeaves(layout!.root).find((l) => l.id === layout!.focusedLeafId)?.sessionId).toBe(
      'b',
    );
    // 3 equal columns — no first-agent 50% starvation
    function shares(node: (typeof layout)['root'], w = 1): number[] {
      if (node.type === 'leaf') return [w];
      return [...shares(node.a, w * node.ratio), ...shares(node.b, w * (1 - node.ratio))];
    }
    for (const s of shares(layout!.root)) {
      expect(s).toBeCloseTo(1 / 3, 5);
    }
  });

  it('reconcile prunes terminated and adds new sessions', () => {
    const stored = layoutFromSessions('p1', ['a', 'b'], 'a')!;
    const next = reconcileProjectLayout('p1', ['b', 'c'], stored, 'c');
    expect(next).not.toBeNull();
    const ids = collectLeaves(next!.root)
      .map((l) => l.sessionId)
      .sort();
    expect(ids).toEqual(['b', 'c']);
  });

  it('D4: stored layout with only foreign sessions is replaced', () => {
    const foreign = singleSessionLayout('p1', 'other');
    const next = reconcileProjectLayout('p1', ['mine'], foreign, 'mine');
    expect(next).not.toBeNull();
    expect(collectLeaves(next!.root).every((l) => l.sessionId === 'mine')).toBe(true);
  });

  it('afterTerminateLayout prunes and returns null when empty', () => {
    const layout = singleSessionLayout('p1', 'a');
    expect(afterTerminateLayout(layout, new Set())).toBeNull();
    const multi = layoutFromSessions('p1', ['a', 'b'])!;
    const pruned = afterTerminateLayout(multi, new Set(['b']));
    expect(collectLeaves(pruned!.root)).toHaveLength(1);
    expect(collectLeaves(pruned!.root)[0]!.sessionId).toBe('b');
  });

  it('applySelectionZoom: focus zooms that agent; clear selection unzooms all', () => {
    const multi = layoutFromSessions('p1', ['a', 'b'], 'a')!;
    expect(multi.zoomedLeafId == null || multi.zoomedLeafId === undefined).toBe(true);

    const focused = applySelectionZoom(multi, 'b');
    const leafB = collectLeaves(focused.root).find((l) => l.sessionId === 'b')!;
    expect(focused.focusedLeafId).toBe(leafB.id);
    expect(focused.zoomedLeafId).toBe(leafB.id);

    const all = applySelectionZoom(focused, null);
    expect(all.zoomedLeafId).toBeNull();
    // Focused leaf can stay; zoom is what controls visibility.
    expect(all.focusedLeafId).toBe(leafB.id);
  });

  it('applySelectionZoom is a no-op when already correct', () => {
    const multi = layoutFromSessions('p1', ['a', 'b'], 'a')!;
    const leafA = collectLeaves(multi.root).find((l) => l.sessionId === 'a')!;
    const zoomed = { ...multi, focusedLeafId: leafA.id, zoomedLeafId: leafA.id };
    expect(applySelectionZoom(zoomed, 'a')).toBe(zoomed);
    const clear = { ...multi, zoomedLeafId: null };
    expect(applySelectionZoom(clear, null)).toBe(clear);
  });

  it('resolveArrangeMode prefers explicit then stored then width', () => {
    const stored = layoutFromSessions('p1', ['a', 'b'], null, 'col')!;
    expect(
      resolveArrangeMode({ explicit: 'row', stored, projectId: 'p1', stageWidthPx: 500 }),
    ).toBe('row');
    expect(resolveArrangeMode({ explicit: null, stored, projectId: 'p1', stageWidthPx: 500 })).toBe(
      'col',
    );
    expect(
      resolveArrangeMode({
        explicit: null,
        stored: null,
        projectId: 'p1',
        stageWidthPx: 500,
      }),
    ).toBe('col');
    expect(
      resolveArrangeMode({
        explicit: null,
        stored: null,
        projectId: 'p1',
        stageWidthPx: 1200,
      }),
    ).toBe('row');
  });

  it('rearrangeProjectLayout flips row ↔ col with equal panes', () => {
    const row = rearrangeProjectLayout('p1', ['a', 'b', 'c'], 'row', 'b')!;
    expect(layoutPrimaryDirection(row.root)).toBe('row');
    const col = rearrangeProjectLayout('p1', ['a', 'b', 'c'], 'col', 'b')!;
    expect(layoutPrimaryDirection(col.root)).toBe('col');
    expect(collectLeaves(col.root).find((l) => l.id === col.focusedLeafId)?.sessionId).toBe('b');
  });

  it('rearrangeProjectLayout grid2x2 builds a box for 3–4 agents', () => {
    const g3 = rearrangeProjectLayout('p1', ['a', 'b', 'c'], 'grid2x2', 'a')!;
    expect(layoutArrangeMode(g3.root)).toBe('grid2x2');
    expect(isGrid2x2Layout(g3.root)).toBe(true);
    const g4 = rearrangeProjectLayout('p1', ['a', 'b', 'c', 'd'], 'grid2x2', 'd')!;
    expect(isGrid2x2Layout(g4.root)).toBe(true);
    expect(collectLeaves(g4.root).find((l) => l.id === g4.focusedLeafId)?.sessionId).toBe('d');
  });

  it('reconcile honors explicit direction over stored', () => {
    const stored = layoutFromSessions('p1', ['a', 'b'], null, 'row')!;
    const next = reconcileProjectLayout('p1', ['a', 'b', 'c'], stored, null, {
      direction: 'col',
    })!;
    expect(layoutPrimaryDirection(next.root)).toBe('col');
  });

  it('reconcile honors explicit grid2x2 over stored row', () => {
    const stored = layoutFromSessions('p1', ['a', 'b', 'c', 'd'], null, 'row')!;
    const next = reconcileProjectLayout('p1', ['a', 'b', 'c', 'd'], stored, null, {
      direction: 'grid2x2',
    })!;
    expect(layoutArrangeMode(next.root)).toBe('grid2x2');
  });

  it('reconcile preserves stored ratios when open set is unchanged (refresh)', () => {
    const stored = layoutFromSessions('p1', ['a', 'b', 'c'], 'a', 'row')!;
    // Simulate a user drag on the root split.
    expect(stored.root.type).toBe('split');
    const dragged =
      stored.root.type === 'split'
        ? {
            ...stored,
            root: { ...stored.root, ratio: 0.22 },
          }
        : stored;
    const next = reconcileProjectLayout('p1', ['a', 'b', 'c'], dragged, null, {
      // Load path seeds explicit mode FROM stored — must still preserve ratios.
      direction: 'row',
    })!;
    expect(next.root.type).toBe('split');
    if (next.root.type === 'split') {
      expect(next.root.ratio).toBeCloseTo(0.22, 5);
    }
  });

  it('reconcile preserves grid2x2 ratios when session set is unchanged', () => {
    const stored = rearrangeProjectLayout('p1', ['a', 'b', 'c', 'd'], 'grid2x2', 'a')!;
    expect(stored.root.type).toBe('split');
    const dragged =
      stored.root.type === 'split' ? { ...stored, root: { ...stored.root, ratio: 0.35 } } : stored;
    const next = reconcileProjectLayout('p1', ['a', 'b', 'c', 'd'], dragged, 'b', {
      direction: 'grid2x2',
    })!;
    expect(layoutArrangeMode(next.root)).toBe('grid2x2');
    expect(next.root.type).toBe('split');
    if (next.root.type === 'split') expect(next.root.ratio).toBeCloseTo(0.35, 5);
    expect(collectLeaves(next.root).find((l) => l.id === next.focusedLeafId)?.sessionId).toBe('b');
  });

  it('reconcile prunes a terminated session without equal-rebuilding survivors', () => {
    const stored = layoutFromSessions('p1', ['a', 'b'], null, 'row')!;
    const dragged =
      stored.root.type === 'split' ? { ...stored, root: { ...stored.root, ratio: 0.7 } } : stored;
    // Only a remains after b terminates — single leaf, no ratio to keep.
    const next = reconcileProjectLayout('p1', ['a'], dragged, null)!;
    expect(collectLeaves(next.root).map((l) => l.sessionId)).toEqual(['a']);
  });
});
