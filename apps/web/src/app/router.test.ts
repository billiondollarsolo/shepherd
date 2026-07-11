import { describe, expect, it } from 'vitest';
import { pathToNav, navToPath, type NavToPathInput } from './router';

describe('pathToNav', () => {
  it('D1: / is the Paddock overview', () => {
    const n = pathToNav('/');
    expect(n.view).toBe('overview');
    expect(n.lens).toBe('mission');
    expect(n.chrome).toBe('stage');
    expect(n.selectedSessionId).toBeNull();
  });

  it('D2: /agents/:id opens agents lens + selection + stage', () => {
    const n = pathToNav('/agents/abc123');
    expect(n.lens).toBe('agents');
    expect(n.selectedSessionId).toBe('abc123');
    expect(n.chrome).toBe('stage');
    expect(n.view).toBe('paddock');
  });

  it('maps /p/:id to project layout', () => {
    const n = pathToNav('/p/proj-1');
    expect(n.selectedProjectId).toBe('proj-1');
    expect(n.lens).toBe('agents');
    expect(n.selectedSessionId).toBeNull();
  });

  it('maps /agents to agents lens without selection', () => {
    const n = pathToNav('/agents');
    expect(n.lens).toBe('agents');
    expect(n.selectedSessionId).toBeNull();
  });
});

describe('navToPath', () => {
  const base: NavToPathInput = {
    view: 'overview',
    settingsSection: 'appearance',
    selectedSessionId: null,
    nodeInfoNodeId: null,
    gridProjectId: null,
    lens: 'mission',
    projectView: 'agents',
  };

  it('mission home is /', () => {
    expect(navToPath(base)).toBe('/');
  });

  it('selected session is /agents/:id', () => {
    expect(
      navToPath({
        ...base,
        view: 'paddock',
        lens: 'agents',
        selectedSessionId: 's1',
      }),
    ).toBe('/agents/s1');
  });

  it('settings path', () => {
    expect(navToPath({ ...base, view: 'settings', settingsSection: 'nodes' })).toBe(
      '/settings/nodes',
    );
  });

  it('maps project source control to its own page', () => {
    expect(pathToNav('/p/proj-1/git')).toMatchObject({
      selectedProjectId: 'proj-1',
      projectView: 'git',
    });
    expect(
      navToPath({
        ...base,
        view: 'paddock',
        lens: 'agents',
        gridProjectId: 'proj-1',
        projectView: 'git',
      }),
    ).toBe('/p/proj-1/git');
  });
});
