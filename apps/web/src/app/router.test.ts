import { describe, it, expect } from 'vitest';

import { pathToNav, navToPath, type NavToPathInput } from './router';

describe('pathToNav (URL → store patch)', () => {
  it('maps / to the Mission Control home (the fleet)', () => {
    expect(pathToNav('/')).toEqual({
      view: 'overview',
      selectedSessionId: null,
      selectedProjectId: null,
      nodeInfoNodeId: null,
    });
  });

  it('maps /s/:id to focusing that session', () => {
    expect(pathToNav('/s/abc123')).toEqual({
      view: 'paddock',
      viewMode: 'focus',
      selectedSessionId: 'abc123',
      nodeInfoNodeId: null,
    });
  });

  it('maps /p/:id to that project grid (leaves selection alone)', () => {
    expect(pathToNav('/p/proj1')).toEqual({
      view: 'paddock',
      viewMode: 'grid',
      selectedProjectId: 'proj1',
      nodeInfoNodeId: null,
    });
  });

  it('maps /n/:id to the node overlay', () => {
    expect(pathToNav('/n/node1')).toEqual({ view: 'paddock', nodeInfoNodeId: 'node1' });
  });

  it('maps /settings and /settings/:section', () => {
    expect(pathToNav('/settings')).toEqual({ view: 'settings' });
    expect(pathToNav('/settings/account')).toEqual({
      view: 'settings',
      settingsSection: 'account',
    });
  });

  it('ignores an unknown settings section (just opens settings)', () => {
    expect(pathToNav('/settings/bogus')).toEqual({ view: 'settings' });
  });
});

const base: NavToPathInput = {
  view: 'paddock',
  settingsSection: 'appearance',
  viewMode: 'grid',
  selectedSessionId: null,
  nodeInfoNodeId: null,
  gridProjectId: null,
};

describe('navToPath (store → canonical URL)', () => {
  it('settings wins, with its section', () => {
    expect(navToPath({ ...base, view: 'settings', settingsSection: 'nodes' })).toBe('/settings/nodes');
  });

  it('node overlay → /n/:id', () => {
    expect(navToPath({ ...base, nodeInfoNodeId: 'n1' })).toBe('/n/n1');
  });

  it('focused session → /s/:id', () => {
    expect(navToPath({ ...base, viewMode: 'focus', selectedSessionId: 's1' })).toBe('/s/s1');
  });

  it('grid with a project → /p/:id', () => {
    expect(navToPath({ ...base, gridProjectId: 'p1' })).toBe('/p/p1');
  });

  it('nothing → /', () => {
    expect(navToPath(base)).toBe('/');
  });
});

describe('round-trips converge (no navigation ping-pong)', () => {
  it('/s/:id → store → /s/:id', () => {
    const nav = pathToNav('/s/sX');
    const path = navToPath({ ...base, ...nav, gridProjectId: null } as NavToPathInput);
    expect(path).toBe('/s/sX');
  });

  it('/p/:id → store → /p/:id', () => {
    const nav = pathToNav('/p/pX');
    const path = navToPath({
      ...base,
      viewMode: nav.viewMode ?? 'grid',
      gridProjectId: nav.selectedProjectId ?? null,
    });
    expect(path).toBe('/p/pX');
  });

  it('/settings/:section → store → same', () => {
    const nav = pathToNav('/settings/about');
    const path = navToPath({ ...base, view: 'settings', settingsSection: nav.settingsSection ?? 'appearance' });
    expect(path).toBe('/settings/about');
  });
});
