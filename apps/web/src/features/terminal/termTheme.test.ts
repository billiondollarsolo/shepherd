import { describe, it, expect } from 'vitest';
import { terminalThemeFromReader, prefersReducedMotion } from './termTheme';

/** A fake `--flock-term-*` var map, mirroring the LIGHT tokens in theme.css. */
const LIGHT_VARS: Record<string, string> = {
  '--flock-term-bg': '#ffffff',
  '--flock-term-fg': '#1c2024',
  '--flock-term-cursor': '#1c2024',
  '--flock-term-selection': 'rgba(37, 99, 235, 0.22)',
  '--flock-term-ansi-0': '#383a42',
  '--flock-term-ansi-1': '#e45649',
  '--flock-term-ansi-2': '#50a14f',
  '--flock-term-ansi-7': '#a0a1a7',
  '--flock-term-ansi-15': '#090a0b',
};

describe('terminalThemeFromReader', () => {
  const read = (name: string): string => LIGHT_VARS[name] ?? '';
  const theme = terminalThemeFromReader(read);

  it('maps the core surface vars', () => {
    expect(theme.background).toBe('#ffffff');
    expect(theme.foreground).toBe('#1c2024');
    expect(theme.cursor).toBe('#1c2024');
    expect(theme.selectionBackground).toBe('rgba(37, 99, 235, 0.22)');
  });

  it('tracks the background for the cursor block glyph (cursorAccent)', () => {
    expect(theme.cursorAccent).toBe(theme.background);
  });

  it('maps ansi-0..15 onto the named palette slots', () => {
    expect(theme.black).toBe('#383a42'); // ansi-0
    expect(theme.red).toBe('#e45649'); // ansi-1
    expect(theme.green).toBe('#50a14f'); // ansi-2
    expect(theme.white).toBe('#a0a1a7'); // ansi-7
    expect(theme.brightWhite).toBe('#090a0b'); // ansi-15
  });

  it('trims whitespace that getComputedStyle can prefix onto values', () => {
    const padded = terminalThemeFromReader((name) => ` ${LIGHT_VARS[name] ?? ''} `);
    expect(padded.background).toBe('#ffffff');
  });

  it('leaves a slot undefined (not empty) when its var is missing', () => {
    // ansi-3 is absent from LIGHT_VARS → xterm keeps its own default.
    expect(theme.yellow).toBeUndefined();
  });
});

describe('prefersReducedMotion', () => {
  it('reflects the matchMedia result without throwing', () => {
    expect(typeof prefersReducedMotion()).toBe('boolean');
  });
});
