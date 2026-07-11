# Performance and Accessibility Budgets

This document is the operational contract for Phase 8 of the elite code and
agent-security plan. The numbers are regression ceilings, not targets to consume.
Tightening them requires a measured baseline; loosening them requires a reviewed
reason in the same change.

## Bundle and route budgets

`pnpm quality:bundle` reads Vite's production manifest and measures raw, gzip, and
Brotli bytes. It also proves that terminal fonts are absent from the initial shell
and runs a fail-closed oversized-fixture self-test.

| Boundary                    | Raw ceiling | Gzip ceiling | Brotli ceiling |
| --------------------------- | ----------: | -----------: | -------------: |
| Application shell JS        |     650 KiB |      200 KiB |        170 KiB |
| Application shell CSS       |      60 KiB |       13 KiB |         11 KiB |
| Desktop Paddock             |     125 KiB |       34 KiB |         29 KiB |
| Mobile Paddock              |      25 KiB |        8 KiB |          7 KiB |
| Shared dialogs              |      42 KiB |       14 KiB |         12 KiB |
| Desktop xterm engine        |     350 KiB |       95 KiB |         80 KiB |
| Mobile Ghostty engine       |     670 KiB |      200 KiB |        165 KiB |
| Code editor                 |     810 KiB |      295 KiB |        240 KiB |
| Terminal font CSS           |      26 KiB |       17 KiB |         16 KiB |
| Desktop initial route total |           — |      260 KiB |        220 KiB |
| Mobile initial route total  |           — |      240 KiB |        205 KiB |

The July 2026 baseline is 235.1 KiB gzip for the desktop initial route and
211.7 KiB for mobile. The former 1.19 MB monolithic entry is now a 621 KB shell;
settings, node details, source control, files, browser, code editor, xterm, and
Ghostty are interaction-loaded. The terminal's approximately 1.0 MB Nerd Font is
loaded by an on-demand stylesheet only when a terminal mounts. The unused bold
Nerd Font and unused Space Grotesk payload were removed.

## Runtime budgets

`pnpm quality:performance` runs 15 measured samples after warm-up, reports median
and p95 latency, enforces thresholds, and writes a comparable JSON artifact to
`artifacts/performance/runtime-benchmarks.json`.

The scenarios cover 1, 4, 12, 50, and 200 nodes, including node sorting, project
and open-session indexing, and session ordering. A 200-node cycle must remain
below 5 ms p95 on the CI runner. Terminal resume-buffer writes and full replay
snapshots must each remain below 8 ms p95.

The July 2026 local baseline was:

| Scenario                       | Scale | Median |    p95 |
| ------------------------------ | ----: | -----: | -----: |
| Fleet index/sort/session order |   200 | 0.12ms | 0.19ms |
| 256 KiB resume-buffer write    |     — | 0.01ms | 0.04ms |
| 256 KiB resume-buffer snapshot |     — | 0.12ms | 0.16ms |

These microbenchmarks isolate algorithm regressions. Browser E2E separately covers
mount, resize, scrollback, reconnect, refresh, and WebKit mobile lifecycle. When a
change affects startup or rendering, capture a production-build Performance trace
with 4× CPU slowdown and Fast 3G before and after; attach it to the review. Check
long tasks, scripting/evaluation, first usable Paddock, heap after idle, and dropped
frames during high terminal output.

## Large-fleet behavior

- Node cards and the sidebar render 30 nodes at a time with an explicit “show more”
  control. The saved node order is preserved across pages.
- Metrics are requested only for visible connected node cards.
- Project and session rollups use single-pass indexes instead of per-card scans.
- A live telemetry change is covered by a render-count regression test: only the
  affected terminal cell may render, and neighboring terminals may not remount.
- Desktop and mobile terminals keep 10,000 client scrollback lines.
- Orchestrator reconnect replay is capped at 256 KiB per attached session.
- Agentd authoritative scrollback is capped at 2 MiB per session.

## Accessibility contract

`apps/web/e2e/accessibility.spec.ts` runs axe WCAG 2 A/AA and 2.1 A/AA checks at
desktop and 390×844 mobile breakpoints in both light and dark themes. Serious or
critical violations fail CI. It covers Paddock, Agents, node details, project,
project Git, every Settings section, creation/configuration dialogs, and the
command palette. Canvas/terminal emulator internals are excluded from generic axe
rules and covered by dedicated keyboard and terminal lifecycle tests.

The automated contract also verifies:

- dialog focus trapping and restoration to the durable opening control;
- a visible keyboard focus indicator;
- reduced-motion behavior;
- focusable scroll regions;
- semantic command-palette listbox behavior;
- keyboard node ordering with `Alt+Up` / `Alt+Down`;
- keyboard Pen ordering with `Alt+Up` / `Alt+Down`;
- Pen membership through the keyboard-accessible agent actions menu;
- WebKit mobile navigation, terminal keyboard, scrollback, refresh, and reconnect.

Before a public release, perform one manual VoiceOver or NVDA smoke through setup,
node/project navigation, session creation, Pen movement, settings, terminal focus,
and deletion confirmation. Automated checks do not replace an assistive-technology
user-flow review.

## Validation commands

```sh
pnpm --filter @flock/web build
pnpm quality:bundle
pnpm quality:performance
pnpm exec playwright test apps/web/e2e/accessibility.spec.ts --project=chromium
pnpm exec playwright test apps/web/e2e/mobile-routes.spec.ts apps/web/e2e/terminal.spec.ts --project=webkit-mobile
```
