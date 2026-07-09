import { describe, expect, it, vi } from 'vitest';
import { buildPaddockCommands } from './usePaddockCommands';
import type { Session, Project, Node as FlockNode } from '@flock/shared';

function makeActions() {
  return {
    openAgent: vi.fn(),
    selectProject: vi.fn(),
    openNodeInfo: vi.fn(),
    toggleGridLayout: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleRight: vi.fn(),
    openRight: vi.fn(),
    openTools: vi.fn(),
    closeTools: vi.fn(),
    openSettings: vi.fn(),
    openMission: vi.fn(),
    setLens: vi.fn(),
    openDialog: vi.fn(),
  };
}

const session = {
  id: 'sess-open-1',
  projectId: 'p1',
  nodeId: 'n1',
  agentType: 'claude-code',
  closedAt: null,
} as Session;

const project = { id: 'p1', name: 'Demo', nodeId: 'n1' } as Project;
const node = { id: 'n1', name: 'local' } as FlockNode;

describe('buildPaddockCommands', () => {
  it('includes mission + agents lens and openAgent navigation', () => {
    const actions = makeActions();
    const cmds = buildPaddockCommands({
      sessions: [session],
      projects: [project],
      nodes: [node],
      actions,
    });
    const byId = Object.fromEntries(cmds.map((c) => [c.id, c]));
    expect(byId['lens-mission']).toBeDefined();
    expect(byId['lens-agents']).toBeDefined();
    expect(byId['open-tools']).toBeDefined();
    expect(byId['close-tools']).toBeDefined();

    byId['lens-agents']!.run();
    expect(actions.setLens).toHaveBeenCalledWith('agents');

    byId[`goto-session-${session.id}`]!.run();
    expect(actions.openAgent).toHaveBeenCalledWith('sess-open-1', 'p1');

    byId['mission-control']!.run();
    expect(actions.openMission).toHaveBeenCalled();
  });

  it('does not expose setViewMode / dual focus mode', () => {
    const actions = makeActions();
    const cmds = buildPaddockCommands({
      sessions: [],
      projects: [],
      nodes: [],
      actions,
    });
    expect(cmds.find((c) => c.id === 'view-grid')).toBeUndefined();
    expect(cmds.find((c) => c.id === 'view-focus')).toBeUndefined();
  });
});
