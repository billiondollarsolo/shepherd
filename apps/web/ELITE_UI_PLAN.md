# Shepherd Web — Elite UI/UX Refinement Plan

> **Status:** Proposed · **Scope:** `apps/web` · **Authored:** 2026-07-15
> **Method:** Multi-agent deep-dive audit (10 parallel surface auditors → per-finding
> adversarial verification → synthesis). 105 findings, individually verified against source.
> Severity mix: 1 foundational · 8 high · 63 medium · 33 low.

---

## Context

Shepherd (internal id `flock`) is a supervision console for CLI coding agents:
**nodes → projects → multi-agent "Pens" → live terminals, diffs, and chat.** Operators
stare at it all day to answer one question fast: *which agent needs me right now?*

The design foundation is already **genuinely strong** — this is not a rescue job. There is a
clean, test-guarded token system (`tokens.ts` ↔ `theme.css`, 1:1, asserted by
`theme.contract.test.ts`), a disciplined true-black→graphite dark ramp with hairline-first
hierarchy, a deliberate type/space/radius/motion polish layer (`polish.css`), Radix-based
primitives that route through `--flock-*` vars, and **near-zero hardcoded colors** in feature
code. The auditors repeatedly called individual subsystems "elite-grade" (the keep-alive
terminals, the focus-restore in `PaddockDialogs.tsx`, the two-pane brand moment in
`AuthScreen.tsx`, the IntersectionObserver-synced grid tabs).

So why this plan? Because **the most damaging gaps are places where the beautiful foundation is
defined but never reaches the pixels**, and because a handful of surfaces improvised their own
edges instead of extending the core. Two examples set the tone:

- The **signature "which agent needs me" pulse** (`flock-pulse`, a calm expanding ring, authored
  in `polish.css` + `tailwind.config.cjs`) is bypassed by the hero `StatusIndicator`, which ships
  a generic Tailwind opacity blink and never sets its hue variable.
- **Every Radix overlay's enter/exit animation is a silent no-op** — the `animate-in` / `fade-in-0`
  / `zoom-in-95` classes on Dialog, Popover, Select, DropdownMenu, and Tooltip come from
  `tailwindcss-animate`, which is **neither installed nor registered** (`plugins: []`). Overlays
  snap open with zero motion while the meticulously authored `--flock-dur-*` / `--flock-ease-*`
  tokens go unused on entrance.

**Intended outcome:** one intentional system. A single motion vocabulary where every overlay
breathes on the `--flock-*` easings; a complete token graph with zero hardcodes and zero
`[var(--flock-*)]` escape hatches; a primitive library deep enough that no feature hand-rolls a
busy button, a checkbox, an empty state, or a resize handle; a review loop (diff/editor/terminal)
that is legible and theme-aware; a shell that resolves into one continuously-ruled grid; and —
above all — **the attention signal surfacing consistently on every supervision surface**, from a
collapsed sidebar branch to a fleet card to a grid tab to the phone. Bold, opinionated refinement,
but **every addition extends `tokens.ts` / `theme.css` / `polish.css` rather than working around
them.** This is greenfield — we take the elite move, not the safe one.

---

## The Six Governing Themes

Everything below organizes under six cross-cutting themes. Phases are ordered so foundational
token/motion/primitive work lands first and unlocks the surface polish that depends on it.

1. **Wire the motion that's already designed.** The signature pulse and every overlay
   enter/exit are dead no-ops. Fixing them lifts polish across every surface at once.
2. **Complete the token graph — no hardcodes, no escape hatches.** Several first-class tokens are
   never bound as utilities (forcing `[var(--flock-*)]` arbitrary values); there is no
   semantic-intent family, scrim, elevation ramp, ring-highlight, terminal/ANSI, or diff-foreground
   layer, so features reach for `text-white`, `bg-black/55`, `#090909`, and dead diff classes.
3. **Fill the primitive gaps so features stop reinventing.** The library stops before the
   structural pieces the app clearly uses — Tabs, Checkbox, RadioGroup, Skeleton, Kbd, EmptyState,
   Card, ToggleChip, Spinner, a validation-capable field, a standardized resize separator. 30+
   call-sites hand-roll busy buttons and ad-hoc chips.
4. **Make attention unmissable everywhere.** The core promise only half-lands: collapsed branches,
   fleet cards, grid error panes, and the phone all under-signal `awaiting_input`/`error`. The
   `ordering.ts` helpers built for exactly this are imported only by tests.
5. **Repair the review loop and code surfaces.** The diff viewer renders monochrome (its color
   classes resolve to nothing), `CodeEditor` is permanently dark in light mode, terminals hardcode
   an entire ANSI palette, scrollbars are unthemed.
6. **One spatial system and keyboard-first ergonomics.** The shell reads as bolted-together panes:
   two competing hairline systems, ignored height tokens, doubled breadcrumbs, keyboard-inoperable
   resize handles, and a tree with no ARIA semantics.

### Guiding principles (non-negotiable)

- **Extend the token layer; never hardcode.** New color/scale needs land in `tokens.ts` +
  `theme.css` (per-theme) or `polish.css` (theme-independent), then bind as a Tailwind utility.
- **Borders carry elevation; shadows are for overlays.** Respect the existing philosophy — prefer
  *neutralizing* the vestigial invisible `shadow-sm` on raised controls over introducing a
  competing shadow-based model. Reserve the new elevation ramp for layer-differentiated overlay depth.
- **Reduced-motion is a first-class state.** Every new animation must collapse to a static,
  still-legible state under `prefers-reduced-motion` (the attention *ring* persists even when the
  *pulse* stops).
- **AA+ or it doesn't ship.** Every new intent/foreground pair and diff foreground is contrast-checked.

---

## Phase 1 — Token completion & motion wiring

**Goal:** Make the designed-but-unwired foundation reach the pixels, and give every later surface
clean, hardcode-free utilities to build on. *This is the unlock phase — do it first.*

| # | Task | Effort | Files |
|---|------|--------|-------|
| 1.1 | **Hand-author overlay enter/exit keyframes** in `polish.css`, bound to `--flock-dur-base` + `--flock-ease-standard`; register in `tailwind.config.cjs` and route Dialog/Popover/Select/DropdownMenu/Tooltip through **one shared motion recipe** with a subtle directional slide. Confirm the `prefers-reduced-motion` block collapses them. *Prefer hand-authoring over the `tailwindcss-animate` plugin — its default timings ignore the `--flock-*` tokens and reintroduce the drift the system was built to avoid.* | M | `styles/polish.css`, `tailwind.config.cjs`, `components/ui/{dialog,popover,select,dropdown-menu,tooltip}.tsx` |
| 1.2 | **Bind the missing utilities** — `backgroundColor`: `flock-hover`→`--flock-surface-hover`, `flock-accent-soft`, `flock-accent-hover`, `flock-scrim`; then sweep button/input/select/badge/sonner off the `[var(--flock-*)]` arbitrary-value pattern onto clean utilities. | M | `tailwind.config.cjs`, `components/ui/{button,input,select,badge,sonner}.tsx` |
| 1.3 | **Add the missing token families:** semantic-intent `--flock-intent-{success,warning,danger,info}` + AA-verified `-foreground`s (distinct from agent-status hues); `--flock-scrim` (+ optional `--flock-scrim-blur`); an elevation ramp `--flock-shadow-{sm,md,lg}` with a per-theme dark override (depth + hairline, **not** 5% black); `--flock-ring-highlight` (replaces the 4× hardcoded `ring-white/[0.03]`); and a `--flock-focus-ring` whose inner-gap var defaults to `surface-0` but is overridable on elevated containers. Bind each as bg/text/ring/shadow utilities. | L | `theme/tokens.ts`, `styles/theme.css`, `styles/polish.css`, `tailwind.config.cjs` |
| 1.4 | **Add terminal + diff token families:** `--flock-term-*` (bg/fg/cursor/selection/ansi-0..15, `term-bg` = `surface-0`), `--flock-diff-add-fg` / `--flock-diff-remove-fg` saturated foregrounds, and a `diff` color key so `text-diff-add`/`text-diff-remove` actually resolve. Register in the contract/`ALL_POLISH_TOKENS` lists. | M | `theme/tokens.ts`, `styles/theme.css`, `tailwind.config.cjs` |
| 1.5 | **Resolve the single-accent collision:** interaction accent and `running` status are both blue, so in a dense grid selection/focus can't be told apart from running state. Either shift `running` off blue to a distinct calm hue (cyan/indigo) **or** change the selected-row treatment to a neutral surface-step + left accent bar. Document the rule in `tokens.ts`. | M | `theme/tokens.ts`, `styles/theme.css`, `styles/polish.css` |
| 1.6 | **Reconcile `TYPE_SCALE`** in `tokens.ts` (and its "1.20 ratio" comment) to the *shipped* `polish.css` values (11/12/13/14/15/17/20/24, not the declared 10/11/12/13/14/16/19/24), and extend the polish contract test to assert **value parity**, not just token-name presence. | S | `theme/tokens.ts`, `styles/polish.css`, `theme/polish.test.ts` |

**Validation:** Run `theme.contract` + `polish` tests (now with value-parity assertions);
contrast-check every new intent/foreground pair and the diff foregrounds at **WCAG AA** on their
fills (`surface-0` and tint backgrounds); grep for zero remaining `bg-[#...]` / `text-white` /
`ring-white/[0.03]`; visual review that all five overlays animate on open/close and collapse under
`prefers-reduced-motion`.

---

## Phase 2 — Primitive library completion

**Goal:** Ship the missing enterprise primitives and validation-capable fields so features stop
hand-rolling — all bound to the Phase 1 tokens.

| # | Task | Effort | Files |
|---|------|--------|-------|
| 2.1 | **Spinner primitive** (Loader2 wrapper, size-follows-text, `text-current`, reduced-motion aware) + **`Button` `loading?`/`loadingText` + `aria-busy`** (swap opacity, not layout). Migrate the ~6 hand-rolled busy submit call-sites; standardize dialog submit spinners. | M | `components/ui/button.tsx`, `paddock/dialogs/AddSessionDialog.tsx`, `paddock/PathBrowser.tsx` |
| 2.2 | **Add token-bound primitives:** Tabs (Radix, underline-active with `border-flock-accent`, `h-tab` — retires the orphaned `--flock-tab-h`), Checkbox + RadioGroup (mirror `Switch`'s `data-[state=checked]:bg-flock-accent` + `shadow-focus`), Skeleton (`bg-flock-surface-2`, reduced-motion shimmer), canonical **Kbd** (TopBar chip treatment — kills two divergent inline `<kbd>` styles), **EmptyState** (icon tile + `font-display` title + muted body + optional action), **Card**/CardHeader (wraps the `rounded-lg border bg-flock-surface-1` pattern in 15 files), **ToggleChip** (cva, `selected` + size — kills 3 divergent chip idioms). | L | `components/ui/index.ts`, `components/ui/switch.tsx`, `app/CommandPalette.tsx`, `paddock/TopBar.tsx` |
| 2.3 | **Real field validation:** give Input/Textarea an invalid state (`aria-invalid:border-status-error` + tokenized `--flock-shadow-error` mirroring `shadow-focus`); add FormField/FormLabel/FormMessage wiring `aria-describedby`; extend **`DialogField`** with `hint?`/`error?`/`required?`, generated ids, `aria-describedby` + `aria-invalid` passthrough, an inline `role=alert` error line, a required affordance, and a `FieldGroup` variant emitting `aria-labelledby`. | M | `components/ui/input.tsx`, `components/ui/label.tsx`, `paddock/dialogs/DialogField.tsx` |
| 2.4 | **Round out overlay/display primitives:** replace `text-white` with the intent-foreground token (button `destructive`, sonner); add Toaster per-type status classNames + closeButton; give Badge a `size` + leading dot + removable Chip variant; export DialogTrigger/Close/Portal/Overlay; add SelectGroup/Label/Separator + scroll buttons; render both scrollbar orientations in ScrollArea; add an optional TooltipArrow. | M | `components/ui/{sonner,badge,dialog,select,scroll-area}.tsx`, `components/ui/index.ts` |
| 2.5 | **One standardized resize-separator primitive:** ≥8px hit target with a centered 1px rule (`bg-flock-border` `hover:bg-flock-accent/70`), pointer events for touch parity, `onKeyDown` arrow-stepping announced via `aria-valuenow`, double-click-to-reset. Add a `--flock-touch` (44px) token with `min-h-touch`/`min-w-touch`. Reuse for the right panel, split gutters, and a new resizable drawer top gutter. *(Fixes WCAG 2.1.1 / 2.5.8 on three mouse-only resize idioms.)* | M | `paddock/SessionPane.tsx`, `shell/ProjectLayoutView.tsx`, `app/AppShell.tsx`, `tailwind.config.cjs` |

**Validation:** Unit tests per new primitive (render + a11y roles); keyboard tests for
Checkbox/RadioGroup toggling and separator arrow-stepping/reset; Playwright e2e asserting Button
loading disables + sets `aria-busy` and overlays animate; contrast check on Toaster status tints and
the invalid-state ring; visual review that the three chip/kbd idioms are gone.

---

## Phase 3 — The attention system: "which agent needs me"

**Goal:** Surface the signature `flock-pulse` and attention ordering **consistently on every
supervision surface**, with a reduced-motion static fallback. *This is the single highest-leverage
theme — it is the product's core promise.*

| # | Task | Effort | Files |
|---|------|--------|-------|
| 3.1 | **Fix the hero indicator:** switch `StatusIndicator` from `animate-pulse` to `animate-flock-pulse` and set `--flock-indicator-color` from the status var (mirroring `StatusDot`). Make **error** pulse where `ringsSidebar` policy says it should, so `awaiting_input` and `error` read **identically** across tree `SessionRow`, the needs-you list, and the rail. **Do NOT delete `StatusIndicator` or the `[data-rings]` rule** — both are live and test-guarded. | S | `tree/StatusIndicator.tsx`, `paddock/SidebarTree.tsx`, `components/StatusDot.tsx` |
| 3.2 | **Branch-level attention** using the unused `ordering.ts` helpers: on collapsed NodeRow/ProjectRow headers render a pulsing `StatusDot` when `groupNeedsAttention` is true; sort projects within a node via `sortGroupsByAttention` (keep manual node order, overlay a header attention dot); add a per-node "N need you" rollup and a count badge on the "Needs you" header. | M | `paddock/SidebarTree.tsx`, `tree/ordering.ts`, `paddock/Sidebar.tsx` |
| 3.3 | **Keyboard/touch-reachable row actions:** add `focus-visible:opacity-100` / `group-focus-within` to the 6 hover-only Terminate/New-session/Node-info/New-project buttons (a **destructive control currently invisible under keyboard focus** — WCAG 2.4.7); give them a low resting opacity for touch discoverability; mirror the `SessionRow` selected treatment (`bg-flock-accent/12` + left accent bar) on the scoped ProjectRow. | S | `paddock/SidebarTree.tsx`, `store/paddock.ts` |
| 3.4 | **Attention on the fleet grid views:** FleetView cards ring + `animate-flock-pulse` when a node holds `awaiting_input`/`error`, tint awaiting/error pills with their status token, sort attention nodes to top, add a rollup badge. GridView: treat error as attention (`ringsSidebar`), key the ring color off status (+ `--flock-indicator-color`), pass pulse to the tab-strip `StatusDot`. Ring the blocked/errored racer in CompareView. **Demote CPU/mem/disk bars off the accent color** to neutral (`bg-flock-ink-muted/50`) so telemetry stops out-shouting status. | M | `overview/FleetView.tsx`, `paddock/GridView.tsx`, `overview/CompareView.tsx` |

**Validation:** Playwright e2e driving sessions into `awaiting_input`/`error` and asserting
ring/pulse/rollup on collapsed sidebar branches, fleet cards, grid cells + tabs, and racer columns;
reduced-motion snapshot confirming the static ring persists; keyboard walk confirming action buttons
become visible on focus; visual review that error and awaiting read identically everywhere.

---

## Phase 4 — Review loop: diff, editor & terminal

**Goal:** Take the code-review surfaces to elite legibility and full theme-awareness using the
Phase 1 term/diff tokens. *The review loop is arguably the whole point of a supervision console and
is currently the weakest surface.*

| # | Task | Effort | Files |
|---|------|--------|-------|
| 4.1 | **Fix the diff viewer** (renders monochrome today — its color classes resolve to nothing): switch both `LINE_CLASS` maps to line-level backgrounds (`bg-flock-diff-add/remove`) with a fixed-width sign/gutter column + line numbers, and `text-flock-diff-add/remove-fg` foregrounds; keep `text-flock-accent` hunk headers. Add a token/class test so the classes can't silently no-op again. Fix the dead `text-diff-add` in `ActivitySidebar`. | M | `center/DiffTab.tsx`, `center/SourceControlPanel.tsx`, `activity/ActivitySidebar.tsx` |
| 4.2 | **Theme-aware CodeEditor:** drive the CodeMirror theme from `useTheme().resolvedTheme` (light theme built from `--flock-*` tokens; `oneDark` only in dark), set the editor font via a theme extension to `var(--flock-font-code)`, align size to `text-xs/sm` so terminal, editor, and diff share one mono family/size. *(Today it's hardcoded dark → a dark island in white chrome.)* | M | `files/CodeEditor.tsx`, `files/FilesPanel.tsx` |
| 4.3 | **Tokenize the terminals:** build the xterm/ghostty `ITheme` from `--flock-term-*` via `getComputedStyle` across all three terminal components (**one shared source**, re-themes on toggle), set `term-bg` = `surface-0`, gate `cursorBlink` on `prefers-reduced-motion`, remove the redundant inline `color:'#c8ccd4'` override and the `bg-[#090909]`/`text-white` overlay literals. | M | `terminal/Terminal.tsx`, `terminal/GhosttyMobileTerminal.tsx`, `terminal/TerminalArea.tsx` |
| 4.4 | **Global themed scrollbar** (`scrollbar-width: thin`; `scrollbar-color` + `::-webkit-scrollbar` tinted with `--flock-surface-3`/`--flock-border`, hover → `--flock-border-strong`) in `index.css`, scoped to app surfaces and **excluding `.xterm`**. Fix `ShellDrawer.css` to use `--flock-border` for the header hairline (stop overloading the muted-text token). Migrate `AgentsSwitcher` off arbitrary `text-[15px]`/`[13px]` onto the named scale; reveal the drag grip on hover only. | M | `index.css`, `shell-drawer/ShellDrawer.css`, `shell/AgentsSwitcher.tsx` |

**Validation:** Light/dark visual review of diff (row tints + gutter), editor, and terminal; unit
test asserting diff add/remove classes resolve to real CSS; contrast check diff foregrounds on their
tint backgrounds; confirm terminal re-themes on toggle and cursor stops blinking under reduced-motion.
**Risk to watch:** read xterm `ITheme` *after* CSS load and re-run on theme toggle, or the palette
captures stale/empty values.

---

## Phase 5 — One spatial system: shell & composition

**Goal:** Resolve the shell into a single continuously-ruled grid governed by the layout tokens, with
calm density in the center column.

| # | Task | Effort | Files |
|---|------|--------|-------|
| 5.1 | **Unify hairlines + vocabulary:** replace `border-flock-muted/15` region seams with `border-[var(--flock-border)]` in `AppShell` (and the shell cohort — ActivitySidebar, RespondBar), and migrate shell container/regions off legacy aliases (`bg-flock-bg`/`flock-surface`/`flock-fg`) onto first-class `surface-*`/`ink-*` tokens; mark the aliases deprecated. | M | `app/AppShell.tsx`, `activity/ActivitySidebar.tsx`, `paddock/RespondBar.tsx` |
| 5.2 | **Make the height/size tokens authoritative:** set `--flock-topbar-h` to the real primary-bar height (48), add `--flock-subheader-h` (40), use `--flock-tab-h` (34) for tab rows; bind `h-topbar`/`h-subheader`/`h-tab` and apply per tier; bind AppShell's tree/activity columns to `--flock-sidebar-w`/`--flock-activity-w` instead of literal `minmax` ranges; standardize one shell gutter (`px-4`) across stacked center-column bars so content left edges share a gridline. | L | `styles/polish.css`, `tailwind.config.cjs`, `paddock/{TopBar,SessionPane,RightPanel}.tsx`, `app/AppShell.tsx` |
| 5.3 | **Collapse doubled center-column chrome into one command header:** dedupe the two breadcrumbs into TopBar + one optional context row; resolve the dead activity region (either route SessionPane's RightPanel through AppShell's `activity` slot **or** delete the 3-column branch + stale comment); inset the terminal stage as a subtly elevated card (`bg-flock-surface-0` + `rounded-lg` + border inside a `surface-1` frame); keep a persistent slim status strip in all chrome modes. | L | `app/Paddock.tsx`, `paddock/{SessionPane,TopBar,BottomBar}.tsx` |
| 5.4 | **Animate layout transitions:** give the shell drawer a height/opacity transition on `--flock-dur-base`/`--flock-ease-standard` (respecting reduced-motion); render `ConnectivityBanner` as an **absolute overlay toast** over the stage rather than an in-flow strip, so a network blip never reflows-and-refits the xterm terminals. | M | `app/AppShell.tsx`, `paddock/ConnectivityBanner.tsx` |

**Validation:** Visual review — one hairline weight across region seams and content chrome, aligned
left gridlines, consistent header rhythm; Playwright e2e opening/closing the drawer and toggling
connectivity to assert **no terminal refit/reflow** and animated transitions; verify column widths at
narrow + very wide viewports after switching `minmax`→token bindings.

---

## Phase 6 — Command palette, chat & keyboard

**Goal:** Bring the most-used overlays and the chat surface to the keyboard-first Linear/Codex bar.

| # | Task | Effort | Files |
|---|------|--------|-------|
| 6.1 | **Re-token CommandPalette** onto the mature ramp (`surface-1/2`, `ink-primary/muted`, `border-flock-border`, accent) — this is the last component on legacy flat tokens, and it also fixes the silently-dropped `text-flock-fg/90` opacity. Add an entrance transition (opacity + slight scale/translateY on `--flock-ease-out`) gated on reduced-motion. | M | `app/CommandPalette.tsx`, `tailwind.config.cjs`, `styles/polish.css` |
| 6.2 | **Upgrade the palette:** replace substring `filterCommands` with a pure **fuzzy subsequence scorer** returning match indices + ranking; render matched chars highlighted (mirror SearchPanel); group results by their existing hint category with uppercase section headers (keep arrow-nav flat); `scrollIntoView({block:'nearest'})` the active option; add an optional per-Command icon; show an MRU "Recent" group on empty query. | L | `app/commands.ts`, `app/CommandPalette.tsx`, `paddock/usePaddockCommands.tsx` |
| 6.3 | **Global `?` cheatsheet** in KeyboardProvider (respecting `isEditableTarget`), sourced from a **single shortcut registry** so palette labels and the legend never drift, rendered with the canonical Kbd primitive. *(Today only ⌘K/⌘J/Escape exist, discoverable only via buried tooltips.)* | M | `app/KeyboardProvider.tsx`, `app/commands.ts`, `paddock/SessionPane.tsx` |
| 6.4 | **Fix ChatPanel:** always render a composer (correct the false "send a prompt below" empty state — the input only appears when `awaiting_input`); auto-scroll to latest unless the user scrolled up; render assistant text through a lightweight markdown/code formatter (mono fenced blocks on `surface-2` with copy); add relative timestamps + expandable tool rows. Add roving-tabindex + Enter nav and a debounced live search to SearchPanel. Drop one restrained monochrome `SheepIcon` beat into palette/chat/search empty states. | L | `chat/ChatPanel.tsx`, `search/SearchPanel.tsx`, `components/SheepIcon.tsx` |

**Validation:** Playwright e2e — fuzzy query matches non-contiguous terms, arrow-down scrolls the
active option into view, `?` opens the cheatsheet, palette animates on ⌘K; visual review of
grouped/highlighted results, chat composer present in every session state with auto-scroll, and the
brand empty states; unit tests for the pure fuzzy scorer and MRU.

---

## Phase 7 — Mobile, PWA & accessibility completion

**Goal:** Reach 44px hit-target ergonomics, real app-likeness, and full keyboard/AT parity across
phone and settings.

| # | Task | Effort | Files |
|---|------|--------|-------|
| 7.1 | **Touch ergonomics:** apply `min-h-touch`/`min-w-touch` (the Phase 2 `--flock-touch` token) to every KEY_STRIP button, keyboard toggle, hamburger, and node/project icon button (padding, not glyph size); delete the orphaned `[data-testid='phone-decision']` rule; make the phone attention dot use the system indicator (`data-rings` + `--flock-indicator-color`) with a static reduced-motion ring; make the breakpoint device-aware (`(pointer:coarse)`/`max-height` so landscape phones get PhoneView); extend safe-area insets to left/right; track visual-viewport height so the key strip rides above the software keyboard. | L | `responsive/PhoneView.tsx`, `styles/responsive.css`, `responsive/useIsPhone.ts`, `responsive/useVisualViewport.ts` |
| 7.2 | **Give the installed PWA an identity:** rasterize `icon.svg` → PNG 192/512 + maskable + 180×180 apple-touch-icon and reference them in the manifest + `index.html` (keep the SVG as `sizes:'any'`); add a **light-scheme** `<meta name=theme-color>` paired with the dark one; add a dismissible token-styled install affordance (`beforeinstallprompt` capture + iOS add-to-home hint). | M | `public/manifest.webmanifest`, `index.html`, `responsive/PhoneView.tsx` |
| 7.3 | **ARIA tree pattern for the sidebar:** `role=tree/treeitem/group`, `aria-expanded`, `aria-selected`/`current` on the active session; roving tabindex with ArrowUp/Down to move, ArrowRight/Left to expand/collapse, Enter to open; `title`/SimpleTooltip on truncated labels; persist expand/collapse per id in the store (seeded from attention); derive the node icon from `node.kind`; base indentation on one `--flock-tree-indent` step. | L | `paddock/SidebarTree.tsx`, `paddock/Sidebar.tsx`, `store/paddock.ts` |
| 7.4 | **Complete the settings surface:** register the built-but-unreachable owner **Audit** section (add to `SETTINGS_SECTIONS` **and** the `SettingsSection` union in `store/paddock.ts`) and retoken `AuditLogView` (`text-red-500`→`text-status-error`, aliases→ink tokens, native controls→ui primitives); delete the dead `Login.tsx`/`Setup.tsx` routes + tests; group the flat 7-item nav into Personal/Workspace/System clusters (desktop `<ul>` + mobile Select); standardize empty/loading via the Phase 2 EmptyState + Skeleton; fix password `minLength` to 12; demote the dead Appearance "Accent" control to a caption; differentiate wordmark vs section-title weight; set `TransportWarning` to `role=alert`. | L | `settings/SettingsPage.tsx`, `settings/AuditLogView.tsx`, `settings/SettingsSection.tsx`, `settings/sections/AppearanceSection.tsx`, `auth/{AuthScreen,TransportWarning}.tsx` |

**Validation:** Device test at 44px hit targets + landscape-phone breakpoint; Lighthouse/PWA install
check for maskable + apple-touch icons and theme-color per scheme; screen-reader + keyboard walk of
the tree (arrow traversal, `aria-selected`) and settings nav; confirm the Audit section renders for
owners and gracefully shows forbidden otherwise; e2e that password < 12 is rejected; contrast check
TransportWarning and grouped nav.

---

## Quick Wins (land any time — mostly Phase 1/3 dependencies, all Small)

- Switch `StatusIndicator` `animate-pulse` → `animate-flock-pulse` + set `--flock-indicator-color` (the signature ring gets the right hue).
- Add `focus-visible:opacity-100` to the 6 hover-only sidebar action buttons — fixes an invisible destructive **Terminate** control under keyboard focus.
- Gate the tree `SessionRow` pulse on `error || awaiting_input` so errored agents pulse consistently.
- Render `statusLabel(entry.status)` instead of raw snake_case in the ActivitySidebar timeline.
- Derive the expanded-tree node icon from `node.kind` (Cpu/HardDrive) so local machines stop showing as drives.
- Replace `text-white` with the intent-foreground token in button `destructive` and sonner.
- Reconcile `tokens.ts` `TYPE_SCALE` to shipped `polish.css` values + add a value-parity assertion.
- Delete the dead `[data-testid='phone-decision']` rule and the unrouted `Login.tsx`/`Setup.tsx` screens + tests.
- Set setup/new-password `minLength` to 12 to match the enforced rule + helper copy.
- Change `TransportWarning` from `role=status` to `role=alert` so the insecure-transport notice is announced.
- Add `aria-label` to the FleetView node connection dot.
- Remove the redundant inline `color:'#c8ccd4'` override on the terminal blank-recover banner.

---

## Risks & Sequencing Notes

- **Hand-author overlay keyframes, don't adopt `tailwindcss-animate`** — the plugin's default
  durations/easings ignore the `--flock-*` tokens and reintroduce the exact drift the system was
  built to avoid.
- **The elevation ramp partly contradicts the "borders carry elevation" philosophy.** Decide policy
  first: prefer *neutralizing* the vestigial invisible `shadow-sm` on raised controls over
  introducing a competing shadow model; reserve the ramp for layer-differentiated overlay depth.
- **Shifting `running` off blue (or reworking selected-row) touches every status surface** — land
  snapshot/Playwright coverage of fleet, grid, and sidebar *before* the change so the
  accent-vs-status disambiguation doesn't regress other views.
- **Do NOT delete `StatusIndicator` or the `[data-rings]` `polish.css` rule** — both are live
  (`ActivitySidebar` renders `StatusIndicator`; the rule is test-guarded). Reconcile the dot
  systems, don't remove them.
- **Binding AppShell columns to fixed-px tokens replaces flexible `minmax` ranges** — a behavioral
  change; verify layout at narrow and very wide viewports before shipping.
- **The owner Audit section must extend the `SettingsSection` union in `store/paddock.ts`** or it
  won't type-check; there's no client-side owner-role signal today, so rely on the component's
  server-gated "forbidden" state rather than conditional inclusion.
- **The mobile breakpoint string can't parameterize a `@media` query** — custom properties don't
  reach media queries, so mirror any breakpoint change by hand in `responsive.css` and keep the
  single-source string as a hand-kept comment.
- **`ConnectivityBanner`-as-overlay and drawer animation must not trigger xterm refit storms** —
  test on a transient network blip and confirm terminals don't reflow.
- **Reading xterm `ITheme` via `getComputedStyle` must run after CSS load and re-run on theme
  toggle**, or the palette captures stale/empty values.

---

## Validation Strategy (overall)

The repo already has the harness we need — reuse it, don't reinvent:

- **Token contracts:** `theme/theme.contract.test.ts`, `theme/polish.test.ts`, `theme/tokens.test.ts`
  (extend with value-parity + diff/term token presence). Run: `pnpm --filter @flock/web test:unit`.
- **Component/a11y units:** Vitest + Testing Library per new primitive (roles, keyboard).
- **E2E (both themes):** Playwright in `apps/web/e2e/` — extend `theme.spec.ts`,
  `accessibility.spec.ts`, `responsive.spec.ts`, `shell.spec.ts`, `terminal.spec.ts`; add
  attention-signal and overlay-motion specs. Run: `pnpm --filter @flock/web test:e2e`.
- **Contrast/a11y gates:** verify every new intent/foreground pair, diff foreground, and status hue
  at WCAG AA; keyboard-walk the tree, palette, forms, and settings nav; confirm every animation has a
  `prefers-reduced-motion` still-state.
- **Grep gates (CI-friendly):** zero `bg-[#...]`, `text-white`, `ring-white/[0.03]`, and no new
  `[var(--flock-*)]` arbitrary values in primitives.

---

## Appendix — Audit Coverage

10 surfaces audited in parallel, each finding adversarially verified against source before inclusion.
**105 findings** total (1 foundational · 8 high · 63 medium · 33 low).

| Surface | Findings | One-line read |
|---------|:--------:|---------------|
| Design tokens / global CSS / motion / theme | 12 | Strong 1:1 mirror & dark ramp; the damage is *designed-but-unwired* (dead pulse, dead overlay motion) + incomplete Tailwind bindings. |
| App shell / layout / spatial composition | 10 | Good CSS-grid bones with ARIA landmarks; reads as well-made parts *bolted together* (two hairline systems, ignored height tokens). |
| Sidebar / tree / status indicators | 11 | Architecturally calm & elite in places; the flagship "which agent needs me" cue under-signals on collapsed branches. |
| UI component primitives | 11 | Token-disciplined and cohesive; stops before the structural primitives the app clearly needs. |
| Dialogs / forms / input UX | 10 | Sound structure & elite focus-restore; `DialogField` structurally can't express field-level validation. |
| Fleet / overview / grid supervision | 10 | Strong single-pass models & kanban grid; blocked/errored agents render identically to idle; accent spent on infra bars. |
| Terminal / shell / code surfaces | 10 | Elite terminal engineering; hardcoded ANSI palette, monochrome diffs, permanently-dark editor sit outside the token system. |
| Settings / onboarding / auth | 9 | Premium first-run brand moment & registry-driven IA; unreachable owner Audit, dead routes, ad-hoc empty states. |
| Responsive / mobile / PWA | 11 | Genuinely hard phone-terminal problem solved well; systematically sub-44px chrome, SVG-only icons, width-only breakpoint. |
| Command palette / keyboard / chat / brand | 11 | Clean architecture & nice ⌘K affordance; naive substring filtering, no `?` legend, chat composer missing when idle. |

*Generated by a multi-agent audit workflow (57 agents, all verified). Every task above names concrete
files and the specific tokens/primitives to use, and respects the existing token architecture.*
