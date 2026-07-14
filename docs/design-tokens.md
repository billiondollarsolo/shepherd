# Shepherd — Design Tokens (US-37 final polish pass)

> Authoritative design-token reference for the Shepherd web cockpit (`apps/web`).
> It documents the **as-built** system: the US-31 `flock-theme` color tokens
> (`apps/web/src/theme/tokens.ts` ⇄ `apps/web/src/styles/theme.css`) plus the
> US-37 **polish layer** (`apps/web/src/styles/polish.css`, mirrored in
> `tokens.ts`). All tokens use the `--flock-*` CSS-custom-property namespace and
> are exposed through Tailwind (`apps/web/tailwind.config.cjs`).
>
> The token set matches the spec's **Appendix A.3** required `flock-theme` shape
> — `surface.{0,1,2}`, `accent`, `ink.{primary,muted}`,
> `status.{starting,running,awaiting,idle,done,error,disconnected}`,
> `diff.{add,remove,context}`, `font.ui`, `font.code` — light + dark
> first-class, auto-following OS preference. Codex _structure, terminology and
> keybindings_ (Appendix A) are preserved; the _look and feel_ is a distinctive
> **Shepherd** identity (the flock-of-agents metaphor).

---

## 1. Design intent

Shepherd supervises a _flock_ of CLI coding agents. The interface is a calm control
tower: dense information, low chrome, one confident accent — feeling like the
Codex desktop app (same spatial model, calm density, supervision-first emphasis,
spec §12.3 / Appendix A.4) while reading as unmistakably Shepherd and avoiding the
generic AI gradient-and-glass look.

Five rules drive every token (operationalizing Appendix A.4 "calm density"):

1. **One accent, used sparingly.** A single confident blue (`accent`) marks the
   active session, primary actions, links, and focus. It is never used for body
   text or large fills. (`running` shares the accent so a working agent reads as
   the live focus.)
2. **Quiet surfaces.** Near-monochrome backgrounds in small steps
   (`surface.0/1/2`); elevation is carried by 1px hairline borders, not drop
   shadows. Shadows exist only for true overlays (menus, modals).
3. **Status is small and colored.** Agent state is an 8px indicator dot (the
   "bird") driven from `status.*`, never a whole-row recolor (Appendix A.4:
   "small colored indicators, not loud badges"). This is the single most
   Codex-like element (FR-UI3).
4. **Deliberate type scale.** A 1.20 minor-third modular scale on one UI sans
   (`font.ui`) and one mono (`font.code`); no more than two weights per view.
5. **Tasteful micro-motion.** 120–240ms eased transitions; one signature motion:
   a slow ring pulse on the indicator of the agent that needs you. Motion
   collapses under `prefers-reduced-motion`.

Legible in light + dark (FR-UI2); both auto-follow the OS, with the user's
explicit choice persisted (US-31).

---

## 2. Namespacing & theming mechanism

- All tokens are `--flock-*` CSS custom properties.
- **Per-theme color tokens** (US-31) live in `apps/web/src/styles/theme.css`,
  mirrored 1:1 from `apps/web/src/theme/tokens.ts` (guarded by
  `theme.contract.test.ts`). Resolution:
  1. `:root` carries **light** as baseline.
  2. `@media (prefers-color-scheme: dark) :root:not([data-theme])` gives correct
     **dark** first paint with no JS / no flash when the user hasn't chosen.
  3. Explicit `:root[data-theme="light"|"dark"]` (set by `ThemeProvider`) wins,
     so a persisted choice always takes precedence. `color-scheme` is set so
     native controls/scrollbars follow.
- **Theme-independent polish tokens** (US-37; type/space/radius/layout/elevation/
  motion) live once on `:root` in `apps/web/src/styles/polish.css` (imported from
  `index.css` right after `theme.css`), mirrored as name-lists in `tokens.ts`
  (guarded by `polish.test.ts`).
- Tailwind (`tailwind.config.cjs`) binds utilities to these vars so utility
  classes and raw CSS never drift.

---

## 3. Color (per-theme, `--flock-*` in theme.css)

### 3.1 Accent (single confident accent)

| flock-theme | flat             | Light     | Dark      |
| ----------- | ---------------- | --------- | --------- |
| `accent`    | `--flock-accent` | `#2563eb` | `#3b82f6` |

Tailwind: `text-flock-accent`, `bg-flock-accent`, plus `border-accent` and the
`:focus-visible` outline (US-37) all reference `--flock-accent`.

### 3.2 Surfaces (quiet)

| flock-theme | flat                | Light     | Dark      |
| ----------- | ------------------- | --------- | --------- |
| `surface.0` | `--flock-surface-0` | `#ffffff` | `#0f1115` |
| `surface.1` | `--flock-surface-1` | `#f5f6f8` | `#171a21` |
| `surface.2` | `--flock-surface-2` | `#eaecf0` | `#21262f` |

Legacy aliases mapped in `index.css`: `--flock-bg`→surface-0,
`--flock-surface`→surface-1, `--flock-fg`→ink-primary, `--flock-muted`→ink-muted.

### 3.3 Ink (text)

| flock-theme   | flat                  | Light     | Dark      |
| ------------- | --------------------- | --------- | --------- |
| `ink.primary` | `--flock-ink-primary` | `#1c2024` | `#e6e8eb` |
| `ink.muted`   | `--flock-ink-muted`   | `#5b6470` | `#9aa3af` |

### 3.4 Status palette (`status.*` — the only warm/alert hues)

Keys mirror the shared `StatusEnum` (spec §7;
`packages/shared/src/status.ts`). Appendix A.3 abbreviates `awaiting_input` as
`awaiting`; both names resolve to the same color, and `statusCssVar()` maps the
`StatusEnum` value `awaiting_input` → `--flock-status-awaiting`. These drive the
8px dot/ring (FR-ST6, FR-UI3); never whole-row fills.

| StatusEnum       | flat                          | Light     | Dark      | Sidebar (§7)        |
| ---------------- | ----------------------------- | --------- | --------- | ------------------- |
| `starting`       | `--flock-status-starting`     | `#64748b` | `#94a3b8` | no                  |
| `running`        | `--flock-status-running`      | `#2563eb` | `#3b82f6` | no (= accent)       |
| `awaiting_input` | `--flock-status-awaiting`     | `#d97706` | `#f59e0b` | **ring + pulse**    |
| `idle`           | `--flock-status-idle`         | `#16a34a` | `#22c55e` | gentle (dimmed) dot |
| `done`           | `--flock-status-done`         | `#0d9488` | `#2dd4bf` | no ring             |
| `error`          | `--flock-status-error`        | `#dc2626` | `#ef4444` | **ring**            |
| `disconnected`   | `--flock-status-disconnected` | `#9aa3af` | `#6b7280` | stale (dimmed) dot  |

Tailwind: `bg-status-<state>` / `ring-status-<state>` (the `StatusIndicator`
component uses these). `awaiting_input` is the money state (spec §7) — it rings
_and_ emits the signature pulse so the "which agent needs me" scan is instant.

> Invariant (enforced): `StatusIndicator.test.tsx` renders a dot for every
> `STATUS_VALUES` member and asserts ring behavior matches the shared
> `ringsSidebar()` policy; `tokens.test.ts` asserts a color for every status.

### 3.5 Diff line tints (read-only Diff tab, US-33)

| flock-theme    | flat                   | Light     | Dark      |
| -------------- | ---------------------- | --------- | --------- |
| `diff.add`     | `--flock-diff-add`     | `#e6f4ea` | `#0e2a16` |
| `diff.remove`  | `--flock-diff-remove`  | `#fce8e6` | `#3a1414` |
| `diff.context` | `--flock-diff-context` | `#f5f6f8` | `#171a21` |

### 3.6 Borders (US-37, derived; theme-independent formula)

| flat                    | Value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| `--flock-border`        | `color-mix(in srgb, var(--flock-ink-primary) 12%, transparent)` |
| `--flock-border-strong` | `color-mix(in srgb, var(--flock-ink-primary) 22%, transparent)` |
| `--flock-accent-soft`   | `color-mix(in srgb, var(--flock-accent) 14%, transparent)`      |

Tailwind: `border` (DEFAULT), `border-strong`, `border-accent`.

---

## 4. Typography

### 4.1 Families

| flock-theme | flat                | Stack                                                                                        |
| ----------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `font.ui`   | `--flock-font-ui`   | `"Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` |
| `font.code` | `--flock-font-code` | `"JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace`      |

Tailwind `font-sans` → ui, `font-mono` → code. `font.code` is used for the
terminal, the Diff tab, session ids/tokens, kbd chips, and tabular numerics
(`code`/`pre` get `font-variant-numeric: tabular-nums`, US-37).

### 4.2 Type scale (US-37; 1.20 minor third, 14px base)

| flat (size / leading)                      | Size | Line-height | Tailwind         |
| ------------------------------------------ | ---- | ----------- | ---------------- |
| `--flock-text-3xs` / `--flock-leading-3xs` | 10px | 14px        | `text-3xs`       |
| `--flock-text-2xs` / `--flock-leading-2xs` | 11px | 16px        | `text-2xs`       |
| `--flock-text-xs` / `--flock-leading-xs`   | 12px | 18px        | `text-xs`        |
| `--flock-text-sm` / `--flock-leading-sm`   | 13px | 20px        | `text-sm`        |
| `--flock-text-md` / `--flock-leading-md`   | 14px | 22px        | `text-md` (body) |
| `--flock-text-lg` / `--flock-leading-lg`   | 17px | 26px        | `text-lg`        |
| `--flock-text-xl` / `--flock-leading-xl`   | 20px | 30px        | `text-xl`        |
| `--flock-text-2xl` / `--flock-leading-2xl` | 24px | 34px        | `text-2xl`       |

### 4.3 Weights & tracking (US-37)

| flat                      | Value   | Tailwind                            |
| ------------------------- | ------- | ----------------------------------- |
| `--flock-weight-regular`  | 400     | `font-regular`                      |
| `--flock-weight-medium`   | 500     | `font-medium`                       |
| `--flock-weight-semibold` | 600     | `font-semibold`                     |
| `--flock-tracking-label`  | 0.06em  | `tracking-label` (all-caps labels)  |
| `--flock-tracking-tight`  | -0.01em | `tracking-tight` (>= 20px headings) |

---

## 5. Space, radius, layout (US-37)

### 5.1 Spacing (4px base)

`--flock-space-0..8` = `0, 2, 4, 8, 12, 16, 24, 32, 48`px. Tailwind `p-1..8`,
`gap-1..8`, etc. map onto these.

### 5.2 Radius

| flat                  | px  | Tailwind                             |
| --------------------- | --- | ------------------------------------ |
| `--flock-radius-xs`   | 3   | `rounded-xs` (badges, kbd, chips)    |
| `--flock-radius-sm`   | 6   | `rounded-sm` (buttons, inputs, rows) |
| `--flock-radius-md`   | 10  | `rounded-md` (panels, cards, tabs)   |
| `--flock-radius-lg`   | 14  | `rounded-lg` (modals, palette)       |
| `--flock-radius-full` | 999 | `rounded-full` (the status dot)      |

### 5.3 Layout sizing (Codex three-region, FR-UI1)

| flat                  | Value  | Tailwind            |
| --------------------- | ------ | ------------------- |
| `--flock-sidebar-w`   | 264px  | `w-sidebar`         |
| `--flock-rail-w`      | 48px   | `w-rail`            |
| `--flock-activity-w`  | 320px  | `w-activity`        |
| `--flock-topbar-h`    | 44px   | `h-topbar`          |
| `--flock-drawer-h`    | 260px  | `h-drawer`          |
| `--flock-row-h`       | 36px   | `h-row`             |
| `--flock-tab-h`       | 38px   | `h-tab`             |
| `--flock-indicator`   | 8px    | status dot diameter |
| `--flock-max-content` | 1440px | max centered width  |

---

## 6. Elevation (US-37)

| flat                     | Light                                                                | Dark                                                          | Tailwind         |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------- |
| `--flock-shadow-none`    | none                                                                 | none                                                          | —                |
| `--flock-shadow-overlay` | `0 6px 24px -8px rgb(16 24 32 / .18), 0 1px 2px rgb(16 24 32 / .10)` | `0 8px 28px -10px rgb(0 0 0 / .6), 0 1px 2px rgb(0 0 0 / .5)` | `shadow-overlay` |
| `--flock-shadow-focus`   | `0 0 0 2px var(--flock-surface-0), 0 0 0 4px var(--flock-accent)`    | same pattern                                                  | `shadow-focus`   |

Panels/cards use `border` + `surface.1`, **not** shadow. Shadows only for true
overlays.

---

## 7. Motion (US-37 — tasteful micro-motion)

| flat                    | Value                    | Tailwind           |
| ----------------------- | ------------------------ | ------------------ |
| `--flock-ease-standard` | `cubic-bezier(.2,0,0,1)` | `ease-standard`    |
| `--flock-ease-out`      | `cubic-bezier(0,0,.2,1)` | `ease-flock-out`   |
| `--flock-ease-in`       | `cubic-bezier(.4,0,1,1)` | `ease-flock-in`    |
| `--flock-dur-fast`      | 120ms                    | `duration-fast`    |
| `--flock-dur-base`      | 180ms                    | `duration-base`    |
| `--flock-dur-slow`      | 240ms                    | `duration-slow`    |
| `--flock-pulse-dur`     | 2000ms                   | (drives the pulse) |

**Signature motion — the live pulse.** The status indicator of a session that
needs you (`awaiting_input`; `error` also rings) emits a slow 2s ease ring pulse
(`@keyframes flock-pulse` in `polish.css`; Tailwind `animate-flock-pulse`). It is
applied to `[data-rings='true']` — which `StatusIndicator` sets exactly for
`awaiting_input`/`error` via the shared `ringsSidebar()` policy — so the eye is
drawn to the agent that needs the user (spec §7, FR-UI3). The pulse color comes
from `--flock-indicator-color` (the per-status var), with `currentColor`
fallback.

**Reduced motion.** `@media (prefers-reduced-motion: reduce)` collapses all
animations + transitions to ~0ms.

---

## 8. Status indicator ("the bird")

`polish.css` `.flock-status-indicator` renders a visible dot sized from
`--flock-indicator-size` (default `--flock-indicator` = 8px), colored from
`--flock-indicator-color` (default `--flock-status-idle`), `rounded-full`, with a
fast color transition. The React `StatusIndicator`
(`apps/web/src/features/tree/StatusIndicator.tsx`) drives color via Tailwind
`bg-status-*`, dims `idle`/`disconnected`, adds `ring-2 ring-status-*` +
`data-rings='true'` for `awaiting_input`/`error` (which triggers the pulse), and
exposes an accessible label per status.

---

## 9. Mapping to Codex / Appendix A (restyle, do not rename)

These tokens re-skin the Codex skeleton without changing its layout contract or
its words:

- **Left tree (node → project → session)** — `w-sidebar`, `h-row`, the 8px
  `bg-status-*` dot per row, `--flock-accent-soft` + `border-accent` for the
  selected/active row; `awaiting_input`/`error` ring (and `awaiting_input`
  pulses) and sort to the top via the shared attention ordering (FR-UI3).
- **Keybinding hints** (`Cmd+K`, `Cmd+J`, `Ctrl+L`) — `.flock-kbd` chip:
  `font.code` at `text-2xs`, `rounded-xs`, `surface.2` bg, 1px border. Do not
  rename Codex keybindings (Appendix A.2).
- **Center tabs** Terminal | Preview | Diff — `h-tab`, `rounded-md`, accent on
  the active tab; terminal + diff use `font.code` at `text-sm`, tabular nums;
  diff uses `--flock-diff-*`.
- **Right activity sidebar** — `w-activity`, `surface.1`, status-timeline dots
  from `--flock-status-*`.
- **Bottom shell drawer** — `h-drawer`. **Primary actions** use the accent
  button; everything else is a neutral ghost/secondary.

---

## 10. Token quick-reference (flat `--flock-*` list)

```
color   : --flock-accent  --flock-surface-0/1/2  --flock-ink-primary
          --flock-ink-muted  --flock-status-{starting,running,awaiting,idle,
          done,error,disconnected}  --flock-diff-{add,remove,context}
          --flock-font-ui  --flock-font-code
          (legacy: --flock-bg --flock-surface --flock-fg --flock-muted
           --flock-attention --flock-error)
border  : --flock-border  --flock-border-strong  --flock-accent-soft
type    : --flock-text-{3xs,2xs,xs,sm,md,lg,xl,2xl}
          --flock-leading-{3xs,2xs,xs,sm,md,lg,xl,2xl}
weight  : --flock-weight-{regular,medium,semibold}
          --flock-tracking-{label,tight}
space   : --flock-space-0 .. --flock-space-8
radius  : --flock-radius-{xs,sm,md,lg,full}
layout  : --flock-sidebar-w --flock-rail-w --flock-activity-w --flock-topbar-h
          --flock-drawer-h --flock-row-h --flock-tab-h --flock-indicator
          --flock-max-content
shadow  : --flock-shadow-none --flock-shadow-overlay --flock-shadow-focus
motion  : --flock-ease-standard --flock-ease-out --flock-ease-in
          --flock-dur-fast --flock-dur-base --flock-dur-slow --flock-pulse-dur
indicator: --flock-indicator-size  --flock-indicator-color  (caller-supplied)
```

---

## 11. Files & tests

- `apps/web/src/styles/theme.css` — per-theme color tokens (US-31; do not break).
- `apps/web/src/styles/polish.css` — US-37 polish layer (this pass).
- `apps/web/src/theme/tokens.ts` — color tokens + US-37 name-lists
  (`TYPE_SCALE`, `TYPE_TOKENS`, `WEIGHT_TOKENS`, `SPACE_TOKENS`, `RADIUS_TOKENS`,
  `ELEVATION_TOKENS`, `MOTION_TOKENS`, `POLISH_TOKENS`, `ALL_POLISH_TOKENS`).
- `apps/web/tailwind.config.cjs` — utility bindings to the `--flock-*` vars.
- `apps/web/src/index.css` — imports theme.css then polish.css; base type,
  single-accent `:focus-visible`, tabular nums.
- Tests (all green in Docker): `theme.contract.test.ts` (US-31, unchanged),
  `tokens.test.ts` (US-31, unchanged), `polish.test.ts` (US-37, new),
  `StatusIndicator.test.tsx` (unchanged). Full `apps/web` unit suite: 248 passed.

### Verification (Docker, host has only Docker)

```
docker compose -f docker-compose.dev.yml run --rm web sh -c \
  "pnpm --filter @flock/web exec vitest run"   # 43 files, 248 tests pass
docker compose -f docker-compose.dev.yml run --rm web sh -c \
  "pnpm --filter @flock/web typecheck"          # pass
docker compose -f docker-compose.dev.yml run --rm web sh -c \
  "pnpm --filter @flock/web build"              # built; CSS emits --flock-* + flock-pulse
```
