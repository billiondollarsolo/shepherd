import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHELL_NAV,
  openAgent,
  openMission,
  pathToShellNav,
  setChrome,
  setHostScope,
  shellNavToPath,
  sessionInHostScope,
  openTools,
  closeTools,
} from './shell-nav.js';

describe('shell-nav state machine', () => {
  it('D1: default is mission + all hosts + stage chrome', () => {
    expect(DEFAULT_SHELL_NAV.lens).toBe('mission');
    expect(DEFAULT_SHELL_NAV.hostScope).toBe('all');
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

  it('setHostScope filters session membership', () => {
    const scoped = setHostScope(DEFAULT_SHELL_NAV, { nodeId: 'n1' });
    expect(scoped.hostScope).toEqual({ nodeId: 'n1' });
    const nodes = [
      { id: 'n1', pool: null },
      { id: 'n2', pool: 'build' },
    ];
    expect(sessionInHostScope(scoped.hostScope, { nodeId: 'n1' }, nodes)).toBe(true);
    expect(sessionInHostScope(scoped.hostScope, { nodeId: 'n2' }, nodes)).toBe(false);
    expect(sessionInHostScope('all', { nodeId: 'n2' }, nodes)).toBe(true);
    expect(sessionInHostScope({ pool: 'build' }, { nodeId: 'n2' }, nodes)).toBe(true);
  });

  it('path: / is mission all hosts', () => {
    const p = pathToShellNav('/');
    expect(p.lens).toBe('mission');
    expect(p.hostScope).toBe('all');
    expect(p.chrome).toBe('stage');
    expect(p.selectedSessionId).toBeNull();
  });

  it('path: /agents/:id and compat /s/:id clear project scope', () => {
    const a = pathToShellNav('/agents/sess-1');
    expect(a.lens).toBe('agents');
    expect(a.selectedSessionId).toBe('sess-1');
    expect(a.chrome).toBe('stage');
    expect(a.activeProjectId).toBeNull();
    const s = pathToShellNav('/s/sess-1');
    expect(s.lens).toBe('agents');
    expect(s.selectedSessionId).toBe('sess-1');
    expect(s.activeProjectId).toBeNull();
  });

  it('shellNavToPath round-trips agents selection', () => {
    const path = shellNavToPath({
      settings: false,
      settingsSection: 'appearance',
      lens: 'agents',
      selectedSessionId: 's1',
      activeProjectId: 'p1',
      nodeInfoNodeId: null,
      hostScope: 'all',
    });
    expect(path).toBe('/agents/s1');
    expect(pathToShellNav(path).selectedSessionId).toBe('s1');
  });

  it('setChrome does not clear selection', () => {
    const s = openAgent(DEFAULT_SHELL_NAV, { sessionId: 'x', projectId: 'y' });
    expect(setChrome(s, 'tools').selectedSessionId).toBe('x');
  });
});
