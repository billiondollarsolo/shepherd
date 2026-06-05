import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { ThemeProvider } from './ThemeProvider';
import { useTheme } from './useTheme';
import { ThemeToggle } from './ThemeToggle';
import { THEME_STORAGE_KEY } from './themeContext';

/** Build a matchMedia mock that reports `dark` and lets us fire change events. */
function installMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let matches = prefersDark;
  const mql = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null,
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation(() => mql),
  );
  return {
    setOsDark(value: boolean) {
      matches = value;
      const evt = { matches: value } as MediaQueryListEvent;
      for (const cb of listeners) cb(evt);
    },
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  delete document.documentElement.dataset.themeMode;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ThemeProvider', () => {
  it('defaults to dark on first load (no stored choice) — Orca-like, dark-first', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper: Wrapper });
    expect(result.current.mode).toBe('dark');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('follows the OS preference once switched to system mode (light)', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper: Wrapper });
    act(() => result.current.setMode('system'));
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('persists an explicit choice across reloads (localStorage)', () => {
    installMatchMedia(false);
    const { result, unmount } = renderHook(() => useTheme(), { wrapper: Wrapper });
    act(() => result.current.setMode('dark'));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    unmount();

    // Simulate a reload: fresh provider should pick up the stored choice.
    const { result: result2 } = renderHook(() => useTheme(), { wrapper: Wrapper });
    expect(result2.current.mode).toBe('dark');
    expect(result2.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('explicit choice overrides the OS preference', () => {
    installMatchMedia(true); // OS = dark
    const { result } = renderHook(() => useTheme(), { wrapper: Wrapper });
    act(() => result.current.setMode('light'));
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('toggleTheme flips the visible theme and persists it', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper: Wrapper });
    expect(result.current.resolvedTheme).toBe('dark'); // dark-first default
    act(() => result.current.toggleTheme());
    expect(result.current.resolvedTheme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    act(() => result.current.toggleTheme());
    expect(result.current.resolvedTheme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('follows live OS changes while in system mode', () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper: Wrapper });
    act(() => result.current.setMode('system')); // dark-first default → opt into OS-follow
    expect(result.current.resolvedTheme).toBe('light');
    act(() => mm.setOsDark(true));
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('setMode("system") clears the persisted choice', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme(), { wrapper: Wrapper });
    act(() => result.current.setMode('dark'));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    act(() => result.current.setMode('system'));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(result.current.mode).toBe('system');
  });
});

describe('ThemeToggle', () => {
  it('renders an accessible toggle and switches data-theme on click', () => {
    installMatchMedia(false);
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const btn = screen.getByTestId('theme-toggle');
    // Dark-first default (Orca-like): the toggle starts on dark, flips to light.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(btn.getAttribute('aria-label')).toBe('Switch to light theme');
    act(() => btn.click());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(btn.getAttribute('aria-label')).toBe('Switch to dark theme');
  });
});

describe('useTheme guard', () => {
  it('throws when used outside a ThemeProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useTheme())).toThrow(/within a <ThemeProvider>/);
    spy.mockRestore();
  });
});
