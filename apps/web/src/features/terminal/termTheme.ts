/**
 * termTheme — the single source of truth for the xterm/ghostty `ITheme`.
 *
 * All three terminal surfaces (desktop xterm, mobile ghostty, and the letterbox
 * wrappers) build their palette here from the `--flock-term-*` CSS custom
 * properties defined in styles/theme.css, so the terminal re-themes with the rest
 * of the app when `data-theme` flips — no duplicated One-Dark literals, no
 * dark-only island in light chrome.
 *
 * IMPORTANT (theme-toggle correctness): the vars must be read AFTER the stylesheet
 * has applied and RE-READ whenever the theme changes, or the palette captures
 * stale/empty values. Build once on mount (inside a layout effect, so CSS is
 * live) and re-run `buildTerminalTheme()` from a `data-theme` MutationObserver —
 * see `observeThemeChange`.
 */
import type { ITheme } from '@xterm/xterm';

/** Reads a single CSS custom property value (already `.trim()`-able). */
export type CssVarReader = (varName: string) => string;

/**
 * Map the `--flock-term-*` variables (via an injected reader) to an `ITheme`.
 * Kept free of the DOM so it is unit-testable — jsdom's `getComputedStyle` does
 * not resolve stylesheet-declared custom properties, so tests drive this with a
 * plain lookup instead.
 */
export function terminalThemeFromReader(read: CssVarReader): ITheme {
  // Undefined (not '') for a missing var so xterm keeps its own default for that
  // slot instead of painting it transparent/black.
  const v = (name: string): string | undefined => {
    const raw = read(name).trim();
    return raw.length > 0 ? raw : undefined;
  };
  const ansi = (i: number): string | undefined => v(`--flock-term-ansi-${i}`);
  // term-bg IS surface-0 (see theme.css); the cursor block draws its glyph in the
  // background colour, so cursorAccent tracks the background.
  const background = v('--flock-term-bg');
  return {
    background,
    foreground: v('--flock-term-fg'),
    cursor: v('--flock-term-cursor'),
    cursorAccent: background,
    // Translucent selection tint — no explicit selectionForeground so the
    // underlying glyph colours show through (xterm blends the overlay).
    selectionBackground: v('--flock-term-selection'),
    black: ansi(0),
    red: ansi(1),
    green: ansi(2),
    yellow: ansi(3),
    blue: ansi(4),
    magenta: ansi(5),
    cyan: ansi(6),
    white: ansi(7),
    brightBlack: ansi(8),
    brightRed: ansi(9),
    brightGreen: ansi(10),
    brightYellow: ansi(11),
    brightBlue: ansi(12),
    brightMagenta: ansi(13),
    brightCyan: ansi(14),
    brightWhite: ansi(15),
  };
}

/**
 * Build the live terminal theme by reading `--flock-term-*` off an element
 * (default: the document root that carries `data-theme`). Call this AFTER CSS has
 * loaded (e.g. inside a layout effect) and again on every theme change.
 */
export function buildTerminalTheme(root: Element | null = documentRoot()): ITheme {
  if (!root || typeof getComputedStyle !== 'function') {
    return terminalThemeFromReader(() => '');
  }
  const cs = getComputedStyle(root);
  return terminalThemeFromReader((name) => cs.getPropertyValue(name));
}

/**
 * Subscribe to theme changes: invokes `onChange` whenever the `data-theme`
 * attribute on the document root flips (the signal the ThemeProvider writes on
 * every toggle / OS-preference change). Returns an unsubscribe function.
 */
export function observeThemeChange(onChange: () => void): () => void {
  const root = documentRoot();
  if (!root || typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/**
 * True when the user has requested reduced motion. A blinking cursor is motion,
 * so callers gate `cursorBlink` on the negation of this.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The terminal surface colour as a CSS `var()` reference. Used by the letterbox
 * wrapper + loading fallback so the unfilled margin blends with xterm's own
 * background (no mismatched seam) and follows the theme.
 */
export const TERMINAL_BG_VAR = 'var(--flock-term-bg)';

function documentRoot(): Element | null {
  return typeof document !== 'undefined' ? document.documentElement : null;
}
