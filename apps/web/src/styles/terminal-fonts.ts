/**
 * UI + terminal + code fonts, all self-hosted (no CDN — works air-gapped, the
 * paddock's target env):
 *   - Inter Variable (@fontsource-variable) — the UI/chrome font (--flock-font-ui),
 *     the Linear-style typeface. Self-hosted so the paddock paints in Inter
 *     instantly with no flash to system-ui (no CDN). Geist is kept as the first
 *     fallback for an air-gapped first paint before Inter resolves.
 *   - JetBrains Mono (@fontsource) — the UI code font (--flock-font-code) and a
 *     fast-painting fallback for the terminal while the Nerd Font loads.
 *   - JetBrainsMono Nerd Font Mono — the terminal font: JetBrains Mono + the full
 *     icon set (Powerline/Devicons/…) so TUI + shell-prompt icons render like a
 *     native terminal. ~1 MB/weight, so it is NOT eager-loaded at app boot — only
 *     fetched when a terminal actually mounts (via loadTerminalFont()).
 */
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/space-grotesk/wght.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/noto-sans-symbols-2/symbols-400.css';
import './jetbrains-mono-nerd.css';

/** The terminal's primary font family (Nerd-patched; falls back to JetBrains Mono). */
export const TERMINAL_FONT_FAMILY = 'JetBrainsMono Nerd Font Mono';
/** Monochrome fallback for terminal symbols that otherwise become platform emoji. */
export const TERMINAL_SYMBOL_FONT_FAMILY = 'Noto Sans Symbols 2';

/**
 * Load the terminal (Nerd) font weights, resolving once they're ready (or fail).
 *
 * CSS @font-face is lazy — a face isn't fetched until a glyph paints in it, and
 * xterm measures its cell at first paint. Calling this on terminal mount fetches
 * the font up-front so xterm can re-measure against the real metrics (avoids
 * loose cells / FOUT). Best-effort: a failure leaves the JetBrains Mono fallback.
 */
export function loadTerminalFont(): Promise<unknown> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return Promise.resolve();
  return Promise.all([
    fonts.load(`400 1em "${TERMINAL_FONT_FAMILY}"`),
    fonts.load(`700 1em "${TERMINAL_FONT_FAMILY}"`),
    fonts.load(`400 1em "${TERMINAL_SYMBOL_FONT_FAMILY}"`, '\u23f8'),
    // Also ensure the JetBrains Mono fallback is hot (instant first paint).
    fonts.load('400 1em "JetBrains Mono"'),
  ]).catch(() => undefined);
}
