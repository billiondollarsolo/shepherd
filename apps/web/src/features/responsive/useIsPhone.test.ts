/**
 * US-36 — viewport detection for the responsive collapse.
 *
 * `useIsPhone` reports whether the current viewport is phone-sized via a CSS
 * media query, so the app can swap the dense desktop paddock for the phone away
 * view. We assert it reads the matchMedia result and reacts to changes (a phone
 * rotating / a window resizing across the breakpoint).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PHONE_MEDIA_QUERY, useIsPhone } from './useIsPhone';

type Listener = (e: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean): {
  setMatches: (m: boolean) => void;
} {
  let matches = initialMatches;
  const listeners = new Set<Listener>();
  const mql = {
    get matches() {
      return matches;
    },
    media: PHONE_MEDIA_QUERY,
    addEventListener: (_type: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_type: string, cb: Listener) => listeners.delete(cb),
    // legacy API some browsers still use
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null,
  };
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql));
  return {
    setMatches(m: boolean) {
      matches = m;
      for (const cb of listeners) cb({ matches: m });
    },
  };
}

describe('useIsPhone (US-36)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('targets a phone-width breakpoint', () => {
    expect(PHONE_MEDIA_QUERY).toMatch(/max-width/);
  });

  it('is device-aware: also matches short touch (landscape) phones', () => {
    // A wide-but-short touch device is a landscape phone; the second OR-ed clause
    // gates on a coarse pointer + limited height so it gets the PhoneView too,
    // while short *desktop* windows (fine pointer) stay on the dense shell.
    expect(PHONE_MEDIA_QUERY).toMatch(/pointer:\s*coarse/);
    expect(PHONE_MEDIA_QUERY).toMatch(/max-height/);
    // The two conditions are OR-ed (comma) so either a narrow width or a short
    // touch device triggers the collapse.
    expect(PHONE_MEDIA_QUERY).toContain(',');
  });

  it('returns true when the viewport matches the phone query', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(true);
  });

  it('returns false on a desktop viewport', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(false);
  });

  it('reacts to crossing the breakpoint (resize / rotate)', () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useIsPhone());
    expect(result.current).toBe(false);
    act(() => mm.setMatches(true));
    expect(result.current).toBe(true);
  });
});
