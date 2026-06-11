/**
 * Flock theme tokens (US-31, spec Appendix A.3).
 *
 * The single source of truth for the flock-theme design tokens. These values
 * are mirrored 1:1 into CSS custom properties in `../styles/theme.css`. The
 * keys here MUST stay in lock-step with the `--flock-*` variables defined there
 * (a unit test asserts every token has a matching CSS variable so the two never
 * drift).
 *
 * Token taxonomy is taken verbatim from spec Appendix A.3 (line 474):
 *   surface.{0,1,2}, accent, ink.{primary,muted},
 *   status.{starting,running,awaiting,idle,done,error,disconnected}
 *     (these drive the sidebar status dots),
 *   diff.{add,remove,context}, font.ui, font.code
 *
 * The status keys mirror the shared StatusEnum
 * (`packages/shared` — starting | running | awaiting_input | idle | done |
 * error | disconnected). Appendix A.3 abbreviates `awaiting_input` to
 * `awaiting`; we expose BOTH `awaiting` (Appendix name) and `awaiting_input`
 * (StatusEnum name) pointing at the same colour so a renderer can look up
 * `status[session.status]` directly using the StatusEnum value.
 *
 * No component should ever hardcode a colour — everything reads these tokens
 * (via the `--flock-*` CSS variables or the `tokens` map below). Toggling the
 * active theme therefore re-themes every surface.
 */

/** The two first-class themes plus the OS-following pseudo-mode. */
export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** A concrete, resolved theme (never `system`). This is what lands on `data-theme`. */
export const RESOLVED_THEMES = ['light', 'dark'] as const;
export type ResolvedTheme = (typeof RESOLVED_THEMES)[number];

/**
 * The shape of a single theme's token set. Mirrors spec Appendix A.3.
 */
export interface ThemeTokens {
  /** Background surfaces, lowest (page) to highest (popovers/raised cards). */
  surface: {
    0: string;
    1: string;
    2: string;
  };
  /** Primary brand/interaction accent. */
  accent: string;
  /** Foreground text. */
  ink: {
    primary: string;
    muted: string;
  };
  /**
   * Status colours that drive the sidebar status dots. Keys mirror the shared
   * StatusEnum so a renderer can do `status[session.status]`. `awaiting` is the
   * Appendix A.3 alias of `awaiting_input` (same colour).
   */
  status: {
    starting: string;
    running: string;
    awaiting: string;
    awaiting_input: string;
    idle: string;
    done: string;
    error: string;
    disconnected: string;
  };
  /** Diff viewer line tints. */
  diff: {
    add: string;
    remove: string;
    context: string;
  };
  /** Typography. */
  font: {
    ui: string;
    code: string;
  };
}

const FONT_UI =
  '"Inter Variable", "Inter", "Geist Variable", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_CODE =
  '"JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", ui-monospace, monospace';

/**
 * Status palette (light). Maps each StatusEnum state to a hue:
 *   starting   -> slate (spinning up, not yet active)
 *   running    -> blue  (agent is actively working)
 *   awaiting   -> amber (the money state: blocked on the human) — rings sidebar
 *   idle       -> green (connected, quiet)
 *   done       -> teal  (completed cleanly)
 *   error      -> red   (last run errored) — rings sidebar
 *   disconnected -> grey (node/tunnel down, stale)
 */
const STATUS_LIGHT = {
  starting: '#64748b',
  running: '#2563eb',
  awaiting: '#d97706',
  idle: '#16a34a',
  done: '#0d9488',
  error: '#dc2626',
  disconnected: '#9aa3af',
} as const;

const STATUS_DARK = {
  starting: '#8a93a3', // muted slate (spinning up)
  running: '#4f7cc4', // tied to the refined-blue accent (agent working)
  awaiting: '#f59e0b', // amber stays punchy — the "needs me" alert
  idle: '#3fb950', // calmer green (sits in the graphite palette, not neon)
  done: '#2bb6a3', // calmer teal
  error: '#ef4444', // red stays punchy — the alert state
  disconnected: '#6b7280',
} as const;

/** Light theme — the default when the OS reports a light preference. */
export const lightTheme: ThemeTokens = {
  surface: {
    0: '#ffffff',
    1: '#f5f6f8',
    2: '#eaecf0',
  },
  accent: '#2563eb',
  ink: {
    primary: '#1c2024',
    muted: '#5b6470',
  },
  status: {
    ...STATUS_LIGHT,
    awaiting_input: STATUS_LIGHT.awaiting,
  },
  diff: {
    add: '#e6f4ea',
    remove: '#fce8e6',
    context: '#f5f6f8',
  },
  font: {
    ui: FONT_UI,
    code: FONT_CODE,
  },
};

/**
 * Dark theme — Flock's default surface. Linear-style "refined graphite": a
 * de-blued near-black ramp (neutral, faintly cool) with a single calm-blue
 * accent. Hierarchy comes from hairline borders (polish.css) + small surface
 * steps, not loud fills. Inter UI + JetBrains Mono.
 */
export const darkTheme: ThemeTokens = {
  surface: {
    0: '#0a0b0d', // app background — neutral graphite (de-blued)
    1: '#101216', // panels / cards
    2: '#181b20', // raised / hover
  },
  accent: '#5b8cff', // vivid signature blue (energetic, premium)
  ink: {
    primary: '#e7e9ec', // near-white, neutral
    muted: '#888f9a', // cool grey secondary text
  },
  status: {
    ...STATUS_DARK,
    awaiting_input: STATUS_DARK.awaiting,
  },
  diff: {
    add: '#11261a', // muted green wash, sits on graphite
    remove: '#2f1518', // muted red wash
    context: '#101216', // = surface-1
  },
  font: {
    ui: FONT_UI,
    code: FONT_CODE,
  },
};

/** Lookup table keyed by the concrete resolved theme. */
export const themes: Record<ResolvedTheme, ThemeTokens> = {
  light: lightTheme,
  dark: darkTheme,
};

/**
 * Flatten a {@link ThemeTokens} object to the `--flock-*` CSS-variable name/value
 * pairs. Keeps the variable-naming scheme in exactly one place so tokens.ts and
 * theme.css cannot diverge.
 *
 * e.g. `surface.0` -> `--flock-surface-0`, `ink.primary` -> `--flock-ink-primary`,
 * `status.awaiting` -> `--flock-status-awaiting`.
 *
 * Note: `awaiting_input` is an internal alias of `awaiting` and is NOT emitted
 * as its own CSS variable (it would duplicate `--flock-status-awaiting`);
 * renderers using the StatusEnum value `awaiting_input` should map it to the
 * `--flock-status-awaiting` variable (StatusIndicator does this).
 */
export function tokensToCssVars(t: ThemeTokens): Record<string, string> {
  return {
    '--flock-surface-0': t.surface[0],
    '--flock-surface-1': t.surface[1],
    '--flock-surface-2': t.surface[2],
    '--flock-accent': t.accent,
    '--flock-ink-primary': t.ink.primary,
    '--flock-ink-muted': t.ink.muted,
    '--flock-status-starting': t.status.starting,
    '--flock-status-running': t.status.running,
    '--flock-status-awaiting': t.status.awaiting,
    '--flock-status-idle': t.status.idle,
    '--flock-status-done': t.status.done,
    '--flock-status-error': t.status.error,
    '--flock-status-disconnected': t.status.disconnected,
    '--flock-diff-add': t.diff.add,
    '--flock-diff-remove': t.diff.remove,
    '--flock-diff-context': t.diff.context,
    '--flock-font-ui': t.font.ui,
    '--flock-font-code': t.font.code,
  };
}

/** The complete list of `--flock-*` variable names (handy for tests/audits). */
export const FLOCK_CSS_VAR_NAMES = Object.keys(tokensToCssVars(lightTheme));

/**
 * Map a StatusEnum value to its `--flock-status-*` CSS variable name.
 * Collapses `awaiting_input` -> `awaiting` (Appendix A.3 alias).
 */
export function statusCssVar(status: string): string {
  const key = status === 'awaiting_input' ? 'awaiting' : status;
  return `--flock-status-${key}`;
}

/* ------------------------------------------------------------------ */
/* US-37 polish layer                                                  */
/*                                                                     */
/* Theme-INDEPENDENT scales (type, space, radius, elevation, motion).  */
/* These do not vary light vs dark, so they live once in polish.css    */
/* (declared on :root, not duplicated per theme). Names are mirrored    */
/* here so the polish contract (polish.test.ts) is code, not prose.    */
/* They use the same `--flock-*` namespace as the colour tokens above. */
/* ------------------------------------------------------------------ */

/**
 * Deliberate modular type scale (1.20 minor third, 14px base). Smallest →
 * largest. `name` matches the CSS custom property suffix
 * (`--flock-text-<name>`).
 */
export const TYPE_SCALE = [
  { name: '3xs', px: 10 },
  { name: '2xs', px: 11 },
  { name: 'xs', px: 12 },
  { name: 'sm', px: 13 },
  { name: 'md', px: 14 },
  { name: 'lg', px: 16 },
  { name: 'xl', px: 19 },
  { name: '2xl', px: 24 },
] as const;

export const TYPE_TOKENS: readonly string[] = TYPE_SCALE.map((s) => `--flock-text-${s.name}`);

export const WEIGHT_TOKENS = [
  '--flock-weight-regular',
  '--flock-weight-medium',
  '--flock-weight-semibold',
  '--flock-tracking-label',
  '--flock-tracking-tight',
] as const;

export const SPACE_TOKENS = [
  '--flock-space-0',
  '--flock-space-1',
  '--flock-space-2',
  '--flock-space-3',
  '--flock-space-4',
  '--flock-space-5',
  '--flock-space-6',
  '--flock-space-7',
  '--flock-space-8',
] as const;

export const RADIUS_TOKENS = [
  '--flock-radius-xs',
  '--flock-radius-sm',
  '--flock-radius-md',
  '--flock-radius-lg',
  '--flock-radius-full',
] as const;

export const ELEVATION_TOKENS = [
  '--flock-shadow-none',
  '--flock-shadow-overlay',
  '--flock-shadow-focus',
] as const;

export const MOTION_TOKENS = [
  '--flock-ease-standard',
  '--flock-ease-out',
  '--flock-ease-in',
  '--flock-dur-fast',
  '--flock-dur-base',
  '--flock-dur-slow',
  '--flock-pulse-dur',
] as const;

/** Polish token groups, mirroring the polish.css scales. */
export const POLISH_TOKENS = {
  type: TYPE_TOKENS,
  weight: WEIGHT_TOKENS,
  space: SPACE_TOKENS,
  radius: RADIUS_TOKENS,
  elevation: ELEVATION_TOKENS,
  motion: MOTION_TOKENS,
} as const;

/** Flattened list of every required polish token. */
export const ALL_POLISH_TOKENS: readonly string[] = Object.values(POLISH_TOKENS).flat();
