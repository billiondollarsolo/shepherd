/**
 * Shepherd theme tokens (US-31, spec Appendix A.3).
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
    3: string;
  };
  /** Primary brand/interaction accent. */
  accent: string;
  /** Text/icon colour with AA contrast on the accent fill. */
  accentForeground: string;
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
  /**
   * Diff viewer. `add`/`remove`/`context` are the low-contrast line *tints*;
   * `addForeground`/`removeForeground` are the saturated line *text* colours
   * (WCAG-AA on their respective tint fills).
   */
  diff: {
    add: string;
    remove: string;
    context: string;
    addForeground: string;
    removeForeground: string;
  };
  /**
   * Semantic-intent fills + AA foregrounds (toasts, badges, destructive/confirm
   * actions). Deliberately distinct from the agent-status hues.
   */
  intent: {
    success: string;
    successForeground: string;
    warning: string;
    warningForeground: string;
    danger: string;
    dangerForeground: string;
    info: string;
    infoForeground: string;
  };
  /** Modal/overlay backdrop (translucent) + its optional backdrop-blur radius. */
  scrim: string;
  scrimBlur: string;
  /**
   * Terminal palette. The xterm/ghostty `ITheme` is built from these vars.
   * `bg` == `surface-0` (the app's true-black surface); `ansi` is the 16-colour
   * palette, indices 0..15 in standard order.
   */
  term: {
    bg: string;
    fg: string;
    cursor: string;
    selection: string;
    ansi: readonly string[];
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
 *   starting   -> slate  (spinning up, not yet active)
 *   running    -> indigo (agent is actively working)
 *   awaiting   -> amber  (the money state: blocked on the human) — rings sidebar
 *   idle       -> green  (connected, quiet)
 *   done       -> teal   (completed cleanly)
 *   error      -> red    (last run errored) — rings sidebar
 *   disconnected -> grey  (node/tunnel down, stale)
 *
 * SINGLE-ACCENT RULE (US, Phase 1.5): **blue is reserved for interaction**
 * (`accent` — selection, focus, links, primary actions). `running` therefore is
 * a distinct, calm INDIGO — clearly off the interaction blue — so that in a dense
 * grid a selected/focused cell never reads the same as a running agent. If you
 * need "actively working", use `status.running`; if you need "interactive", use
 * `accent`. Do not collapse the two back onto the same hue.
 */
const STATUS_LIGHT = {
  starting: '#64748b',
  running: '#5850c4', // calm indigo — deliberately NOT the blue interaction accent
  awaiting: '#d97706',
  idle: '#16a34a',
  done: '#0d9488',
  error: '#dc2626',
  disconnected: '#9aa3af',
} as const;

const STATUS_DARK = {
  starting: '#8a8a8a', // muted grey (spinning up)
  running: '#7b74d4', // calm indigo — its own "working" hue, off the interaction blue
  awaiting: '#f59e0b', // amber stays punchy — the "needs me" alert
  idle: '#3fb950', // calmer green (sits in the graphite palette, not neon)
  done: '#2bb6a3', // calmer teal
  error: '#ef4444', // red stays punchy — the alert state
  disconnected: '#6b7280',
} as const;

/**
 * Semantic-intent fills + AA-verified foregrounds — the "solid action" colours
 * (destructive/confirm buttons, toast types, badges). These are deliberately
 * kept OFF the agent-status hues so a red "danger" button never reads as an
 * errored agent. Every `*Foreground` below is WCAG-AA (>=4.5:1) on its own fill.
 */
const INTENT_LIGHT = {
  success: '#15803d',
  successForeground: '#ffffff',
  warning: '#b45309',
  warningForeground: '#ffffff',
  danger: '#b91c1c',
  dangerForeground: '#ffffff',
  info: '#1d4ed8',
  infoForeground: '#ffffff',
} as const;

const INTENT_DARK = {
  success: '#2f7d3a',
  successForeground: '#ffffff',
  warning: '#8a5a08',
  warningForeground: '#ffffff',
  danger: '#b5302e',
  dangerForeground: '#ffffff',
  info: '#2f5fb0',
  infoForeground: '#ffffff',
} as const;

/**
 * Terminal ANSI palettes (indices 0..15, standard order: black, red, green,
 * yellow, blue, magenta, cyan, white, then the 8 "bright" variants). Dark is
 * Atom "One Dark"; light is Atom "One Light" — both chosen for legibility on the
 * true-black / white terminal surface. Consumed by the xterm/ghostty ITheme,
 * built from the `--flock-term-*` vars via getComputedStyle (Phase 4).
 */
const TERM_ANSI_LIGHT = [
  '#383a42', // 0  black
  '#e45649', // 1  red
  '#50a14f', // 2  green
  '#c18401', // 3  yellow
  '#4078f2', // 4  blue
  '#a626a4', // 5  magenta
  '#0184bc', // 6  cyan
  '#a0a1a7', // 7  white
  '#696c77', // 8  bright black
  '#e45649', // 9  bright red
  '#50a14f', // 10 bright green
  '#c18401', // 11 bright yellow
  '#4078f2', // 12 bright blue
  '#a626a4', // 13 bright magenta
  '#0184bc', // 14 bright cyan
  '#090a0b', // 15 bright white
] as const;

const TERM_ANSI_DARK = [
  '#282c34', // 0  black
  '#e06c75', // 1  red
  '#98c379', // 2  green
  '#d19a66', // 3  yellow
  '#61afef', // 4  blue
  '#c678dd', // 5  magenta
  '#56b6c2', // 6  cyan
  '#abb2bf', // 7  white
  '#5c6370', // 8  bright black
  '#e06c75', // 9  bright red
  '#98c379', // 10 bright green
  '#d19a66', // 11 bright yellow
  '#61afef', // 12 bright blue
  '#c678dd', // 13 bright magenta
  '#56b6c2', // 14 bright cyan
  '#ffffff', // 15 bright white
] as const;

/** Light theme — the default when the OS reports a light preference. */
export const lightTheme: ThemeTokens = {
  surface: {
    0: '#ffffff',
    1: '#f5f6f8',
    2: '#eaecf0',
    3: '#e0e3e9',
  },
  accent: '#4f46e5',
  accentForeground: '#ffffff',
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
    addForeground: '#0f7a34',
    removeForeground: '#b3261e',
  },
  intent: INTENT_LIGHT,
  scrim: 'rgba(0, 0, 0, 0.5)',
  scrimBlur: '2px',
  term: {
    bg: '#ffffff', // = surface-0
    fg: '#1c2024', // = ink-primary
    cursor: '#1c2024',
    selection: 'rgba(79, 70, 229, 0.22)',
    ansi: TERM_ANSI_LIGHT,
  },
  font: {
    ui: FONT_UI,
    code: FONT_CODE,
  },
};

/**
 * Dark theme — Shepherd's default surface. A true black-to-graphite neutral ramp
 * with a light-grey interaction accent. Hierarchy comes from hairline borders
 * (polish.css) + small surface
 * steps, not loud fills. Inter UI + JetBrains Mono.
 */
export const darkTheme: ThemeTokens = {
  surface: {
    0: '#0d0d0f', // app background — cool graphite near-black
    1: '#151517', // panels / cards / sidebar
    2: '#1c1c1f', // raised / hover / composer
    3: '#26262a', // highest — chips / nested raised
  },
  accent: '#6470f0', // soft periwinkle-indigo — the one confident interaction hue
  // Dark text on the accent fill: white on #6470f0 is only 4.1:1 (below AA 4.5),
  // whereas near-black is 4.73:1 — and keeping the accent bright preserves its
  // contrast when used AS text/icons on the dark surface. (Light theme keeps white.)
  accentForeground: '#0d0d0f',
  ink: {
    primary: '#ededed', // near-white, neutral
    muted: '#8c8c8c', // neutral grey secondary text
  },
  status: {
    ...STATUS_DARK,
    awaiting_input: STATUS_DARK.awaiting,
  },
  diff: {
    add: '#11261a', // muted green wash, sits on graphite
    remove: '#2f1518', // muted red wash
    context: '#151517', // = surface-1
    addForeground: '#3fb950', // saturated green, AA on the add wash
    removeForeground: '#f85149', // saturated red, AA on the remove wash
  },
  intent: INTENT_DARK,
  scrim: 'rgba(0, 0, 0, 0.6)',
  scrimBlur: '2px',
  term: {
    bg: '#0d0d0f', // = surface-0, cool graphite near-black
    fg: '#c8ccd4', // soft light-grey terminal text
    cursor: '#ededed', // = ink-primary
    selection: 'rgba(100, 112, 240, 0.3)',
    ansi: TERM_ANSI_DARK,
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
  const vars: Record<string, string> = {
    '--flock-surface-0': t.surface[0],
    '--flock-surface-1': t.surface[1],
    '--flock-surface-2': t.surface[2],
    '--flock-surface-3': t.surface[3],
    '--flock-accent': t.accent,
    '--flock-accent-foreground': t.accentForeground,
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
    '--flock-diff-add-fg': t.diff.addForeground,
    '--flock-diff-remove-fg': t.diff.removeForeground,
    '--flock-intent-success': t.intent.success,
    '--flock-intent-success-foreground': t.intent.successForeground,
    '--flock-intent-warning': t.intent.warning,
    '--flock-intent-warning-foreground': t.intent.warningForeground,
    '--flock-intent-danger': t.intent.danger,
    '--flock-intent-danger-foreground': t.intent.dangerForeground,
    '--flock-intent-info': t.intent.info,
    '--flock-intent-info-foreground': t.intent.infoForeground,
    '--flock-scrim': t.scrim,
    '--flock-scrim-blur': t.scrimBlur,
    '--flock-term-bg': t.term.bg,
    '--flock-term-fg': t.term.fg,
    '--flock-term-cursor': t.term.cursor,
    '--flock-term-selection': t.term.selection,
    '--flock-font-ui': t.font.ui,
    '--flock-font-code': t.font.code,
  };
  // The 16-colour ANSI palette expands to --flock-term-ansi-0 .. -15.
  t.term.ansi.forEach((colour, i) => {
    vars[`--flock-term-ansi-${i}`] = colour;
  });
  return vars;
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
 * Deliberate, hand-tuned readable type scale (11–24px, 14px base). NOTE: this is
 * NOT a pure modular scale — the small end was bumped +1px (2026-06-08) for
 * all-day legibility, so adjacent steps sit within a calm ratio (≤1.20) rather
 * than a fixed minor third. These are the *shipped* polish.css figures, mirrored
 * here 1:1 (polish.test.ts asserts px value-parity, not just name presence).
 * Smallest → largest. `name` matches the CSS custom property suffix
 * (`--flock-text-<name>`).
 */
export const TYPE_SCALE = [
  { name: '3xs', px: 11 },
  { name: '2xs', px: 12 },
  { name: 'xs', px: 13 },
  { name: 'sm', px: 14 },
  { name: 'md', px: 15 },
  { name: 'lg', px: 17 },
  { name: 'xl', px: 20 },
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
  // Overlay-depth ramp — layer-differentiated depth for stacked overlays ONLY
  // (menus/popovers/dialogs). Raised in-flow controls keep border-carried
  // elevation; the dark override adds depth + a hairline ring (not a flat 5% black).
  '--flock-shadow-sm',
  '--flock-shadow-md',
  '--flock-shadow-lg',
  // Focus ring whose inner "gap" colour defaults to surface-0 but is overridable
  // per elevated container (via --flock-focus-ring-gap).
  '--flock-focus-ring',
  // Subtle top-highlight ring on raised controls (replaces hardcoded ring-white/[0.03]).
  '--flock-ring-highlight',
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
