import { describe, it, expect } from 'vitest';
import type { Status } from '@flock/shared';
import {
  sortSessionsByAttention,
  groupNeedsAttention,
  groupAttentionCount,
  groupAttentionStatus,
  type OrderableSession,
} from './ordering';

const s = (id: string, status: Status): OrderableSession => ({ id, status });

describe('sortSessionsByAttention (US-23, FR-ST6/FR-UI3)', () => {
  it('floats awaiting_input and error to the top', () => {
    const input = [
      s('run', 'running'),
      s('err', 'error'),
      s('idle', 'idle'),
      s('await', 'awaiting_input'),
      s('done', 'done'),
    ];
    const ordered = sortSessionsByAttention(input).map((x) => x.id);
    // awaiting_input first, then error — the two "needs you" states.
    expect(ordered[0]).toBe('await');
    expect(ordered[1]).toBe('err');
    // and they precede every non-attention status.
    expect(ordered.indexOf('await')).toBeLessThan(ordered.indexOf('run'));
    expect(ordered.indexOf('err')).toBeLessThan(ordered.indexOf('idle'));
  });

  it('orders awaiting_input strictly before error', () => {
    const ordered = sortSessionsByAttention([s('e', 'error'), s('a', 'awaiting_input')]).map(
      (x) => x.id,
    );
    expect(ordered).toEqual(['a', 'e']);
  });

  it('produces the full attention-rank ordering', () => {
    const input = [
      s('disconnected', 'disconnected'),
      s('running', 'running'),
      s('starting', 'starting'),
      s('idle', 'idle'),
      s('done', 'done'),
      s('error', 'error'),
      s('awaiting_input', 'awaiting_input'),
    ];
    const ordered = sortSessionsByAttention(input).map((x) => x.id);
    expect(ordered).toEqual([
      'awaiting_input',
      'error',
      'done',
      'idle',
      'starting',
      'running',
      'disconnected',
    ]);
  });

  it('is a stable sort: ties preserve input order', () => {
    const input = [s('r1', 'running'), s('r2', 'running'), s('r3', 'running')];
    const ordered = sortSessionsByAttention(input).map((x) => x.id);
    expect(ordered).toEqual(['r1', 'r2', 'r3']);
  });

  it('does not mutate the input array', () => {
    const input = [s('b', 'running'), s('a', 'awaiting_input')];
    const before = input.map((x) => x.id);
    sortSessionsByAttention(input);
    expect(input.map((x) => x.id)).toEqual(before);
  });

  it('handles an empty list', () => {
    expect(sortSessionsByAttention([])).toEqual([]);
  });
});

describe('groupNeedsAttention (US-23)', () => {
  it('is true when any session awaits input', () => {
    expect(groupNeedsAttention([s('a', 'running'), s('b', 'awaiting_input')])).toBe(true);
  });
  it('is true when any session errored', () => {
    expect(groupNeedsAttention([s('a', 'idle'), s('b', 'error')])).toBe(true);
  });
  it('is false when nothing needs attention', () => {
    expect(groupNeedsAttention([s('a', 'running'), s('b', 'idle'), s('c', 'done')])).toBe(false);
  });
  it('is false for an empty group', () => {
    expect(groupNeedsAttention([])).toBe(false);
  });
});

describe('groupAttentionCount (US-32 per-node "N need you" rollup)', () => {
  it('counts exactly the awaiting_input/error sessions', () => {
    const count = groupAttentionCount([
      s('a', 'awaiting_input'),
      s('b', 'error'),
      s('c', 'running'),
      s('d', 'awaiting_input'),
      s('e', 'idle'),
    ]);
    expect(count).toBe(3);
  });
  it('is 0 when nothing needs attention', () => {
    expect(groupAttentionCount([s('a', 'running'), s('b', 'done'), s('c', 'idle')])).toBe(0);
  });
  it('is 0 for an empty group', () => {
    expect(groupAttentionCount([])).toBe(0);
  });
});

describe('groupAttentionStatus (collapsed-branch dot colour)', () => {
  it('returns the MOST-URGENT needs-you status (awaiting_input over error)', () => {
    expect(groupAttentionStatus([s('a', 'error'), s('b', 'awaiting_input')])).toBe(
      'awaiting_input',
    );
  });
  it('returns error when only errors ring', () => {
    expect(groupAttentionStatus([s('a', 'running'), s('b', 'error'), s('c', 'idle')])).toBe(
      'error',
    );
  });
  it('returns null when nothing rings (never a calm status)', () => {
    expect(groupAttentionStatus([s('a', 'running'), s('b', 'idle'), s('c', 'done')])).toBeNull();
  });
  it('returns null for an empty group', () => {
    expect(groupAttentionStatus([])).toBeNull();
  });
});
