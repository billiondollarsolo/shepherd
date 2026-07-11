/**
 * Terminal + code fonts, all self-hosted (no CDN — works air-gapped):
 *   - JetBrains Mono (@fontsource) — the UI code font (--flock-font-code) and a
 *     fast-painting fallback for the terminal while the Nerd Font loads.
 *   - JetBrainsMono Nerd Font Mono — the terminal font: JetBrains Mono + the full
 *     icon set (Powerline/Devicons/…) so TUI + shell-prompt icons render like a
 *     native terminal. ~1 MB/weight, so it is NOT eager-loaded at app boot — only
 *     fetched when a terminal actually mounts (via loadTerminalFont()).
 */
import terminalFontStylesUrl from './terminal-font-assets.css?url';

/** The terminal's primary font family (Nerd-patched; falls back to JetBrains Mono). */
export const TERMINAL_FONT_FAMILY = 'JetBrainsMono Nerd Font Mono';
/** Monochrome fallback for terminal symbols that otherwise become platform emoji. */
export const TERMINAL_SYMBOL_FONT_FAMILY = 'Noto Sans Symbols 2';

let terminalStylesReady: Promise<void> | null = null;

function loadTerminalStyles(): Promise<void> {
  terminalStylesReady ??= new Promise<void>((resolve) => {
    const selector = 'link[data-flock-terminal-fonts]';
    const existing = document.querySelector<HTMLLinkElement>(selector);
    if (existing?.sheet) {
      resolve();
      return;
    }

    const link = existing ?? document.createElement('link');
    const finish = (): void => resolve();
    link.addEventListener('load', finish, { once: true });
    link.addEventListener('error', finish, { once: true });
    if (!existing) {
      link.rel = 'stylesheet';
      link.href = terminalFontStylesUrl;
      link.dataset.flockTerminalFonts = '';
      document.head.append(link);
    }
  });
  return terminalStylesReady;
}

/**
 * Load the terminal (Nerd) font weights, resolving once they're ready (or fail).
 *
 * CSS @font-face is lazy — a face isn't fetched until a glyph paints in it, and
 * xterm measures its cell at first paint. Calling this on terminal mount fetches
 * the font up-front so xterm can re-measure against the real metrics (avoids
 * loose cells / FOUT). Best-effort: a failure leaves the JetBrains Mono fallback.
 */
export async function loadTerminalFont(): Promise<unknown> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return Promise.resolve();
  await loadTerminalStyles();
  return Promise.all([
    fonts.load(`400 1em "${TERMINAL_FONT_FAMILY}"`),
    fonts.load(`400 1em "${TERMINAL_SYMBOL_FONT_FAMILY}"`, '\u23f8'),
    // Also ensure the JetBrains Mono fallback is hot (instant first paint).
    fonts.load('400 1em "JetBrains Mono"'),
  ]).catch(() => undefined);
}
