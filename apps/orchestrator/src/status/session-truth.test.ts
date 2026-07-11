/**
 * Ground-truth reconcile unit tests — stale "running" must not survive a down
 * node or a missing agentd PTY.
 */
import { describe, expect, it } from 'vitest';
import { planSessionTruth, type NodeTruth, type SessionTruthRow } from './session-truth.js';

function nodes(entries: Record<string, NodeTruth>): Map<string, NodeTruth> {
  return new Map(Object.entries(entries));
}

describe('planSessionTruth', () => {
  const open: SessionTruthRow[] = [
    { id: 's-run', nodeId: 'vm1', status: 'running' },
    { id: 's-start', nodeId: 'vm1', status: 'starting' },
    { id: 's-idle', nodeId: 'vm2', status: 'idle' },
    { id: 's-await', nodeId: 'local', status: 'awaiting_input' },
    { id: 's-done', nodeId: 'vm1', status: 'done' },
    { id: 's-err', nodeId: 'vm1', status: 'error' },
    { id: 's-disc', nodeId: 'vm1', status: 'disconnected' },
  ];

  it('marks active sessions disconnected when the SSH node is down', () => {
    const plan = planSessionTruth(
      open,
      nodes({
        vm1: { kind: 'ssh', connection: 'error', liveSessionIds: null },
        vm2: { kind: 'ssh', connection: 'disconnected', liveSessionIds: null },
        local: { kind: 'local', connection: 'connected', liveSessionIds: new Set(['s-await']) },
      }),
    );

    const byId = Object.fromEntries(plan.map((p) => [p.id, p]));
    expect(byId['s-run']?.status).toBe('disconnected');
    expect(byId['s-run']?.detail).toMatch(/unreachable|error|node/i);
    expect(byId['s-start']?.status).toBe('disconnected');
    expect(byId['s-idle']?.status).toBe('disconnected');
    // Local still live on agentd — no correction.
    expect(byId['s-await']).toBeUndefined();
    // Terminal / already disconnected untouched.
    expect(byId['s-done']).toBeUndefined();
    expect(byId['s-err']).toBeUndefined();
    expect(byId['s-disc']).toBeUndefined();
  });

  it('marks active sessions disconnected when agentd has no PTY (node up)', () => {
    const plan = planSessionTruth(
      [
        { id: 'alive', nodeId: 'local', status: 'running' },
        { id: 'ghost', nodeId: 'local', status: 'running' },
      ],
      nodes({
        local: {
          kind: 'local',
          connection: 'connected',
          liveSessionIds: new Set(['alive']),
        },
      }),
    );

    expect(plan).toEqual([
      {
        id: 'ghost',
        status: 'disconnected',
        detail: 'session not running on node',
      },
    ]);
  });

  it('does not invent disconnects when agentd could not be probed', () => {
    const plan = planSessionTruth(
      [{ id: 's1', nodeId: 'vm1', status: 'running' }],
      nodes({
        vm1: { kind: 'ssh', connection: 'connected', liveSessionIds: null },
      }),
    );
    expect(plan).toEqual([]);
  });

  it('treats connecting nodes as not ready (stale running → disconnected)', () => {
    const plan = planSessionTruth(
      [{ id: 's1', nodeId: 'vm1', status: 'running' }],
      nodes({
        vm1: { kind: 'ssh', connection: 'connecting', liveSessionIds: null },
      }),
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ id: 's1', status: 'disconnected' });
    expect(plan[0]!.detail).toMatch(/connecting/i);
  });

  it('disconnects sessions whose node row is missing', () => {
    const plan = planSessionTruth([{ id: 'orphan', nodeId: 'gone', status: 'running' }], nodes({}));
    expect(plan).toEqual([{ id: 'orphan', status: 'disconnected', detail: 'node missing' }]);
  });

  it('is a no-op when everything matches ground truth', () => {
    const plan = planSessionTruth(
      [
        { id: 'a', nodeId: 'n', status: 'running' },
        { id: 'b', nodeId: 'n', status: 'idle' },
      ],
      nodes({
        n: {
          kind: 'ssh',
          connection: 'connected',
          liveSessionIds: new Set(['a', 'b']),
        },
      }),
    );
    expect(plan).toEqual([]);
  });

  it('refreshes disconnected detail when the node is back but the PTY is gone', () => {
    // After a VM reboot: session still "disconnected / node unreachable" in the
    // mirror, but the node is connected again — ground truth is "PTY missing".
    const plan = planSessionTruth(
      [{ id: 'ghost', nodeId: 'vm1', status: 'disconnected' }],
      nodes({
        vm1: {
          kind: 'ssh',
          connection: 'connected',
          liveSessionIds: new Set(), // empty inventory
        },
      }),
    );
    expect(plan).toEqual([
      {
        id: 'ghost',
        status: 'disconnected',
        detail: 'session not running on node',
      },
    ]);
  });

  it('restores disconnected → idle when agentd still has the PTY (live agents)', () => {
    // Boot rehydrate seeds DB "disconnected"; agentd list proves the agent is up.
    // Without this, the UI stays grey until a hook fires (often never while idle).
    const plan = planSessionTruth(
      [
        { id: 'claude', nodeId: 'vm1', status: 'disconnected' },
        { id: 'codex', nodeId: 'vm1', status: 'disconnected' },
        { id: 'ok', nodeId: 'vm1', status: 'idle' },
      ],
      nodes({
        vm1: {
          kind: 'ssh',
          connection: 'connected',
          liveSessionIds: new Set(['claude', 'codex', 'ok']),
        },
      }),
    );
    expect(plan).toEqual([
      { id: 'claude', status: 'idle', detail: 'session restored on node' },
      { id: 'codex', status: 'idle', detail: 'session restored on node' },
    ]);
  });

  it('does not restore when agentd inventory is unknown (null probe)', () => {
    const plan = planSessionTruth(
      [{ id: 's1', nodeId: 'vm1', status: 'disconnected' }],
      nodes({
        vm1: { kind: 'ssh', connection: 'connected', liveSessionIds: null },
      }),
    );
    expect(plan).toEqual([]);
  });
});
