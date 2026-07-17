import { beforeEach, describe, expect, it } from 'vitest';
import { resolveTreeExpanded, treeKeydownAction, usePaddock, type TreeRow } from './paddock';

// A flattened, fully-expanded tree: node → project → sessions, plus a collapsed
// sibling project and a collapsed sibling node (mirrors the sidebar DOM order).
const ROWS: TreeRow[] = [
  { id: 'n1', level: 1, expandable: true, expanded: true },
  { id: 'p1', level: 2, expandable: true, expanded: true },
  { id: 's1', level: 3, expandable: false, expanded: false },
  { id: 's2', level: 3, expandable: false, expanded: false },
  { id: 'p2', level: 2, expandable: true, expanded: false },
  { id: 'n2', level: 1, expandable: true, expanded: false },
];

describe('resolveTreeExpanded (persist + attention seeding, task 7.3)', () => {
  it('honours an explicit persisted override over everything else', () => {
    expect(resolveTreeExpanded(true, false)).toBe(true);
    expect(resolveTreeExpanded(false, true)).toBe(false); // override wins over attention
  });

  it('seeds attention branches OPEN when there is no override', () => {
    expect(resolveTreeExpanded(undefined, true, false)).toBe(true);
    expect(resolveTreeExpanded(undefined, true, true)).toBe(true);
  });

  it('falls back to defaultOpen for calm branches with no override', () => {
    expect(resolveTreeExpanded(undefined, false)).toBe(true); // default is open
    expect(resolveTreeExpanded(undefined, false, false)).toBe(false);
  });
});

describe('treeKeydownAction (roving-tabindex traversal model, task 7.3)', () => {
  it('moves down/up between visible rows and stops at the ends', () => {
    expect(treeKeydownAction(ROWS, 'n1', 'ArrowDown')).toEqual({ kind: 'focus', id: 'p1' });
    expect(treeKeydownAction(ROWS, 'p1', 'ArrowUp')).toEqual({ kind: 'focus', id: 'n1' });
    expect(treeKeydownAction(ROWS, 'n1', 'ArrowUp')).toBeNull();
    expect(treeKeydownAction(ROWS, 'n2', 'ArrowDown')).toBeNull();
  });

  it('Home/End jump to the first/last row', () => {
    expect(treeKeydownAction(ROWS, 's1', 'Home')).toEqual({ kind: 'focus', id: 'n1' });
    expect(treeKeydownAction(ROWS, 'n1', 'End')).toEqual({ kind: 'focus', id: 'n2' });
  });

  it('ArrowRight expands a collapsed branch, else steps into the first child', () => {
    expect(treeKeydownAction(ROWS, 'p2', 'ArrowRight')).toEqual({ kind: 'expand', id: 'p2' });
    expect(treeKeydownAction(ROWS, 'n1', 'ArrowRight')).toEqual({ kind: 'focus', id: 'p1' });
  });

  it('ArrowRight on a leaf does nothing', () => {
    expect(treeKeydownAction(ROWS, 's1', 'ArrowRight')).toBeNull();
  });

  it('ArrowLeft collapses an expanded branch, else moves out to the parent', () => {
    expect(treeKeydownAction(ROWS, 'n1', 'ArrowLeft')).toEqual({ kind: 'collapse', id: 'n1' });
    // Leaf s1 (level 3) → nearest shallower ancestor is p1.
    expect(treeKeydownAction(ROWS, 's1', 'ArrowLeft')).toEqual({ kind: 'focus', id: 'p1' });
    // Collapsed project p2 (level 2) → its node n1.
    expect(treeKeydownAction(ROWS, 'p2', 'ArrowLeft')).toEqual({ kind: 'focus', id: 'n1' });
  });

  it('Enter/Space activate the current row', () => {
    expect(treeKeydownAction(ROWS, 's1', 'Enter')).toEqual({ kind: 'activate', id: 's1' });
    expect(treeKeydownAction(ROWS, 'p1', ' ')).toEqual({ kind: 'activate', id: 'p1' });
  });

  it('ignores unknown ids and unhandled keys', () => {
    expect(treeKeydownAction(ROWS, 'missing', 'ArrowDown')).toBeNull();
    expect(treeKeydownAction(ROWS, 'n1', 'x')).toBeNull();
  });
});

describe('setTreeExpanded persistence (task 7.3)', () => {
  beforeEach(() => {
    localStorage.clear();
    usePaddock.setState({ treeExpanded: {} });
  });

  it('records an override in the store and persists it to localStorage', () => {
    usePaddock.getState().setTreeExpanded('branch-a', false);
    expect(usePaddock.getState().treeExpanded['branch-a']).toBe(false);
    const raw = localStorage.getItem('flock.treeExpanded');
    expect(raw && JSON.parse(raw)).toEqual({ 'branch-a': false });
  });

  it('toggles an existing override without dropping others', () => {
    usePaddock.getState().setTreeExpanded('branch-a', false);
    usePaddock.getState().setTreeExpanded('branch-b', true);
    usePaddock.getState().setTreeExpanded('branch-a', true);
    expect(usePaddock.getState().treeExpanded).toEqual({ 'branch-a': true, 'branch-b': true });
  });
});
