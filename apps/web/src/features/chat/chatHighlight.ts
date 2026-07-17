/**
 * Lazily-loaded syntax highlighter for chat code blocks. highlight.js (core + a
 * curated language set) is DYNAMIC-imported so it lands in its own async chunk
 * instead of bloating the critical-path paddock bundle — a code block renders as
 * plain text first, then upgrades to highlighted markup once this resolves (cached
 * after the first load). Token colours map to --flock-term-ansi-* in index.css.
 */

const LANG_NAMES = [
  'bash',
  'css',
  'go',
  'javascript',
  'json',
  'markdown',
  'python',
  'rust',
  'typescript',
  'xml',
  'yaml',
] as const;

let ready: Promise<(code: string, lang: string) => string> | null = null;

function loadHighlighter(): Promise<(code: string, lang: string) => string> {
  if (!ready) {
    ready = (async () => {
      const core = (await import('highlight.js/lib/core')).default;
      const mods = await Promise.all([
        import('highlight.js/lib/languages/bash'),
        import('highlight.js/lib/languages/css'),
        import('highlight.js/lib/languages/go'),
        import('highlight.js/lib/languages/javascript'),
        import('highlight.js/lib/languages/json'),
        import('highlight.js/lib/languages/markdown'),
        import('highlight.js/lib/languages/python'),
        import('highlight.js/lib/languages/rust'),
        import('highlight.js/lib/languages/typescript'),
        import('highlight.js/lib/languages/xml'),
        import('highlight.js/lib/languages/yaml'),
      ]);
      mods.forEach((m, i) => core.registerLanguage(LANG_NAMES[i]!, m.default));
      return (code: string, lang: string): string =>
        lang && core.getLanguage(lang)
          ? core.highlight(code, { language: lang, ignoreIllegals: true }).value
          : core.highlightAuto(code).value;
    })();
  }
  return ready;
}

/** Highlight `code` to trusted HTML (highlight.js escapes the source). */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const highlight = await loadHighlighter();
  return highlight(code, lang);
}
