import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { THEME_MODES, type ResolvedTheme, type ThemeMode } from './tokens';
import { ThemeContext, THEME_STORAGE_KEY, type ThemeContextValue } from './themeContext';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** True when running in a browser with a usable `window`/`document`. */
function hasDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Read the persisted mode from localStorage. Defaults to 'dark' (Flock is a
 * dark-first "Orca-like" paddock) when the user has made no explicit choice; a
 * stored choice (incl. 'system' to follow the OS) always wins.
 */
export function readStoredMode(): ThemeMode {
  if (!hasDom()) return 'dark';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && (THEME_MODES as readonly string[]).includes(raw)) {
      return raw as ThemeMode;
    }
  } catch {
    /* localStorage may be unavailable (private mode / SSR) — fall through. */
  }
  return 'dark';
}

/** Current OS colour-scheme preference. */
export function getSystemTheme(): ResolvedTheme {
  if (!hasDom() || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** Resolve a (possibly 'system') mode to a concrete theme. */
export function resolveTheme(mode: ThemeMode, system: ResolvedTheme): ResolvedTheme {
  return mode === 'system' ? system : mode;
}

/**
 * Apply the resolved theme to the document root.
 *
 * We always set `data-theme` to the resolved value so tests/components can read
 * it AND so the explicit-choice CSS rules in theme.css win over the
 * `prefers-color-scheme` media query. The media query only governs first paint
 * (before this JS runs) for users who have not made a choice. `colorScheme` is
 * set so native form controls / scrollbars match.
 */
function applyTheme(mode: ThemeMode, resolved: ResolvedTheme): void {
  if (!hasDom()) return;
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.dataset.themeMode = mode;
  root.style.colorScheme = resolved;
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Override the initial mode (mainly for tests/Storybook). */
  defaultMode?: ThemeMode;
}

/**
 * Provides flock-theme state to the app.
 *
 * Responsibilities (US-31 acceptance criteria):
 *  - OS-preference auto-detect on first load (mode defaults to 'system').
 *  - Persists the user's explicit choice across reloads (localStorage).
 *  - Toggling updates every surface (writes `data-theme` on <html>).
 *  - Live-follows the OS while in 'system' mode.
 */
export function ThemeProvider({ children, defaultMode }: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeMode>(() => defaultMode ?? readStoredMode());
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());

  const resolvedTheme = resolveTheme(mode, systemTheme);

  // Apply to the DOM synchronously after render so the attribute is always in
  // sync with state (covers the very first paint too).
  useEffect(() => {
    applyTheme(mode, resolvedTheme);
  }, [mode, resolvedTheme]);

  // Track live OS changes so 'system' mode follows the OS without a reload.
  useEffect(() => {
    if (!hasDom() || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light');
    };
    // addEventListener is the modern API; older Safari needs addListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  const persist = useRef((m: ThemeMode) => {
    if (!hasDom()) return;
    try {
      if (m === 'system') {
        // Clearing the key means "follow the OS" on the next cold load.
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, m);
      }
    } catch {
      /* ignore storage failures */
    }
  });

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    persist.current(next);
  }, []);

  const toggleTheme = useCallback(() => {
    // Toggle off the *currently visible* theme to a concrete opposite.
    setModeState((prev) => {
      const current = resolveTheme(prev, getSystemTheme());
      const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
      persist.current(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolvedTheme, setMode, toggleTheme }),
    [mode, resolvedTheme, setMode, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
