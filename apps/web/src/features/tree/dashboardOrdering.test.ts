import { describe, it, expect } from 'vitest';
import type { Status } from '@flock/shared';
import { groupAttentionRank, sortGroupsByAttention, type OrderableSession } from './ordering';

const s = (id: string, status: Status): OrderableSession => ({ id, status });

/**
 * US-32 — the tree as a supervision dashboard.
 *
 * US-23 ordered SESSIONS within a project by attention. US-32 makes the WHOLE
 * tree a "which agent needs me" view: the Project and Node branches that contain
 * the most-urgent session must themselves bubble to the top, so the user scans
 * top-to-bottom and the work that needs them is always first.
 *
 * `groupAttentionRank` collapses a branch's sessions to its single best
 * (lowest) attention rank; `sortGroupsByAttention` is the stable comparator that
 * orders branches by that rank.
 */
describe('groupAttentionRank (US-32, FR-UI3)', () => {
  it('is the BEST (lowest) attention rank among the branch sessions', () => {
    // awaiting_input (rank 0) beats running (rank 5) and idle (rank 3).
    const rank = groupAttentionRank([s('a', 'running'), s('b', 'awaiting_input'), s('c', 'idle')]);
    const onlyRunning = groupAttentionRank([s('a', 'running')]);
    expect(rank).toBeLessThan(onlyRunning);
  });

  it('ranks an error branch above an all-idle branch', () => {
    expect(groupAttentionRank([s('a', 'error')])).toBeLessThan(
      groupAttentionRank([s('a', 'idle')]),
    );
  });

  it('ranks an awaiting_input branch above an error branch', () => {
    expect(groupAttentionRank([s('a', 'awaiting_input')])).toBeLessThan(
      groupAttentionRank([s('a', 'error')]),
    );
  });

  it('sinks an empty branch to the bottom (nothing to supervise)', () => {
    expect(groupAttentionRank([])).toBeGreaterThan(groupAttentionRank([s('a', 'disconnected')]));
  });
});

describe('sortGroupsByAttention (US-32, FR-UI3)', () => {
  it('bubbles the branch containing the most-urgent session to the top', () => {
    const calm = { id: 'calm', sessions: [s('1', 'running'), s('2', 'idle')] };
    const urgent = { id: 'urgent', sessions: [s('3', 'idle'), s('4', 'awaiting_input')] };
    const ordered = sortGroupsByAttention([calm, urgent], (g) => g.sessions).map((g) => g.id);
    expect(ordered).toEqual(['urgent', 'calm']);
  });

  it('orders awaiting_input branch above error branch above calm branch', () => {
    const groups = [
      { id: 'calm', sessions: [s('1', 'running')] },
      { id: 'await', sessions: [s('2', 'awaiting_input')] },
      { id: 'err', sessions: [s('3', 'error')] },
    ];
    const ordered = sortGroupsByAttention(groups, (g) => g.sessions).map((g) => g.id);
    expect(ordered).toEqual(['await', 'err', 'calm']);
  });

  it('is a stable sort: equal-attention branches keep input order', () => {
    const groups = [
      { id: 'b', sessions: [s('1', 'running')] },
      { id: 'a', sessions: [s('2', 'running')] },
      { id: 'c', sessions: [s('3', 'running')] },
    ];
    const ordered = sortGroupsByAttention(groups, (g) => g.sessions).map((g) => g.id);
    expect(ordered).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const groups = [
      { id: 'calm', sessions: [s('1', 'running')] },
      { id: 'urgent', sessions: [s('2', 'awaiting_input')] },
    ];
    const before = groups.map((g) => g.id);
    sortGroupsByAttention(groups, (g) => g.sessions);
    expect(groups.map((g) => g.id)).toEqual(before);
  });

  it('handles an empty list of groups', () => {
    expect(sortGroupsByAttention([], (g: { sessions: OrderableSession[] }) => g.sessions)).toEqual(
      [],
    );
  });
});
