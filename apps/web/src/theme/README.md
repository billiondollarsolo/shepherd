# flock-theme (US-31)

Light + dark first-class themes driven by the JSON-style **flock-theme** token set
from spec Appendix A.3.

## Files

- `tokens.ts` — the single source of truth for the token set
  (`surface.{0,1,2}`, `accent`, `ink.{primary,muted}`,
  `status.{starting,running,awaiting,idle,done,error,disconnected}`,
  `diff.{add,remove,context}`, `font.ui`, `font.code`). Status keys mirror the
  shared `StatusEnum`; `awaiting` is the Appendix A.3 alias of `awaiting_input`.
- `../styles/theme.css` — the runtime `--flock-*` CSS custom properties,
  mirrored 1:1 from `tokens.ts`. `theme.contract.test.ts` parses this file and
  fails if it drifts from `tokens.ts`.
- `ThemeProvider.tsx` — OS auto-detect on first load, persisted explicit choice
  (localStorage key `flock.theme`), live OS-follow in `system` mode, writes
  `data-theme` on `<html>`.
- `useTheme.ts` — `useTheme()` hook (`{ mode, resolvedTheme, setMode, toggleTheme }`).
- `ThemeToggle.tsx` — accessible light/dark toggle (`data-testid="theme-toggle"`).
- `index.ts` — barrel re-exporting the public API.

`src/index.css` `@import`s `./styles/theme.css` (before the `@tailwind`
directives) and maps compact semantic `--flock-bg`/`-surface`/`-fg`/`-muted`/
`-attention`/`-error` utilities onto the first-class tokens, so active
components theme automatically. `tailwind.config.cjs` exposes the tokens as
utility colours (`bg-flock-surface-1`, `text-flock-ink-primary`,
`bg-status-awaiting`, `ring-status-error`, …) and binds `font-sans`/`font-mono`
to `--flock-font-ui`/`--flock-font-code`.

## Resolution model

1. `:root` carries **light** tokens (baseline).
2. `@media (prefers-color-scheme: dark) :root:not([data-theme])` gives correct
   **dark** first paint with no JS and no flash, when the user has made no choice.
3. Explicit `[data-theme="light"|"dark"]` (set by `ThemeProvider` from
   `setMode`/`toggleTheme`) overrides the media query so a persisted choice always
   wins. `mode === 'system'` clears the stored key and live-follows the OS.

## Wiring (already done in `src/main.tsx`)

`main.tsx` wraps `<App />` in `<ThemeProvider>` and renders a fixed `<ThemeToggle />`
(bottom-right). To relocate the toggle into the chrome, move the `<ThemeToggle />`
into the relevant component (it must remain inside the provider tree).

Sidebar dots: either use the existing `StatusIndicator` (Tailwind `bg-status-*` /
`ring-status-*`, now backed by these tokens) or, for plain markup, render
`<span className="flock-status-dot" data-status={session.status} />` — colours come
from `--flock-status-*` automatically (use `statusCssVar(status)` for inline use).

## Tests

- Unit (vitest, jsdom): `tokens.test.ts`, `theme.contract.test.ts`,
  `ThemeProvider.test.tsx` — run with `pnpm --filter @flock/web test:unit`.
- E2E (Playwright, both themes): `apps/web/e2e/theme.spec.ts` — run with the
  repo's `test:e2e`.
