/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // flock-theme tokens (US-31, spec Appendix A.3) wired as CSS variables.
      // Authoritative values live in src/theme/tokens.ts and src/styles/theme.css
      // (the --flock-* custom properties), which flip with light/dark. These
      // utility-class bindings just reference those variables.
      colors: {
        // Compact semantic utilities mapped to first-class tokens in index.css.
        'flock-bg': 'var(--flock-bg)',
        'flock-surface': 'var(--flock-surface)',
        'flock-fg': 'var(--flock-fg)',
        'flock-muted': 'var(--flock-muted)',
        'flock-attention': 'var(--flock-attention)',
        'flock-error': 'var(--flock-error)',
        // First-class flock-theme tokens. accent/ink use raw-channel vars so the
        // Tailwind /opacity modifier works (rgb(var(--x-rgb) / <alpha-value>)); the
        // hex --flock-* vars still exist for direct var()/color-mix in inline styles.
        'flock-accent': 'rgb(var(--flock-accent-rgb) / <alpha-value>)',
        'flock-surface-0': 'var(--flock-surface-0)',
        'flock-surface-1': 'var(--flock-surface-1)',
        'flock-surface-2': 'var(--flock-surface-2)',
        'flock-surface-3': 'var(--flock-surface-3)',
        'flock-ink-primary': 'rgb(var(--flock-ink-primary-rgb) / <alpha-value>)',
        'flock-ink-muted': 'rgb(var(--flock-ink-muted-rgb) / <alpha-value>)',
        // Diff line tints.
        'flock-diff-add': 'var(--flock-diff-add)',
        'flock-diff-remove': 'var(--flock-diff-remove)',
        'flock-diff-context': 'var(--flock-diff-context)',
        // Diff line-text foregrounds (saturated, AA on the tints). Exposed two
        // ways: flock-diff-add-fg/flock-diff-remove-fg AND the diff.add/remove
        // shorthand so text-diff-add / text-diff-remove resolve (they were dead).
        'flock-diff-add-fg': 'var(--flock-diff-add-fg)',
        'flock-diff-remove-fg': 'var(--flock-diff-remove-fg)',
        diff: {
          add: 'var(--flock-diff-add-fg)',
          remove: 'var(--flock-diff-remove-fg)',
        },
        // Semantic-intent fills + AA foregrounds (bg-intent-* / text-intent-*-foreground,
        // also border-/ring-). Deliberately distinct from the agent-status hues.
        intent: {
          success: 'var(--flock-intent-success)',
          'success-foreground': 'var(--flock-intent-success-foreground)',
          warning: 'var(--flock-intent-warning)',
          'warning-foreground': 'var(--flock-intent-warning-foreground)',
          danger: 'var(--flock-intent-danger)',
          'danger-foreground': 'var(--flock-intent-danger-foreground)',
          info: 'var(--flock-intent-info)',
          'info-foreground': 'var(--flock-intent-info-foreground)',
        },
        // Status colours that drive the sidebar dots/rings (StatusIndicator
        // uses bg-status-* / ring-status-*). Keys mirror the shared StatusEnum;
        // `awaiting` is the Appendix A.3 alias of `awaiting_input`.
        status: {
          starting: 'var(--flock-status-starting)',
          running: 'var(--flock-status-running)',
          awaiting: 'var(--flock-status-awaiting)',
          idle: 'var(--flock-status-idle)',
          done: 'var(--flock-status-done)',
          error: 'var(--flock-status-error)',
          disconnected: 'var(--flock-status-disconnected)',
        },
      },
      // First-class background utilities for the color-mix/translucent tokens
      // (these can't take the /opacity modifier, so they bind straight through).
      // Lets components drop the [var(--flock-*)] arbitrary-value escape hatch:
      //   bg-flock-hover / bg-flock-accent-soft / bg-flock-accent-hover /
      //   bg-flock-scrim / bg-flock-border (for hairline rules & separators).
      backgroundColor: {
        'flock-hover': 'var(--flock-surface-hover)',
        'flock-accent-soft': 'var(--flock-accent-soft)',
        'flock-accent-hover': 'var(--flock-accent-hover)',
        'flock-scrim': 'var(--flock-scrim)',
        'flock-border': 'var(--flock-border)',
      },
      fontFamily: {
        sans: ['var(--flock-font-ui)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--flock-font-code)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // US-37 polish: deliberate type/space/radius/elevation/motion scales,
      // bound to the theme-independent --flock-* custom properties in
      // styles/polish.css so utilities and raw CSS never drift.
      fontSize: {
        '3xs': ['var(--flock-text-3xs)', 'var(--flock-leading-3xs)'],
        '2xs': ['var(--flock-text-2xs)', 'var(--flock-leading-2xs)'],
        xs: ['var(--flock-text-xs)', 'var(--flock-leading-xs)'],
        sm: ['var(--flock-text-sm)', 'var(--flock-leading-sm)'],
        md: ['var(--flock-text-md)', 'var(--flock-leading-md)'],
        lg: ['var(--flock-text-lg)', 'var(--flock-leading-lg)'],
        xl: ['var(--flock-text-xl)', 'var(--flock-leading-xl)'],
        '2xl': ['var(--flock-text-2xl)', 'var(--flock-leading-2xl)'],
      },
      fontWeight: {
        regular: 'var(--flock-weight-regular)',
        medium: 'var(--flock-weight-medium)',
        semibold: 'var(--flock-weight-semibold)',
      },
      letterSpacing: {
        label: 'var(--flock-tracking-label)',
        tight: 'var(--flock-tracking-tight)',
      },
      spacing: {
        1: 'var(--flock-space-1)',
        2: 'var(--flock-space-2)',
        3: 'var(--flock-space-3)',
        4: 'var(--flock-space-4)',
        5: 'var(--flock-space-5)',
        6: 'var(--flock-space-6)',
        7: 'var(--flock-space-7)',
        8: 'var(--flock-space-8)',
      },
      borderRadius: {
        xs: 'var(--flock-radius-xs)',
        sm: 'var(--flock-radius-sm)',
        md: 'var(--flock-radius-md)',
        lg: 'var(--flock-radius-lg)',
        full: 'var(--flock-radius-full)',
      },
      borderColor: {
        DEFAULT: 'var(--flock-border)',
        strong: 'var(--flock-border-strong)',
        accent: 'var(--flock-accent)',
        'accent-soft': 'var(--flock-accent-soft)',
      },
      ringColor: {
        // Subtle top-highlight ring on raised controls — replaces ring-white/[0.03].
        highlight: 'var(--flock-ring-highlight)',
      },
      boxShadow: {
        overlay: 'var(--flock-shadow-overlay)',
        focus: 'var(--flock-shadow-focus)',
        // Overlay-depth ramp (overlays only; distinct names so Tailwind's default
        // shadow-sm/md/lg on raised controls are left untouched).
        'flock-sm': 'var(--flock-shadow-sm)',
        'flock-md': 'var(--flock-shadow-md)',
        'flock-lg': 'var(--flock-shadow-lg)',
        // Focus ring with an overridable inner-gap colour (--flock-focus-ring-gap).
        'focus-ring': 'var(--flock-focus-ring)',
      },
      transitionTimingFunction: {
        standard: 'var(--flock-ease-standard)',
        'flock-out': 'var(--flock-ease-out)',
        'flock-in': 'var(--flock-ease-in)',
      },
      transitionDuration: {
        fast: '120ms',
        base: '180ms',
        slow: '240ms',
      },
      width: {
        sidebar: 'var(--flock-sidebar-w)',
        rail: 'var(--flock-rail-w)',
        activity: 'var(--flock-activity-w)',
      },
      height: {
        topbar: 'var(--flock-topbar-h)',
        drawer: 'var(--flock-drawer-h)',
        row: 'var(--flock-row-h)',
        tab: 'var(--flock-tab-h)',
      },
      keyframes: {
        'flock-pulse': {
          '0%': {
            boxShadow:
              '0 0 0 0 color-mix(in srgb, var(--flock-indicator-color, currentColor) 55%, transparent)',
          },
          '70%': {
            boxShadow:
              '0 0 0 6px color-mix(in srgb, var(--flock-indicator-color, currentColor) 0%, transparent)',
          },
          '100%': {
            boxShadow:
              '0 0 0 0 color-mix(in srgb, var(--flock-indicator-color, currentColor) 0%, transparent)',
          },
        },
      },
      animation: {
        'flock-pulse': 'flock-pulse var(--flock-pulse-dur) var(--flock-ease-out) infinite',
        // Shared overlay enter/exit (Dialog/Popover/Select/DropdownMenu/Tooltip).
        // Keyframes are hand-authored in styles/polish.css (flock-overlay-in/out)
        // and bound here to --flock-dur-base + --flock-ease-standard. `both` keeps
        // the start/end frame so there's no flash; the reduced-motion block in
        // polish.css collapses these to a near-instant state.
        'overlay-in': 'flock-overlay-in var(--flock-dur-base) var(--flock-ease-standard) both',
        'overlay-out': 'flock-overlay-out var(--flock-dur-base) var(--flock-ease-standard) both',
      },
      // Backdrop blur for the modal/overlay scrim (backdrop-blur-scrim).
      backdropBlur: {
        scrim: 'var(--flock-scrim-blur)',
      },
    },
  },
  plugins: [],
};
