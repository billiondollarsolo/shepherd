import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POLISH_TOKENS,
  ALL_POLISH_TOKENS,
  TYPE_SCALE,
  MOTION_TOKENS,
} from './tokens';

/**
 * US-37 design-polish contract.
 *
 * US-31 (theme.contract.test.ts) already guarantees the per-theme COLOUR tokens.
 * This suite guards the *polish* layer added in US-37:
 *   - a deliberate modular type scale,
 *   - spacing + radius scales,
 *   - elevation + motion tokens,
 * declared ONCE (theme-independent) in styles/polish.css, plus the signature
 * status-indicator rendering + the reduced-motion fallback. (Same path-reading
 * pattern as theme.contract.test.ts.)
 */
const here = dirname(fileURLToPath(import.meta.url));
const polishCss = readFileSync(resolve(here, '../styles/polish.css'), 'utf8');

describe('US-37 polish tokens', () => {
  it('groups cover the deliberate type/space/radius/elevation/motion scales', () => {
    expect(Object.keys(POLISH_TOKENS).sort()).toEqual(
      ['elevation', 'motion', 'radius', 'space', 'type', 'weight'].sort(),
    );
  });

  it('every polish token is declared in polish.css', () => {
    for (const t of ALL_POLISH_TOKENS) {
      expect(polishCss, `polish.css missing ${t}`).toContain(t);
    }
  });

  it('exposes a modular type scale of at least 8 steps, smallest -> largest', () => {
    expect(TYPE_SCALE.length).toBeGreaterThanOrEqual(8);
    for (let i = 1; i < TYPE_SCALE.length; i++) {
      expect(TYPE_SCALE[i].px).toBeGreaterThan(TYPE_SCALE[i - 1].px);
    }
    // adjacent steps stay within a calm (<=1.5x) ratio — a deliberate scale.
    const ratios = TYPE_SCALE.slice(1).map((s, i) => s.px / TYPE_SCALE[i].px);
    expect(Math.max(...ratios)).toBeLessThanOrEqual(1.5);
  });

  it('declares motion durations and the signature pulse duration', () => {
    expect(MOTION_TOKENS).toContain('--flock-pulse-dur');
    expect(MOTION_TOKENS).toContain('--flock-dur-fast');
    expect(MOTION_TOKENS).toContain('--flock-ease-standard');
  });
});

describe('US-37 signature micro-motion', () => {
  it('defines the flock-pulse keyframes', () => {
    expect(polishCss).toContain('@keyframes flock-pulse');
  });

  it('renders the status indicator dot from its size + colour vars', () => {
    expect(polishCss).toContain('.flock-status-indicator');
    expect(polishCss).toContain('var(--flock-indicator-size');
    expect(polishCss).toContain('var(--flock-indicator-color');
  });

  it('pulses only the ringing (awaiting_input/error) indicators', () => {
    expect(polishCss).toContain("[data-rings='true']");
    expect(polishCss).toContain('flock-pulse');
  });

  it('collapses motion under prefers-reduced-motion', () => {
    expect(polishCss).toContain('prefers-reduced-motion');
  });
});
