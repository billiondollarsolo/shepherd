# Code review: herdr-aligned shell (2026-07-09)

**Scope:** uncommitted herdr-shell work — `features/shell/*`, store/router/Paddock, paddock surfaces, `orchestrator/src/me/*`, shared shell modules, phone path.  
**Method:** four parallel read-only reviewers (correctness, dead code/duplication, UX/plan fidelity, API/backend) + orchestrator cross-check.  
**Verdict:** Strong pure kernels and a careful cold-start LWW protocol; production still has a **dual stage path**, **ephemeral me-state**, several **dead surfaces**, and **phone drive that is UI-only**. Not elite end-to-end yet — elite foundations with transitional assembly.

---

## Executive summary

| Axis | Grade | One-liner |
|------|-------|-----------|
| Shared pure modules | A− | shell-nav paths, layout parse/prune, agents-list, selection LWW are clean |
| Fleet selection protocol | B+ | Cold-start GET-first is right; cancel/failed-PUT edges remain |
| Stage / terminals | C | GridView → ProjectLayoutView swap remounts PTYs |
| Multi-device product | C | REST poll + in-memory Maps; not durable / multi-replica |
| Phone | D | Stage/send UI unwired in production |
| Dead code / dual systems | C | Two stage models, dual chrome flags, dead store fields |
| API authz | B | Cookie auth OK; layout is shared-by-project with no existence check |
| Plan honesty | C | Checkboxes over-claim; deviations more accurate |

---

## Critical / high bugs

### 1. Phone stage/send is non-functional in production
**Severity: Critical**  
**Files:** `apps/web/src/features/responsive/ResponsivePaddock.tsx`, `PhoneView.tsx`

`PhoneView` has Stage/Send + key strip and tests with `onSendInput`, but `PhonePaddock` never passes `onSendInput`, never opens a PTY, and labels sessions with raw IDs. Copy admits desktop is required for the stream.

**Fix:** Wire real PTY inject / respond API, or disable/hide send UI and stop claiming “drive from phone.”

---

### 2. StageLayout remounts terminals (GridView → ProjectLayoutView)
**Severity: Critical (desk feel / PTY thrash)**  
**File:** `apps/web/src/features/shell/StageLayout.tsx`

Cold path: `layout === null` → full `GridView` (xterms) → fetch/reconcile → `ProjectLayoutView` (new `TerminalArea`s). Unmounts and remounts PTYs for the same sessions — opposite of keep-mounted plan goals.

**Fix:** One host keyed by `sessionId`. Loading skeleton without mounting terminals; never use GridView as a temporary stand-in for the same project.

---

### 3. Agent URL does not clear project scope (cross-project stage leak)
**Severity: High**  
**Files:** `packages/shared/src/shell-nav.ts`, `router.tsx`, `StageLayout.tsx`

`/agents/:id` sets selection but not `activeProjectId: null`. Stage uses `selectedProjectId ?? selected?.projectId`, so project wins. Deep link after `/p/other` can show wrong leaves / “Session closed.”

**Fix:** Clear project on agent paths, or prefer `selected.projectId` when a session is selected. Always pass `projectId` into `openAgent` (Sidebar currently drops it).

---

### 4. StageLayout re-GETs layout on every focus change
**Severity: High**  
**File:** `StageLayout.tsx` effect deps `[projectId, openIdsKey, selectedSessionId]`

Focus → re-fetch → `setLayout` can clobber in-flight local splits. PUT is fire-and-forget with optimistic `lastPersisted`.

**Fix:** Don’t refetch on focus-only changes; local-only focusedLeaf updates; generation/ignore stale GET; serialize/retry PUT.

---

### 5. In-memory me-state (selection, presets, layouts)
**Severity: High (ops / multi-device)**  
**Files:** `apps/orchestrator/src/index.ts`, `me/fleet-selection.ts`

Process Maps only: restart and multi-replica wipe multi-device follow, custom presets, and split layouts. Plan §10.3 specified Postgres tables.

**Fix:** Persist to DB, or document single-node ephemeral and treat multi-device as best-effort.

---

### 6. Project layout authz is weak
**Severity: High**  
**File:** `me-routes.ts` layout routes

Any authed user can GET/PUT any `projectId` (no existence / membership check). Consistent with loose project CRUD today, but maps orphan IDs and last-writer wins with no revision.

**Fix:** 404 unknown project; same access rules as projects; optional revision field.

---

### 7. Host chips don’t scope Mission Control
**Severity: High (product)**  
**Files:** `HostChips.tsx`, `MissionControl.tsx`

Agents list filters by `hostScope`; MC does not. Chips look active but home board ignores them.

**Fix:** Filter MC open set / counts by hostScope.

---

### 8. D5 undermined by always-on RightRail + dual tools controls
**Severity: High (UX)**  
**File:** `SessionPane.tsx`

`chrome === 'stage'` still shows RightRail. Header has both “toggle side panel” and Maximize/Minimize for tools — reads as old focus/zen.

**Fix:** Hide rail in stage chrome; one **Tools** control; single source of truth for tools open.

---

## Medium — robustness, dead code, quality

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 9 | bug | Failed PUT then remote apply drops local selection | `fleetSelectionSync.ts` |
| 10 | bug | Cold-start always prefers remote over URL/local (no LWW vs deep link) | `fleetSelectionSync.ts` |
| 11 | bug | Cancelled first tick leaves `lastSyncedKey` null → re-cold-start can re-apply remote over click | `FleetSelectionSync.tsx` |
| 12 | bug | `lastStatusTransitionAt` missing from WS **snapshot** frames | `live-channels.ts` |
| 13 | bug | Client live map drops transition time; AgentsSwitcher `getMeta` is dead cast | `liveData`, `AgentsSwitcher.tsx` |
| 14 | bug | Host chip “connected” reads wrong health shape (`connected` vs `link === 'up'`) | `HostChips.tsx` |
| 15 | bug | Tools panel can bind to `open[0]` when selection missing | `SessionPane.tsx` |
| 16 | bug | Silent 200 when `putPresets`/`putLayout` sinks missing | `me-routes.ts` |
| 17 | suggestion | Dual stage systems: GridView localStorage presets vs server ProjectLayout | StageLayout / GridView / store |
| 18 | suggestion | shell-nav pure reducers mostly unused; store reimplements transitions | `shell-nav.ts` / `paddock.ts` |
| 19 | suggestion | Dual `chrome` + `rightOpen` | store |
| 20 | dead | Store `zoomLeafId` never read (zoom on layout only) | `paddock.ts` |
| 21 | dead | `setAssistivePanels` / `setFleetSelectionFollow` — no Settings UI | store |
| 22 | dead | `/api/me/launcher-presets/builtins`, `putLauncherPresets` UI, `resolveRemoteSelection` prod, `parseProjectLayout` import in me-routes | various |
| 23 | dead | Identical if/else in `reconcileProjectLayout` | `projectLayoutState.ts` |
| 24 | dead | Empty if in HostChips attentionCount | `HostChips.tsx` |
| 25 | suggestion | Fake resize cursors (no drag), shell leaf placeholders | `ProjectLayoutView`, StageLayout |
| 26 | suggestion | Nested `<button>` in Agents rows (invalid HTML) | `AgentsSwitcher.tsx` |
| 27 | suggestion | productionWiring tests are source-string only | `productionWiring.test.ts` |
| 28 | suggestion | Validation gaps: IsoTimestamp for updatedAt, preset/layout bounds, project-scoped layout check | shared + me-routes |
| 29 | suggestion | seed/rehydrate resets lastStatusTransitionAt to “now” | status map / rehydrate |
| 30 | suggestion | openMission with selection never shows MC board; URL always /agents/:id | Paddock / shell-nav |

---

## Duplication & architecture map

```
shared shell-nav reducers  ──(tests only)──►  not used by store
store openAgent/openMission ──(prod)───────►  reimplements transitions

GridView (localStorage order/presets)  ◄── temporary fallback ── StageLayout
ProjectLayoutView (server Map)         ◄── “real” splits path ── StageLayout

fleetSelectionClient (REST)  ──►  fleetSelectionSync (protocol)  ──►  FleetSelectionSync (poll)
```

**Elite direction:** one stage host, one shell reducer source of truth, durable me-state, phone on same stack.

---

## Delete / demote shortlist

| Candidate | Action |
|-----------|--------|
| Store `zoomLeafId` / `setZoomLeafId` | Delete or wire Esc/zoom consistently |
| Empty HostChips if-branch | Delete |
| Identical `layoutIsProjectScoped` if/else | Collapse to one prune |
| `/api/me/launcher-presets/builtins` | Delete if unused |
| `selectionFingerprint` deprecated | Delete or keep test-only |
| `resolveRemoteSelection` if superseded | Keep for tests of shared LWW only |
| Fake resize UI | Implement or remove cursor |
| Shell leaf placeholder | Implement PTY or hide |
| One of {GridView multi-pane, ProjectLayoutView} as permanent dual | Consolidate |
| productionWiring as sole gate | Supplement with mount/integration tests |

---

## What is already elite (keep)

1. **Cold-start GET-first** selection protocol (after skeptic fix) + pure tests.  
2. **Shared** `project-layout` parse/prune/split, `agents-list` pin-first sort, `display-status` calm map.  
3. **`openAgent` as single open path** from MC / Agents / launch (when projectId is passed).  
4. **Assistive panels default off** (right product default).  
5. **BottomBar only when tools** chrome.  
6. **Preset grey-out** of missing CLIs on node.  
7. **Cookie auth** on me routes (not on public allowlist).  
8. **Live status map** only bumps `lastStatusTransitionAt` on real status change.

---

## Priority fix order (recommended)

| Pri | Item | Why |
|-----|------|-----|
| P0 | Kill GridView intermediate mount in StageLayout | Terminal thrash |
| P0 | Phone: wire send or honest disable | Product lie |
| P0 | Agent URL / StageLayout project preference | Cross-project leak |
| P1 | Host scope filters MC | Host chips meaning |
| P1 | RightRail only when tools; one Tools control | D5 |
| P1 | WS snapshot + client map for lastStatusTransitionAt | Sort actually works |
| P1 | Don’t refetch layout on focus; PUT retry | Data races |
| P2 | Durable me-state (Postgres) or document ephemeral | Multi-device truth |
| P2 | Layout authz + validation bounds | API quality |
| P2 | Delete dead store/API surfaces | Maintainability |
| P2 | Failed-PUT / deep-link LWW edges in selection | Robustness |
| P3 | Unify shell-nav reducers with store | Drift prevention |
| P3 | A11y (tabs, nested buttons, Esc → tools) | Elite polish |
| P3 | Reopen plan checkboxes to match reality | Team trust |

---

## Suggested “elite” definition of done (next sprint)

- [ ] One keep-mounted stage renderer (no dual Grid/Layout flash)  
- [ ] Terminal-first: no right rail until Tools  
- [ ] Host scope filters Agents **and** Mission Control  
- [ ] Phone either drives PTY or doesn’t claim stage  
- [ ] Selection + layouts survive orchestrator restart (or explicitly single-node)  
- [ ] lastStatusTransitionAt end-to-end (snapshot + client + Agents sort)  
- [ ] Dead dual flags / zoomLeafId / unused reducers removed  
- [ ] Plan checkboxes match ship state  

---

*Review artifacts: four subagent passes (correctness, dead-code, UX, API). No code was modified in this review pass.*
