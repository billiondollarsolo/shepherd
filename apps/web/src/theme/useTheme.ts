import { useContext } from 'react';
import { ThemeContext, type ThemeContextValue } from './themeContext';

/**
 * Access the flock-theme state.
 *
 * @throws if called outside a <ThemeProvider>.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === undefined) {
    throw new Error('useTheme must be used within a <ThemeProvider>');
  }
  return ctx;
}
