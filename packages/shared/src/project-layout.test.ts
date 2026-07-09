import { describe, expect, it } from 'vitest';
import {
  collectLeaves,
  countLeaves,
  defaultArrangeDirection,
  equalSessionLayout,
  layoutIsProjectScoped,
  layoutPrimaryDirection,
  parseProjectLayout,
  pruneLayoutSessions,
  rebalanceEqualLeafWeights,
  singleSessionLayout,
  splitLeaf,
  setZoomedLeaf,
  setSplitRatio,
  grid2x2SessionLayout,
  isGrid2x2Layout,
  layoutArrangeMode,
  type LayoutNode,
} from './project-layout.js';

/** Fraction of parent width each leaf receives (row splits only). */
function leafWidthShares(node: LayoutNode, parentShare = 1): number[] {
  if (node.type === 'leaf') return [parentShare];
  return [
    ...leafWidthShares(node.a, parentShare * node.ratio),
    ...leafWidthShares(node.b, parentShare * (1 - node.ratio)),
  ];
}

describe('project-layout', () => {
  it('parses single session layout', () => {
    const layout = singleSessionLayout('proj-1', 'sess-a');
    expect(parseProjectLayout(layout)).toEqual(layout);
    expect(collectLeaves(layout.root)).toHaveLength(1);
  });

  it('D4: rejects foreign session leaves', () => {
    const layout = singleSessionLayout('proj-1', 'sess-a');
    expect(layoutIsProjectScoped(layout, new Set(['sess-a']))).toBe(true);
    expect(layoutIsProjectScoped(layout, new Set(['sess-other']))).toBe(false);
  });

  it('splitLeaf adds a sibling session leaf', () => {
    const base = singleSessionLayout('proj-1', 'sess-a');
    const leafA = collectLeaves(base.root)[0]!;
    const next = splitLeaf(base, leafA.id, 'row', {
      type: 'leaf',
      id: 'leaf-b',
      kind: 'session',
      sessionId: 'sess-b',
    });
    const leaves = collectLeaves(next.root);
    expect(leaves).toHaveLength(2);
    expect(next.focusedLeafId).toBe('leaf-b');
    expect(layoutIsProjectScoped(next, new Set(['sess-a', 'sess-b']))).toBe(true);
  });

  it('prune removes terminated sessions and collapses splits', () => {
    const base = singleSessionLayout('proj-1', 'sess-a');
    const leafA = collectLeaves(base.root)[0]!;
    const split = splitLeaf(base, leafA.id, 'col', {
      type: 'leaf',
      id: 'leaf-b',
      kind: 'session',
      sessionId: 'sess-b',
    });
    const pruned = pruneLayoutSessions(split, new Set(['sess-a']));
    expect(pruned).not.toBeNull();
    expect(collectLeaves(pruned!.root)).toHaveLength(1);
    expect(collectLeaves(pruned!.root)[0]!.sessionId).toBe('sess-a');
  });

  it('zoom only allows known leaves', () => {
    const layout = singleSessionLayout('p', 's1');
    const leafId = collectLeaves(layout.root)[0]!.id;
    expect(setZoomedLeaf(layout, leafId).zoomedLeafId).toBe(leafId);
    expect(setZoomedLeaf(layout, 'nope').zoomedLeafId).toBeNull();
  });

  it('setSplitRatio updates the named split and clamps', () => {
    const base = singleSessionLayout('p', 'a');
    const leafA = collectLeaves(base.root)[0]!;
    const layout = splitLeaf(base, leafA.id, 'row', {
      type: 'leaf',
      id: 'leaf-b',
      kind: 'session',
      sessionId: 'b',
    });
    const splitId = layout.root.type === 'split' ? layout.root.id : '';
    expect(splitId).toBeTruthy();
    const resized = setSplitRatio(layout, splitId, 0.25);
    expect(resized.root.type).toBe('split');
    if (resized.root.type === 'split') expect(resized.root.ratio).toBeCloseTo(0.25);
    const clamped = setSplitRatio(layout, splitId, 0.99);
    if (clamped.root.type === 'split') expect(clamped.root.ratio).toBeCloseTo(0.95);
    expect(setSplitRatio(layout, 'missing', 0.3)).toBe(layout);
  });

  it('rejects invalid version', () => {
    expect(parseProjectLayout({ version: 2, projectId: 'p', focusedLeafId: 'x', root: {} })).toBeNull();
  });

  it('equalSessionLayout gives each of 3 agents equal width (row)', () => {
    const layout = equalSessionLayout('p', ['a', 'b', 'c'], 'b', 'row')!;
    expect(countLeaves(layout.root)).toBe(3);
    expect(layoutPrimaryDirection(layout.root)).toBe('row');
    const shares = leafWidthShares(layout.root);
    expect(shares).toHaveLength(3);
    for (const s of shares) {
      expect(s).toBeCloseTo(1 / 3, 5);
    }
    expect(collectLeaves(layout.root).find((l) => l.id === layout.focusedLeafId)?.sessionId).toBe(
      'b',
    );
  });

  it('equalSessionLayout stacks equally when direction is col', () => {
    const layout = equalSessionLayout('p', ['a', 'b', 'c'], null, 'col')!;
    expect(layoutPrimaryDirection(layout.root)).toBe('col');
    // Same ratio math as row — equal share along the stack axis.
    const shares = leafWidthShares(layout.root);
    for (const s of shares) {
      expect(s).toBeCloseTo(1 / 3, 5);
    }
    // Every split uses col.
    function allCol(n: LayoutNode): boolean {
      if (n.type === 'leaf') return true;
      return n.direction === 'col' && allCol(n.a) && allCol(n.b);
    }
    expect(allCol(layout.root)).toBe(true);
  });

  it('defaultArrangeDirection stacks when stage is narrow', () => {
    expect(defaultArrangeDirection(null)).toBe('row');
    expect(defaultArrangeDirection(1200)).toBe('row');
    expect(defaultArrangeDirection(800)).toBe('col');
  });

  it('grid2x2SessionLayout builds a 2×2 for 4 agents', () => {
    const layout = grid2x2SessionLayout('p', ['a', 'b', 'c', 'd'], 'c')!;
    expect(countLeaves(layout.root)).toBe(4);
    expect(isGrid2x2Layout(layout.root)).toBe(true);
    expect(layoutArrangeMode(layout.root)).toBe('grid2x2');
    expect(layout.root.type).toBe('split');
    if (layout.root.type === 'split') {
      expect(layout.root.direction).toBe('col');
      expect(layout.root.ratio).toBeCloseTo(0.5);
      expect(layout.root.a.type).toBe('split');
      expect(layout.root.b.type).toBe('split');
      if (layout.root.a.type === 'split') expect(layout.root.a.direction).toBe('row');
      if (layout.root.b.type === 'split') expect(layout.root.b.direction).toBe('row');
    }
    expect(collectLeaves(layout.root).map((l) => l.sessionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(collectLeaves(layout.root).find((l) => l.id === layout.focusedLeafId)?.sessionId).toBe(
      'c',
    );
  });

  it('grid2x2SessionLayout puts 3 agents as 2 top + 1 bottom', () => {
    const layout = grid2x2SessionLayout('p', ['a', 'b', 'c'])!;
    expect(isGrid2x2Layout(layout.root)).toBe(true);
    expect(layout.root.type).toBe('split');
    if (layout.root.type === 'split') {
      expect(layout.root.a.type).toBe('split'); // top row of 2
      expect(layout.root.b.type).toBe('leaf'); // bottom full-width
      if (layout.root.b.type === 'leaf') expect(layout.root.b.sessionId).toBe('c');
    }
  });

  it('grid2x2 degrades for 2 agents and falls back for 5+', () => {
    const two = grid2x2SessionLayout('p', ['a', 'b'])!;
    expect(layoutArrangeMode(two.root)).toBe('row');
    const five = grid2x2SessionLayout('p', ['a', 'b', 'c', 'd', 'e'])!;
    expect(countLeaves(five.root)).toBe(5);
    expect(isGrid2x2Layout(five.root)).toBe(false);
  });

  it('pure col stack is not detected as grid2x2', () => {
    const stacked = equalSessionLayout('p', ['a', 'b', 'c'], null, 'col')!;
    expect(isGrid2x2Layout(stacked.root)).toBe(false);
    expect(layoutArrangeMode(stacked.root)).toBe('col');
  });

  it('rebalanceEqualLeafWeights fixes nested 0.5/0.5 starvation', () => {
    // Classic bug: first agent 50%, other two 25% each.
    const unbalanced = splitLeaf(
      splitLeaf(singleSessionLayout('p', 'a'), 'leaf-a', 'row', {
        type: 'leaf',
        id: 'leaf-b',
        kind: 'session',
        sessionId: 'b',
      }),
      'leaf-b',
      'row',
      { type: 'leaf', id: 'leaf-c', kind: 'session', sessionId: 'c' },
    );
    const before = leafWidthShares(unbalanced.root);
    expect(Math.max(...before) - Math.min(...before)).toBeGreaterThan(0.1);

    const fixed = { ...unbalanced, root: rebalanceEqualLeafWeights(unbalanced.root) };
    const after = leafWidthShares(fixed.root);
    for (const s of after) {
      expect(s).toBeCloseTo(1 / 3, 5);
    }
  });
});
