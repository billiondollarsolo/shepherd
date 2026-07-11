import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHELL_NAV,
  openAgent,
  openMission,
  pathToShellNav,
  setChrome,
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
});
