import { describe, expect, it } from 'vitest';
import {
  FLOCK_CSS_VAR_NAMES,
  RESOLVED_THEMES,
  THEME_MODES,
  darkTheme,
  lightTheme,
  statusCssVar,
  themes,
  tokensToCssVars,
  type ThemeTokens,
} from './tokens';

/**
 * Every token leaf path we expect from spec Appendix A.3 (line 474). Status
 * keys mirror the shared StatusEnum; `awaiting` is the Appendix alias of
 * `awaiting_input` and shares its colour.
 */
const REQUIRED_PATHS = [
  'surface.0',
  'surface.1',
  'surface.2',
  'accent',
  'ink.primary',
  'ink.muted',
  'status.starting',
  'status.running',
  'status.awaiting',
  'status.idle',
  'status.done',
  'status.error',
  'status.disconnected',
  'diff.add',
  'diff.remove',
  'diff.context',
  'font.ui',
  'font.code',
];

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

describe('flock-theme tokens (Appendix A.3)', () => {
  it('declares exactly two first-class themes plus system mode', () => {
    expect([...THEME_MODES]).toEqual(['light', 'dark', 'system']);
    expect([...RESOLVED_THEMES]).toEqual(['light', 'dark']);
  });

  it.each(['light', 'dark'] as const)('%s theme defines every required token path', (name) => {
    const t: ThemeTokens = themes[name];
    for (const path of REQUIRED_PATHS) {
      const value = getPath(t, path);
      expect(value, `missing token ${name}.${path}`).toBeTypeOf('string');
      expect((value as string).length, `empty token ${name}.${path}`).toBeGreaterThan(0);
    }
  });

  it('uses valid hex colours for every colour token (not fonts)', () => {
    for (const name of RESOLVED_THEMES) {
      const t = themes[name];
      const colourPaths = REQUIRED_PATHS.filter((p) => !p.startsWith('font.'));
      for (const p of colourPaths) {
        expect(getPath(t, p), `${name}.${p} is not a hex colour`).toMatch(HEX);
      }
    }
  });

  it('light and dark differ on every surface/ink colour (they are distinct themes)', () => {
    expect(lightTheme.surface[0]).not.toBe(darkTheme.surface[0]);
    expect(lightTheme.surface[1]).not.toBe(darkTheme.surface[1]);
    expect(lightTheme.surface[2]).not.toBe(darkTheme.surface[2]);
    expect(lightTheme.ink.primary).not.toBe(darkTheme.ink.primary);
  });

  it('provides a status colour for every StatusEnum state (sidebar dots)', () => {
    // awaiting_input must alias awaiting; full StatusEnum coverage required.
    for (const name of RESOLVED_THEMES) {
      const s = themes[name].status;
      expect(Object.keys(s).sort()).toEqual(
        [
          'awaiting',
          'awaiting_input',
          'disconnected',
          'done',
          'error',
          'idle',
          'running',
          'starting',
        ].sort(),
      );
      expect(s.awaiting_input).toBe(s.awaiting);
    }
  });

  it('maps StatusEnum values to --flock-status-* variables (awaiting_input -> awaiting)', () => {
    expect(statusCssVar('running')).toBe('--flock-status-running');
    expect(statusCssVar('error')).toBe('--flock-status-error');
    expect(statusCssVar('awaiting_input')).toBe('--flock-status-awaiting');
    expect(statusCssVar('disconnected')).toBe('--flock-status-disconnected');
  });

  it('flattens to --flock-* CSS variables', () => {
    const vars = tokensToCssVars(lightTheme);
    expect(vars['--flock-surface-0']).toBe(lightTheme.surface[0]);
    expect(vars['--flock-ink-primary']).toBe(lightTheme.ink.primary);
    expect(vars['--flock-status-running']).toBe(lightTheme.status.running);
    expect(vars['--flock-status-awaiting']).toBe(lightTheme.status.awaiting);
    expect(vars['--flock-diff-add']).toBe(lightTheme.diff.add);
    // The alias must NOT produce a duplicate variable.
    expect(vars['--flock-status-awaiting_input']).toBeUndefined();
    for (const v of FLOCK_CSS_VAR_NAMES) {
      expect(v.startsWith('--flock-')).toBe(true);
    }
  });
});
