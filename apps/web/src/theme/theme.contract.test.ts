import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { darkTheme, lightTheme, tokensToCssVars } from './tokens';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../styles/theme.css');
const css = readFileSync(cssPath, 'utf8');

/**
 * Extract the `--flock-*` declarations that appear within CSS blocks whose
 * selector text matches `selectorMatch`. Returns a name->value map (last write
 * wins, matching CSS cascade for identical specificity ordering in-file).
 */
function readBlockVars(selectorMatch: RegExp): Record<string, string> {
  const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const out: Record<string, string> = {};
  for (const [, selector, body] of blocks) {
    if (!selectorMatch.test(selector)) continue;
    for (const decl of body.split(';')) {
      const m = decl.match(/(--flock-[\w-]+)\s*:\s*([^;]+)/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
  }
  return out;
}

/** Normalize a CSS value for comparison: unify quotes, collapse whitespace, lowercase. */
function normalize(v: string): string {
  return v
    .replace(/["']/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Fonts are theme-invariant (same UI/code font in light and dark): declared once
// on :root and intentionally NOT repeated in the dark block. The contract treats
// them as :root-only.
const FONT_VARS = new Set(['--flock-font-ui', '--flock-font-code']);

describe('theme.css <-> tokens.ts contract', () => {
  it('defines every --flock-* variable for the light theme on :root', () => {
    // Match the light/root blocks but NOT the dark explicit block.
    const cssVars = readBlockVars(/:root(\[data-theme='light'\])?\s*$/m);
    const expected = tokensToCssVars(lightTheme);
    for (const [name, value] of Object.entries(expected)) {
      expect(cssVars[name], `theme.css :root missing ${name}`).toBeDefined();
      expect(normalize(cssVars[name]!), `light ${name} value mismatch`).toBe(normalize(value));
    }
  });

  it('defines every per-theme --flock-* colour for the dark theme on [data-theme="dark"]', () => {
    const cssVars = readBlockVars(/:root\[data-theme='dark'\]/);
    const expected = tokensToCssVars(darkTheme);
    for (const [name, value] of Object.entries(expected)) {
      if (FONT_VARS.has(name)) continue; // fonts inherit from :root, not repeated
      expect(cssVars[name], `theme.css [data-theme="dark"] missing ${name}`).toBeDefined();
      expect(normalize(cssVars[name]!), `dark ${name} value mismatch`).toBe(normalize(value));
    }
  });

  it('declares the (theme-invariant) font tokens on :root', () => {
    const cssVars = readBlockVars(/:root(\[data-theme='light'\])?\s*$/m);
    for (const name of FONT_VARS) {
      expect(cssVars[name], `theme.css :root missing ${name}`).toBeDefined();
    }
  });

  it('provides a prefers-color-scheme: dark fallback for first paint with no choice', () => {
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(css).toMatch(/:root:not\(\[data-theme\]\)/);
  });

  it('wires the sidebar status dots to the status.* tokens', () => {
    expect(css).toMatch(/\.flock-status-dot\[data-status='awaiting(_input)?'\]/);
    expect(css).toContain('var(--flock-status-awaiting)');
    expect(css).toContain('var(--flock-status-error)');
    expect(css).toContain('var(--flock-status-running)');
  });

  it('applies surface/ink tokens to html and body so the page is legible', () => {
    expect(css).toContain('background-color: var(--flock-surface-0)');
    expect(css).toContain('color: var(--flock-ink-primary)');
  });
});
