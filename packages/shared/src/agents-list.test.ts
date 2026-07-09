import { describe, expect, it } from 'vitest';
import { orderAgents, groupAgents, type AgentListItem } from './agents-list.js';

function item(partial: Partial<AgentListItem> & Pick<AgentListItem, 'id' | 'status'>): AgentListItem {
  return {
    nodeId: 'n1',
    projectId: 'p1',
    pinned: false,
    lastStatusTransitionAt: 0,
    ...partial,
  };
}

describe('agents-list', () => {
  it('pin-first then attention', () => {
    const items = [
      item({ id: 'idle', status: 'idle', pinned: false }),
      item({ id: 'need', status: 'awaiting_input', pinned: false }),
      item({ id: 'pin', status: 'idle', pinned: true }),
    ];
    const ordered = orderAgents(items, { sort: 'attention' });
    expect(ordered.map((i) => i.id)).toEqual(['pin', 'need', 'idle']);
  });

  it('activeOnly filters quiet statuses', () => {
    const items = [
      item({ id: 'a', status: 'idle' }),
      item({ id: 'b', status: 'running' }),
      item({ id: 'c', status: 'awaiting_input' }),
    ];
    const ordered = orderAgents(items, { sort: 'attention', activeOnly: true });
    expect(ordered.map((i) => i.id).sort()).toEqual(['b', 'c']);
  });

  it('lastStatusChange sorts by timestamp desc', () => {
    const items = [
      item({ id: 'old', status: 'running', lastStatusTransitionAt: 100 }),
      item({ id: 'new', status: 'running', lastStatusTransitionAt: 900 }),
    ];
    const ordered = orderAgents(items, { sort: 'lastStatusChange' });
    expect(ordered[0]!.id).toBe('new');
  });

  it('group by node', () => {
    const items = orderAgents(
      [
        item({ id: '1', status: 'idle', nodeId: 'a', nodeName: 'Alpha' }),
        item({ id: '2', status: 'idle', nodeId: 'b', nodeName: 'Beta' }),
      ],
      { sort: 'attention' },
    );
    const groups = groupAgents(items, 'node');
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label).sort()).toEqual(['Alpha', 'Beta']);
  });
});
