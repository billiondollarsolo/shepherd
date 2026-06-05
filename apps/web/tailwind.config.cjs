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
        // Legacy aliases (kept for backward compat; mapped to tokens in index.css).
        'flock-bg': 'var(--flock-bg)',
        'flock-surface': 'var(--flock-surface)',
        'flock-fg': 'var(--flock-fg)',
        'flock-muted': 'var(--flock-muted)',
        'flock-attention': 'var(--flock-attention)',
        'flock-error': 'var(--flock-error)',
        // First-class flock-theme tokens.
        'flock-accent': 'var(--flock-accent)',
        'flock-surface-0': 'var(--flock-surface-0)',
        'flock-surface-1': 'var(--flock-surface-1)',
        'flock-surface-2': 'var(--flock-surface-2)',
        'flock-ink-primary': 'var(--flock-ink-primary)',
        'flock-ink-muted': 'var(--flock-ink-muted)',
        // Diff line tints.
        'flock-diff-add': 'var(--flock-diff-add)',
        'flock-diff-remove': 'var(--flock-diff-remove)',
        'flock-diff-context': 'var(--flock-diff-context)',
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
      },
      boxShadow: {
        overlay: 'var(--flock-shadow-overlay)',
        focus: 'var(--flock-shadow-focus)',
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
      },
    },
  },
  plugins: [],
};
