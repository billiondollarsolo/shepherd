import { describe, expect, it, vi } from 'vitest';
import type { Node as FlockNode, Project, Session } from '@flock/shared';
import { buildPaddockCommands, type PaddockCommandActions } from './usePaddockCommands';

function makeActions(): PaddockCommandActions {
  return {
    focusSession: vi.fn(),
    selectProject: vi.fn(),
    openNodeInfo: vi.fn(),
    setViewMode: vi.fn(),
    toggleGridLayout: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleRight: vi.fn(),
    openRight: vi.fn(),
    openSettings: vi.fn(),
    openOverview: vi.fn(),
    openDialog: vi.fn(),
  };
}

const sessions = [
  { id: 'sess-open-1', agentType: 'claude-code', closedAt: null },
  { id: 'sess-closed', agentType: 'codex', closedAt: '2026-01-01T00:00:00Z' },
] as unknown as Session[];
const projects = [{ id: 'proj-1', name: 'Apollo' }] as unknown as Project[];
const nodes = [{ id: 'node-1', name: 'vm-1' }] as unknown as FlockNode[];

describe('buildPaddockCommands (roadmap P9)', () => {
  it('always includes the create / view / panel / settings actions', () => {
    const cmds = buildPaddockCommands({ sessions, projects, nodes, actions: makeActions() });
    const ids = cmds.map((c) => c.id);
    for (const id of [
      'new-session', 'new-project', 'add-node',
      'view-grid', 'view-focus', 'toggle-grid-layout', 'toggle-sidebar', 'toggle-right',
      'open-activity', 'open-diff', 'open-files', 'open-browser', 'open-search',
      'open-settings',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('lists only OPEN sessions, plus every project and node', () => {
    const cmds = buildPaddockCommands({ sessions, projects, nodes, actions: makeActions() });
    const ids = cmds.map((c) => c.id);
    expect(ids).toContain('goto-session-sess-open-1');
    expect(ids).not.toContain('goto-session-sess-closed'); // closed → excluded
    expect(ids).toContain('goto-project-proj-1');
    expect(ids).toContain('goto-node-node-1');
    expect(cmds.find((c) => c.id === 'goto-project-proj-1')?.title).toContain('Apollo');
  });

  it('wires each command to the right action', () => {
    const actions = makeActions();
    const cmds = buildPaddockCommands({ sessions, projects, nodes, actions });
    const run = (id: string) => cmds.find((c) => c.id === id)!.run();

    run('new-session');
    expect(actions.openDialog).toHaveBeenCalledWith('session');
    run('view-grid');
    expect(actions.setViewMode).toHaveBeenCalledWith('grid');
    run('open-diff');
    expect(actions.openRight).toHaveBeenCalledWith('diff');
    run('goto-session-sess-open-1');
    expect(actions.focusSession).toHaveBeenCalledWith('sess-open-1');
    run('goto-node-node-1');
    expect(actions.openNodeInfo).toHaveBeenCalledWith('node-1');
  });
});
