import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHELL_NAV,
  openAgent,
  clearSelection,
  closeSettings,
  openMission,
  openSettings,
  pathToShellNav,
  selectProject,
  setChrome,
  setLens,
  shellNavToPath,
  openTools,
  closeTools,
} from './shell-nav.js';

describe('shell-nav state machine', () => {
  it('D1: default is mission + stage chrome', () => {
    expect(DEFAULT_SHELL_NAV.lens).toBe('mission');
    expect(DEFAULT_SHELL_NAV.chrome).toBe('stage');
    expect(DEFAULT_SHELL_NAV.selectedSessionId).toBeNull();
  });

  it('D2: openAgent sets selection, agents lens, stage chrome', () => {
    const next = openAgent(DEFAULT_SHELL_NAV, {
      sessionId: 's1',
      projectId: 'p1',
    });
    expect(next.selectedSessionId).toBe('s1');
    expect(next.activeProjectId).toBe('p1');
    expect(next.lens).toBe('agents');
    expect(next.chrome).toBe('stage');
  });

  it('D5: tools are opt-in; openTools/closeTools toggle chrome only', () => {
    const withAgent = openAgent(DEFAULT_SHELL_NAV, { sessionId: 's1', projectId: 'p1' });
    expect(withAgent.chrome).toBe('stage');
    const tools = openTools(withAgent);
    expect(tools.chrome).toBe('tools');
    expect(tools.selectedSessionId).toBe('s1');
    expect(closeTools(tools).chrome).toBe('stage');
  });

  it('openMission preserves selection (does not destroy stage)', () => {
    const withAgent = openAgent(DEFAULT_SHELL_NAV, { sessionId: 's1', projectId: 'p1' });
    const mission = openMission(withAgent);
    expect(mission.lens).toBe('mission');
    expect(mission.selectedSessionId).toBe('s1');
    expect(mission.activeProjectId).toBe('p1');
  });

  it('path: / is mission', () => {
    const p = pathToShellNav('/');
    expect(p.lens).toBe('mission');
    expect(p.chrome).toBe('stage');
    expect(p.selectedSessionId).toBeNull();
  });

  it('path: /agents/:id clears project scope', () => {
    const a = pathToShellNav('/agents/sess-1');
    expect(a.lens).toBe('agents');
    expect(a.selectedSessionId).toBe('sess-1');
    expect(a.chrome).toBe('stage');
    expect(a.activeProjectId).toBeNull();
  });

  it('shellNavToPath round-trips agents selection', () => {
    const path = shellNavToPath({
      settings: false,
      settingsSection: 'appearance',
      lens: 'agents',
      selectedSessionId: 's1',
      activeProjectId: 'p1',
      nodeInfoNodeId: null,
    });
    expect(path).toBe('/agents/s1');
    expect(pathToShellNav(path).selectedSessionId).toBe('s1');
  });

  it('setChrome does not clear selection', () => {
    const s = openAgent(DEFAULT_SHELL_NAV, { sessionId: 'x', projectId: 'y' });
    expect(setChrome(s, 'tools').selectedSessionId).toBe('x');
  });

  it('project and lens actions clear stale modal or session state', () => {
    const settings = openSettings(DEFAULT_SHELL_NAV, 'nodes');
    expect(settings).toMatchObject({ settings: true, settingsSection: 'nodes' });
    expect(closeSettings(settings).settings).toBe(false);
    expect(openSettings(DEFAULT_SHELL_NAV).settingsSection).toBe('appearance');

    const selected = selectProject(settings, 'project-1');
    expect(selected).toMatchObject({
      settings: false,
      activeProjectId: 'project-1',
      selectedSessionId: null,
      lens: 'agents',
      chrome: 'stage',
    });
    expect(clearSelection(selected)).toMatchObject({
      activeProjectId: null,
      selectedSessionId: null,
    });
    expect(setLens(settings, 'agents')).toMatchObject({ settings: false, lens: 'agents' });
  });

  it.each([
    ['/settings/deployment-preview', { settings: true, settingsSection: 'deployment-preview' }],
    ['/settings/not-a-section', { settings: true }],
    ['/n/node-1', { settings: false, nodeInfoNodeId: 'node-1', lens: 'mission' }],
    [
      '/agents',
      {
        settings: false,
        lens: 'agents',
        selectedSessionId: null,
        activeProjectId: null,
        nodeInfoNodeId: null,
      },
    ],
    [
      '/p/project-1',
      {
        settings: false,
        lens: 'agents',
        activeProjectId: 'project-1',
        selectedSessionId: null,
        nodeInfoNodeId: null,
      },
    ],
  ])('maps %s into canonical shell state', (path, expected) => {
    expect(pathToShellNav(path)).toMatchObject(expected);
  });

  it.each([
    [{ ...DEFAULT_SHELL_NAV, settings: true, settingsSection: '' }, '/settings/appearance'],
    [{ ...DEFAULT_SHELL_NAV, nodeInfoNodeId: 'node-1' }, '/n/node-1'],
    [{ ...DEFAULT_SHELL_NAV, activeProjectId: 'project-1' }, '/p/project-1'],
    [{ ...DEFAULT_SHELL_NAV, lens: 'agents' }, '/agents'],
    [DEFAULT_SHELL_NAV, '/'],
  ])('builds the canonical path for navigation state', (state, expected) => {
    expect(shellNavToPath(state)).toBe(expected);
  });
});
