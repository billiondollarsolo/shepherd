/**
 * Tools chrome policy: terminal-first stage does not expose right-rail until tools open.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { usePaddock } from '../../store/paddock';
import { shouldUseGridViewAsLayoutFallback, stageRenderMode } from '@flock/shared';

/** Mirrors SessionPane toolsOpen logic (shipped predicate). */
export function isToolsChromeOpen(state: {
  chrome: 'stage' | 'tools';
  rightOpen: boolean;
  hasStagedSession: boolean;
}): boolean {
  return state.chrome === 'tools' && state.rightOpen && state.hasStagedSession;
}

describe('stage tools chrome (paddock terminal-first)', () => {
  beforeEach(() => {
    usePaddock.setState({
      chrome: 'stage',
      rightOpen: false,
      selectedSessionId: 's1',
      lens: 'agents',
    });
  });

  it('default stage chrome keeps tools closed', () => {
    const s = usePaddock.getState();
    expect(s.chrome).toBe('stage');
    expect(isToolsChromeOpen({ chrome: s.chrome, rightOpen: s.rightOpen, hasStagedSession: true })).toBe(
      false,
    );
  });

  it('openTools opens tools chrome; closeTools returns terminal-first', () => {
    usePaddock.getState().openTools();
    let s = usePaddock.getState();
    expect(s.chrome).toBe('tools');
    expect(s.rightOpen).toBe(true);
    expect(isToolsChromeOpen({ chrome: s.chrome, rightOpen: s.rightOpen, hasStagedSession: true })).toBe(
      true,
    );
    // No staged session → no tools surface
    expect(
      isToolsChromeOpen({ chrome: s.chrome, rightOpen: s.rightOpen, hasStagedSession: false }),
    ).toBe(false);

    usePaddock.getState().closeTools();
    s = usePaddock.getState();
    expect(s.chrome).toBe('stage');
    expect(isToolsChromeOpen({ chrome: s.chrome, rightOpen: s.rightOpen, hasStagedSession: true })).toBe(
      false,
    );
  });

  it('never uses GridView as layout loading fallback', () => {
    expect(shouldUseGridViewAsLayoutFallback()).toBe(false);
    expect(stageRenderMode({ projectId: 'p', openSessionCount: 2, layoutReady: false })).toBe(
      'loading',
    );
  });
});
