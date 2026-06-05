import { createContext } from 'react';
import type { ResolvedTheme, ThemeMode } from './tokens';

/** Value exposed by the theme context to consumers via `useTheme()`. */
export interface ThemeContextValue {
  /** The user's selected mode: 'light' | 'dark' | 'system'. */
  mode: ThemeMode;
  /** The concrete theme currently applied to the document ('light' | 'dark'). */
  resolvedTheme: ResolvedTheme;
  /** Choose an explicit mode (persists the choice). */
  setMode: (mode: ThemeMode) => void;
  /** Convenience: flip between the two concrete themes (light <-> dark). */
  toggleTheme: () => void;
}

/**
 * Undefined by default so `useTheme()` can throw a clear error when used outside
 * a <ThemeProvider>.
 */
export const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** localStorage key for the persisted theme choice (US-31: persists across reloads). */
export const THEME_STORAGE_KEY = 'flock.theme';
