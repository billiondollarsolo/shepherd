import { describe, expect, it } from 'vitest';
import type { Node, Session } from '@flock/shared';
import { pickBestNode, nodeReachable } from './placement';

const node = (over: Partial<Node>): Node =>
  ({
    id: 'n',
    name: 'n',
    kind: 'local',
    host: null,
    port: null,
    sshUser: null,
    sshKeyRef: null,
    sshAuthMethod: null,
    pool: null,
    connectionStatus: 'connected',
    lastSeenAt: null,
    createdBy: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as Node;
const sess = (nodeId: string, closed = false): Session =>
  ({
    id: Math.random().toString(36),
    nodeId,
    closedAt: closed ? '2026-01-01' : null,
  }) as unknown as Session;

describe('nodeReachable', () => {
  it('local always; ssh only when connected', () => {
    expect(nodeReachable(node({ kind: 'local', connectionStatus: 'disconnected' }))).toBe(true);
    expect(nodeReachable(node({ kind: 'ssh', connectionStatus: 'connected' }))).toBe(true);
    expect(nodeReachable(node({ kind: 'ssh', connectionStatus: 'disconnected' }))).toBe(false);
  });
});

describe('pickBestNode', () => {
  const a = node({ id: 'a', name: 'a' });
  const b = node({ id: 'b', name: 'b' });
  const down = node({ id: 'd', name: 'd', kind: 'ssh', connectionStatus: 'disconnected' });

  it('picks the reachable node with the fewest open sessions', () => {
    const sessions = [sess('a'), sess('a'), sess('b')];
    expect(pickBestNode([a, b], sessions)?.id).toBe('b');
  });

  it('ignores closed sessions and unreachable nodes', () => {
    const sessions = [sess('b'), sess('a', true), sess('a', true)];
    // a has 0 open, b has 1 → a wins; down is never chosen.
    expect(pickBestNode([a, b, down], sessions)?.id).toBe('a');
  });

  it('scopes to a pool when given', () => {
    const gpu = node({ id: 'g', name: 'g', pool: 'gpu' });
    expect(pickBestNode([a, b, gpu], [], 'gpu')?.id).toBe('g');
    expect(pickBestNode([a, b], [], 'gpu')).toBeNull(); // none in pool
  });

  it('returns null when nothing is reachable', () => {
    expect(pickBestNode([down], [])).toBeNull();
  });
});
