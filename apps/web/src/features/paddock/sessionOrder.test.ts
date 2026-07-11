import { describe, it, expect } from 'vitest';
import type { Session } from '@flock/shared';
import { orderSessions, moveBefore } from './sessionOrder';

function mk(id: string, createdAt: string): Session {
  return {
    id,
    nodeId: 'n',
    projectId: 'P',
    agentType: 'claude-code',
    tmuxSessionName: id,
    workingDir: '/w',
    browserCdpEndpoint: null,
    hookTokenHash: 'h',
    status: 'running',
    statusDetail: null,
    pinned: false,
    note: null,
    createdAt,
    lastStatusAt: createdAt,
    createdBy: 'u',
    closedAt: null,
  };
}

describe('orderSessions', () => {
  const a = mk('a', '2026-01-01T00:00:00Z');
  const b = mk('b', '2026-01-01T00:00:01Z');
  const c = mk('c', '2026-01-01T00:00:02Z');

  it('falls back to creation order when no manual order', () => {
    expect(orderSessions([c, a, b], undefined).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('honors the manual order', () => {
    expect(orderSessions([a, b, c], ['c', 'a', 'b']).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends sessions not in the manual order, oldest-first', () => {
    // only b,a are ordered; c is new → goes last
    expect(orderSessions([a, b, c], ['b', 'a']).map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('moveBefore', () => {
  it('moves an id to the target position (before it)', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveBefore(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
  });
  it('is a no-op for same id or missing ids', () => {
    expect(moveBefore(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(moveBefore(['a', 'b'], 'z', 'a')).toEqual(['a', 'b']);
  });
});
