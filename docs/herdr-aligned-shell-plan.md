# Flock × herdr-web Alignment Plan

> **Status:** Working plan — source of truth for the shell/navigation redesign.  
> **Created:** 2026-07-09  
> **Companion docs:** [architecture.md](architecture.md), [roadmap.md](roadmap.md), [design-tokens.md](design-tokens.md), [flock-agentd-design.md](flock-agentd-design.md)  
> **Inspiration:** `../herdr-web` (agent-first switcher + stage + multi-client terminal), without becoming a thin Herdr attach client.

---

## 0. How to use this document

1. Work **phases in order** (0 → 1 → 2 → 3 → 4). Phase 0 is the cohesion fix; later phases hang off it.
2. Prefer **one task = one branch = one PR** unless a task explicitly groups small tightly-coupled pieces.
3. Every task lists **Why · Scope · Approach · Success criteria · Tests · Validation · Deps · Risk**.
4. Update checkboxes in this file when a task merges.
5. Do **not** violate the two Flock invariants from [roadmap.md](roadmap.md) §2:
   - **Any agent works** (PTY fallback forever).
   - **Node is source of truth; client is viewer** (no local-first pivot).
6. This plan **does not replace** roadmap Layer 0–2 foundation work (ACP, contracts, etc.). It sits beside it as a **shell / supervision UX** track. Where they conflict, call it out in the PR.

---

## 1. Product decisions (locked)

These came from the herdr-web comparison review and explicit user decisions:

| # | Decision | Choice |
|---|----------|--------|
| D1 | Default home | **Mission Control · All hosts** |
| D2 | Click agent from MC | **Stage opens; lens becomes Agents** |
| D3 | Shared selection scope | **Per-user default** (not team-shared yet) |
| D4 | Split scope | **Project-on-node only** (a project is a “space”) |
| D5 | Default stage chrome | **Terminal-first / zen-as-default stage** (tools opt-in, not ambient cockpit) |
| D6 | Host model | Flock **nodes** are the multi-server surface (host chips), not Herdr bridges |
| D7 | Feature kit | Pins, notes, multi-host chips, launch presets, mobile stage/send + keys, last-status-change sort — **all in scope** across phases |
| D8 | Pain surface | Navigation + chrome + mobile + launch friction — **all of it** |

### Non-goals (this plan)

- Replacing the orchestrator with “attach to external Herdr.”
- Dropping Mission Control, git/PR, per-session browser, worktrees, handoff, race.
- Team-wide live collab (pair cursors, shared selection across users) — Phase 1 is **per-user multi-device only**.
- Free-form splits across projects/nodes.
- Making structured chat the primary prompt surface (terminal remains primary; chat is a tool panel).

---

## 2. Diagnosis: why the flow feels “off”

### 2.1 Three products in one shell

Flock currently has **three overlapping mental models** that do not share one story:

| Surface | Mental model | Entry |
|---------|--------------|--------|
| **Mission Control / Fleet** | Fleet of agents across all nodes | `view: 'overview'`, `/` |
| **Sidebar tree** | Inventory: Node → Project → Session | Always visible in paddock shell |
| **Center (SessionPane)** | Project **grid** *or* session **focus** *or* node page | `viewMode`, `selectedSessionId`, `nodeInfoNodeId` |

Daily path is inconsistent:

1. Land on Mission Control → click agent → `focusSession` → `/s/:id`.
2. Shell **rehomes**: overview center is replaced by paddock center; tree + header + right panel + bottom telemetry appear.
3. Multi-agent watch is **project-scoped grid**, not “the space I was looking at.”
4. Other machines are reached by **tree depth**, not host scope.
5. Phone is an **attention inbox**, not the same stage/selection as desk.

**herdr-web** feels coherent because the shell never changes:

> Host → switcher (Agents / Tabs) → stage (terminal, optional splits)

### 2.2 The “focus” cohesion problem (named)

This is the specific confusion called out in review. Today “focus” is **three different things**:

| Name in code / UI | What it actually is | Files |
|-------------------|---------------------|--------|
| `viewMode: 'focus' \| 'grid'` | Maximize one cell vs tile project sessions | `store/paddock.ts`, `SessionPane.tsx` |
| `zenMode` | Tear off the entire chrome (no top/sidebar/bottom) | `Paddock.tsx`, toggle labeled “Focus mode” in header |
| `focusSession(id)` | Select session **and** set `viewMode: 'focus'` | store + sidebar + MC cards |

Problems that produce the “not cohesive” feeling:

1. **Overloaded language.** UI says “Focus mode” for `zenMode`, while store `viewMode: 'focus'` means “maximized session with header + right panel.” Two words, two products.
2. **Default vs entry mismatch.** Default `viewMode` is `'grid'`, but almost every “open this agent” path calls `focusSession` → force focus. You never learn a stable default.
3. **Zen rebuilds the world.** Entering zen swaps the whole React tree (`TopBar` / `AppShell` / `BottomBar` unmounted). It feels like a mode switch, not a stage preference.
4. **Adaptive right panel fights terminal-first.** On `awaiting_input` auto-open Chat; on tool events auto-open Diff/Browser (`SessionPane.tsx`). Useful for a cockpit; hostile to a herdr-like stage. It also steals attention when you only wanted to type `y`.
5. **Grid and focus are different chrome stacks layered on one GridView.** Grid has its own tab strip; focus adds Header + RespondBar + RightPanel. Selection semantics differ (`selectSession` vs `focusSession`).
6. **Overview is a hard cut.** `view === 'overview'` replaces the center with `FleetView` entirely. Agents disappear from the stage; you “leave” supervision to “go home.”
7. **Auto-focus single session** (`useAutoFocusSingleSession`) can yank you out of intentional empty/overview states when one session exists.
8. **URL model mirrors the fracture.** `/` overview, `/s/:id` focus, `/p/:id` grid, `/n/:id` node — four destinations for one supervision activity.

### 2.3 What “fixed focus” means

Collapse to **one stage model**:

```
Stage always exists.
  - selectedSessionId = which leaf has keyboard/input focus
  - layout = how leaves are arranged for the active project (single | splits)
  - chrome density = terminal-first (default) | tools open
  - zoom = one leaf full stage (optional; temporary)
```

Delete the conceptual trio **focus / grid / zen** as user-facing modes. Implement them as **derived presentation** of selection + layout + chrome density.

| Old concept | New concept |
|-------------|-------------|
| `viewMode: 'focus'` | Stage with one selected leaf; layout may still be multi-leaf underneath (hidden or zoomed) |
| `viewMode: 'grid'` | Stage showing project layout (multi-leaf), selected leaf highlighted |
| `zenMode` | **Default stage density**: rail + thin stage header only; tools closed |
| “Exit zen” | Open tools / expand host rail / show MC lens — not a separate app mode |
| `focusSession` | `openAgent(id)` → set selection, ensure stage visible, set lens=Agents, host scope includes session’s node |

---

## 3. Target product model

### 3.1 Shell anatomy (single app shell)

```
┌ Host chips: [ All ] [ node-a ] [ node-b ] [ pool:build ] ──── settings / account ─┐
│ Lenses:  [ Mission Control ]  [ Agents ]     (+ optional later: Spaces / Notes)     │
├──────────────────────────────┬──────────────────────────────────────────────────────┤
│ LEFT: Switcher               │ CENTER: Stage                                        │
│  (list for current lens +    │  thin header (breadcrumb · status · pin · split ·    │
│   host scope)                │   tools toggle · zoom)                               │
│                              │  terminal-first leaves (xterm; keep-mounted)         │
│                              │  mobile: stage/send + key strip when touch           │
├──────────────────────────────┤ RIGHT (opt-in): Tools / Notes                        │
│                              │  Talk · Activity · Code · Web · Notes                │
└──────────────────────────────┴──────────────────────────────────────────────────────┘
```

- **One shell** for home and agent drive. Lenses change the **left list** (and MC may also use the full center when nothing is selected — see §3.3).
- **Host chips** scope which nodes contribute to lists and MC lanes.
- **Stage is always terminal-first by default** (D5). Right tools start closed unless user opens them or a mild, opt-in “assist” preference is enabled later.
- **Bottom telemetry bar** becomes optional / collapsed by default (or only when tools open / density=rich). Do not force cockpit chrome on every open.

### 3.2 Hierarchy (domain, unchanged core)

```
Node            machine (local | ssh); host chip identity
  └─ Project    working directory on that node = “Space”
       └─ Session   one agent (or terminal/dev) = one PTY = one status
            (+ optional shell leaves that are not agent sessions)
```

**Session remains the atomic agent unit.** Splits are a **layout over sessions (and shell leaves) within one project**, not a new agent entity.

### 3.3 Navigation state machine

Canonical UI state (conceptual; exact field names in §6):

```
hostScope: 'all' | { nodeId } | { pool: string }
lens: 'mission' | 'agents'          // (+ 'notes' later)
selectedSessionId: string | null
activeProjectId: string | null      // project owning the stage layout
layout: ProjectLayout | null        // splits within activeProjectId
chrome: 'stage' | 'tools'           // stage = terminal-first default
zoomLeafId: string | null           // temporary full-stage one leaf
fleetSelectionFollow: boolean       // multi-device follow for this user
```

**Transitions (locked behaviors):**

| User action | Result |
|-------------|--------|
| App load (authenticated) | `hostScope=all`, `lens=mission`, stage empty or last selection restored if follow-enabled |
| Click MC card | `selectedSessionId=…`, `activeProjectId=session.projectId`, `lens=agents`, stage opens that leaf, `chrome=stage` |
| Click Agents row | same as MC card |
| Click host chip | filter lists/MC; if selection not in scope, clear selection or keep with “out of scope” indicator (prefer **keep selection**, dim list) |
| Click project in Agents group | set `activeProjectId`, show project layout on stage (multi-leaf if layout has splits) |
| Open tools | `chrome=tools`, right panel visible |
| Close tools / Esc | `chrome=stage` |
| Split | add leaf to project layout (new session via launch, or shell leaf) |
| Zoom | `zoomLeafId=leaf`; Esc clears zoom |
| Logo / “Mission Control” | `lens=mission`; **do not destroy** selection/stage — MC list fills left; stage can remain |

### 3.4 Mission Control vs Agents (roles)

| Lens | Answers | Content |
|------|---------|---------|
| **Mission Control** | Why should I care? | Needs you / working / review / quiet; teams; git dirt; host roll-up |
| **Agents** | What do I open and drive? | Flat/grouped agent list: pin, attention, active-only, last status change, group by node/project |

MC is **not** a separate app you exit. It is a lens over the same fleet under the same host scope.

### 3.5 Multi-device (per-user)

- Orchestrator stores **per-user fleet selection**: `{ selectedSessionId, activeProjectId, hostScope?, updatedAt }`.
- All of a user’s browser/phone clients subscribe via WebSocket.
- **Writer:** any client that changes selection (with last-write-wins + timestamp; optional “sticky local” if offline).
- **Follower:** clients with follow enabled apply remote selection (default **on** for the user’s other devices).
- Not shared across users in this plan.

### 3.6 Splits (project-on-node)

```
Project layout (opaque tree stored server-side; authored by web):
  - binary split tree (row/col + ratio) OR tab groups of leaves
  - leaf = { type: 'session', sessionId } | { type: 'shell', shellId }
  - focusedLeafId
  - optional zoomedLeafId
```

- **Workspace key** for agentd layout store: stable `projectId` (or `nodeId:projectId` if layouts are node-local — prefer **projectId** since projects already bind to one node).
- agentd already has opaque layout persistence (`agentd/internal/layout`) — use it; orchestrator may mirror for multi-client and for nodes where agentd is down.
- Shell leaves reuse existing shell-drawer PTY pattern (`sessionId:shell` or dedicated shell session ids) but **placed in layout**, not only a bottom drawer.
- Launch: **+ → preset → new split | replace zoomed | new project**.

### 3.7 Status presentation (calm)

Keep the rich Flock status enum on the wire. **Display map** for list loudness (herdr-like):

| Wire status | Display | Loud in list? |
|-------------|---------|---------------|
| `awaiting_input` | blocked / needs you | yes |
| `error` | error | yes |
| `running` / `starting` | working | yes (softer than blocked) |
| `done` | done | yes (attention for review) |
| `idle` | idle | no |
| `disconnected` | disconnected | yes (warning) |

Telemetry (tokens, cost, context %) lives on stage footer when tools open or on MC cards — not mandatory on every list row.

---

## 4. Phase overview

| Phase | Name | Outcome | Depends |
|-------|------|---------|---------|
| **0** | Cohesive shell & focus collapse | One shell; MC + Agents lenses; host chips; terminal-first stage; kill focus/zen confusion | — |
| **1** | Multi-device selection | Per-user shared selection; phone stage; push deep-links | Phase 0 |
| **2** | herdr feature kit | Pins-as-grammar, notes surface, launch presets, sorts/filters, calm chrome | Phase 0 (parallelizable with 1 after 0 lands) |
| **3** | Project splits | Real split layouts on project; zoom; shell leaves; layout persistence | Phase 0; agentd layout wire-up |
| **4** | Polish & migration | Defaults, empty states, a11y, perf, docs, kill dead modes | 0–3 |

Suggested shipping milestones:

- **M1** = Phase 0 (flow fixed; desk usable as herdr-like flock)
- **M2** = Phase 0 + 1 (phone + multi-device)
- **M3** = M2 + Phase 2 kit
- **M4** = M3 + Phase 3 splits

---

## 5. Phase 0 — Cohesive shell & focus collapse

> Goal: stop rehoming the user. One shell, host scope, MC|Agents, terminal-first stage. Fix the focus mess.

### Task 0.1 — Spec the navigation state machine (doc + types)

**Why:** Without a single state machine, we keep reintroducing focus/grid/zen.

**Scope:**
- Document transitions in this file (§3.3) as authoritative.
- Add shared TypeScript types for shell nav (web store first; promote to `@flock/shared` if orchestrator needs them in Phase 1).

**Approach:**
- New module e.g. `apps/web/src/shell/navState.ts` with pure helpers: `openAgent`, `setHostScope`, `setLens`, `pathFromNav`, `navFromPath`.
- Unit-test pure transitions before wiring React.

**Success criteria:**
- Pure functions cover D1–D5 transitions with table-driven tests.
- No `zenMode` / `viewMode` in the new public nav API.

**Tests:** `navState.test.ts` — MC click → lens agents + selection; host all default; tools open/close; logo → mission without clearing selection.

**Validation:** Code review against §3.3.

**Deps:** none  
**Risk:** low

- [x] 0.1

---

### Task 0.2 — Replace `viewMode` + `zenMode` with stage model in the store

**Why:** This is the cohesion bug. Two booleans and a dual mode created three products.

**Scope:**
- `store/paddock.ts` (or successor `shellStore.ts`): remove user-facing `viewMode` and `zenMode`.
- Introduce:
  - `lens: 'mission' | 'agents'`
  - `hostScope: HostScope`
  - `chrome: 'stage' | 'tools'`
  - `selectedSessionId`, `activeProjectId` (keep/adapt)
  - `openAgent(id)`, `openMission()`, `setHostScope`, `setChrome`
- Migrate all call sites: `focusSession` → `openAgent`; `setViewMode('grid')` → open project layout / `chrome` + multi-leaf; `toggleZen` → `setChrome('stage')` / expand tools.

**Approach:**
- Incremental: keep temporary shims that map old names → new for one PR if needed, delete shims in same phase.
- Default: `lens=mission`, `hostScope=all`, `chrome=stage`.

**Success criteria:**
- Grep shows no production use of `zenMode` / `viewMode` / `focusSession` (tests updated).
- Opening an agent never toggles a “zen world rebuild.”

**Tests:** store unit tests; update `router.test.ts`, `usePaddockCommands.test.ts`, `SessionPane` / `GridView` tests.

**Validation:** Manual: open agent from MC, from sidebar, from palette — same chrome density.

**Deps:** 0.1  
**Risk:** medium (wide call-site churn)

- [x] 0.2

---

### Task 0.3 — One shell layout: host chips + lenses + stage

**Why:** Visual/product expression of the state machine.

**Scope:**
- Redesign top region: host chips + lens tabs + account/settings.
- Left: switcher content by lens (MC summary list **or** Agents list — MC full dashboard can still use center when `selectedSessionId == null`).
- Center: **always** Stage component (empty state when no selection).
- Right: tools only when `chrome === 'tools'`.

**Approach:**
- New components under `apps/web/src/features/shell/`:
  - `Shell.tsx`, `HostChips.tsx`, `LensTabs.tsx`, `Stage.tsx`, `StageHeader.tsx`, `Switcher.tsx`
- Reuse Mission Control cards content inside lens=mission (either left denser list + center board, or full-center board when no selection — prefer: **no selection → MC board in center; selection → stage in center + MC becomes left summary** OR left always switcher and center swaps empty/MC/stage — pick one in implementation and document).

**Recommended layout resolution (lock this in 0.3):**

| Condition | Left | Center |
|-----------|------|--------|
| `lens=mission` && no selection | Host-scoped MC lanes (compact) | Full Mission Control board |
| `lens=mission` && selection | MC attention list | Stage (terminal-first) |
| `lens=agents` && no selection | Agents list | Empty stage / last project layout |
| `lens=agents` && selection | Agents list (row active) | Stage |

Click MC card: selection set, lens→agents, center stage (D2).

**Success criteria:**
- Never unmount whole app shell when opening an agent.
- Terminal keep-mounted still holds (no PTY thrash on lens switch).

**Tests:** component tests for Shell layout branches; Playwright smoke if present.

**Validation:** Desktop walkthrough checklist §9.1.

**Deps:** 0.2  
**Risk:** medium-high (UI surface area)

- [x] 0.3

---

### Task 0.4 — Host chips (All + per-node + pool)

**Why:** Multi-server should feel like herdr multi-bridge, not tree archaeology.

**Scope:**
- Chips for `All`, each node (name + connection color), optional pool grouping.
- Scope filters MC + Agents lists + counts.
- Node manage remains in Settings / long-press chip menu (edit, info).

**Approach:**
- Derive chips from `useNodes()` + connection health from agentd health map.
- Persist last `hostScope` in localStorage (per browser); Phase 1 may sync per-user.

**Success criteria:**
- All hosts default (D1).
- Selecting a host filters lists; “All” restores.
- Attention badges on chips (count of awaiting_input+error in scope).

**Tests:** pure filter helpers; HostChips component tests.

**Validation:** Two nodes with agents; chip filter correctness.

**Deps:** 0.3  
**Risk:** low-medium

- [x] 0.4

---

### Task 0.5 — Agents lens (herdr switcher grammar)

**Why:** Agents must be first-class open path, not only tree leaves.

**Scope:**
- Flat list of open sessions in host scope.
- Sort: attention (default) | status | lastStatusChange | project | node.
- Filter: pinned only | active only (working/blocked/done/error).
- Group: none | node | project | node+project.
- Row: status dot, agent icon/type, title, meta (node · project · cwd), pin, loud status word when applicable.
- Click → `openAgent`.
- Context menu: pin, terminate, open tools, handoff (existing), copy id.

**Approach:**
- New `features/shell/AgentsSwitcher.tsx`; reuse attention ordering from `@flock/shared` / `ordering.ts`.
- Last-status-change may stub to `updatedAt` until Phase 2 activity API.

**Success criteria:**
- Can supervise without expanding the node tree.
- Pinned sessions sort first when pins exist (use existing `session.pinned`).

**Tests:** sort/filter/group pure functions; row interaction tests.

**Validation:** Fleet with 5+ sessions across 2 nodes.

**Deps:** 0.3  
**Risk:** low-medium

- [x] 0.5

---

### Task 0.6 — Terminal-first Stage (zen-as-default)

**Why:** D5 — cockpit chrome is the herdr gap.

**Scope:**
- `StageHeader`: breadcrumb `node · project · agent`, status badge, pin, open-tools, split (stub until Phase 3), zoom (stub ok), refit if needed.
- Terminal area: existing xterm stack; RespondBar when `awaiting_input`.
- **No** auto-open right panel on status/tool (remove or gate behind settings `assistivePanels: false` default **off**).
- BottomBar: hide or collapse in `chrome=stage`; show compact status in header instead.
- Shell drawer (⌘J): keep, but do not steal default focus.

**Approach:**
- Delete adaptive auto-open effects in `SessionPane` (or move behind flag default false).
- Stage is the center component; GridView becomes “layout renderer” used by Stage (single leaf until Phase 3).

**Success criteria:**
- Fresh open agent: terminal dominates; no right panel; no bottom telemetry wall.
- User can open tools explicitly; state persists per session optional later.

**Tests:** Stage render tests; ensure adaptive effects not firing by default.

**Validation:** Side-by-side with herdr-web stage feel checklist §9.2.

**Deps:** 0.3  
**Risk:** medium (power users liked adaptive panels — document setting)

- [x] 0.6

---

### Task 0.7 — Mission Control as lens (not a hard cut)

**Why:** D1 + D2 without “leaving” the app.

**Scope:**
- Refactor `FleetView` / `MissionControl` to work inside shell (§0.3 table).
- Remove center replacement that drops stage mount when possible; if MC board needs full center, still keep terminal provider mounted offscreen/hidden for selected sessions to avoid PTY thrash — **or** accept remount only when selection null (document tradeoff).

**Approach:**
- Prefer keep-mounted terminals for sessions that are selected or in active project layout.
- MC click handlers call `openAgent` only.

**Success criteria:**
- D1 home = MC all hosts.
- D2 click → Agents lens + stage.
- Browser back/forward sane (0.8).

**Tests:** update MissionControl tests for `openAgent`.

**Validation:** §9.1 flows A–C.

**Deps:** 0.3, 0.5, 0.6  
**Risk:** medium

- [x] 0.7

---

### Task 0.8 — URL model aligned to shell

**Why:** Four URL kinds taught four apps.

**Scope:** Propose and implement:

| Path | Meaning |
|------|---------|
| `/` | Mission Control, all hosts (or restore hostScope from storage) |
| `/agents` | Agents lens |
| `/agents/:sessionId` | Agents + selection |
| `/s/:sessionId` | **Redirect** to `/agents/:sessionId` (compat) |
| `/p/:projectId` | Agents + active project (layout stage) |
| `/n/:nodeId` | hostScope=node (MC or agents via query `?lens=`) |
| `/settings...` | unchanged |

**Approach:**
- Update `router.tsx` `pathToNav` / `navToPath`.
- Preserve shareable links.

**Success criteria:**
- Old `/s/:id` links still work.
- URL always recoverable to shell state.

**Tests:** router unit tests expanded.

**Validation:** copy-paste URLs across browsers.

**Deps:** 0.2  
**Risk:** low-medium

- [x] 0.8

---

### Task 0.9 — Demote inventory tree

**Why:** Tree is inventory, not the main find path.

**Scope:**
- Move Node→Project→Session tree to:
  - “Browse” section under Agents, **or**
  - Settings → Nodes, **or**
  - collapsible “Inventory” at bottom of switcher.
- Keep drag reorder / create actions reachable (⌘K + + menu).

**Approach:**
- Don’t delete tree code first; re-home Sidebar content.

**Success criteria:**
- New users can run day-to-day without opening inventory.
- Power users still manage nodes/projects.

**Tests:** smoke; command palette still creates.

**Validation:** create node/project/session from + and ⌘K.

**Deps:** 0.5  
**Risk:** low

- [x] 0.9

---

### Task 0.10 — Kill auto-focus single session / fix empty states

**Why:** Auto-focus fights “home = MC” and intentional empty stage.

**Scope:**
- Remove or severely gate `useAutoFocusSingleSession`.
- Empty states: MC empty (add node CTA); Agents empty (launch CTA); Stage empty (pick an agent).

**Success criteria:**
- Landing with one session still shows MC first (D1), not forced focus.
- Optional: “Resume last agent” explicit control.

**Tests:** Paddock/shell tests for no auto focus.

**Validation:** fresh login with 0, 1, N sessions.

**Deps:** 0.2, 0.7  
**Risk:** low

- [x] 0.10

---

### Task 0.11 — Phase 0 regression & docs

**Why:** Land M1 safely.

**Scope:**
- Update README screenshots/flow blurb if needed.
- Note in architecture.md shell section.
- Checklist §9.1 green.
- Fix flaky tests from store rename.

**Success criteria:** CI green; manual §9.1 pass.

**Deps:** 0.1–0.10  
**Risk:** low

- [x] 0.11

---

## 6. Phase 1 — Multi-device selection (per-user)

> Goal: desk + phone share “what I’m looking at.” People on the go.

### Task 1.1 — API: per-user fleet selection

**Why:** Selection is currently local Zustand only.

**Scope:**
- `GET/PUT /api/me/selection` (or `/api/users/me/fleet-selection`)
- Body: `{ selectedSessionId, activeProjectId, hostScope, lens?, updatedAt }`
- Auth required; only owner reads/writes.
- Postgres table `user_fleet_selection` (user_id PK, jsonb payload, updated_at).

**Approach:**
- Orchestrator service + Drizzle migration.
- Validate session/project still exist; clear if deleted.

**Success criteria:**
- Two clients: PUT from A, GET from B sees it.
- Unauthorized access denied.

**Tests:** orchestrator route tests; validation tests.

**Validation:** curl + two browsers.

**Deps:** Phase 0 nav fields stable  
**Risk:** low-medium

- [x] 1.1

---

### Task 1.2 — WebSocket fan-out for selection

**Why:** Polling is too slow for phone↔desk.

**Scope:**
- Channel e.g. `user:<id>:selection` on existing status/live WS or dedicated.
- Event: `fleet_selection_changed`.
- Last-write-wins by `updatedAt`.

**Approach:**
- On PUT, fan-out to user’s connections.
- Client applies if remote `updatedAt` > local.

**Success criteria:**
- Change on desk updates phone &lt; 500ms typical LAN.
- No cross-user leakage.

**Tests:** unit for LWW merge; integration if harness exists.

**Validation:** two browsers same user.

**Deps:** 1.1  
**Risk:** medium (WS authz already present — reuse)

- [x] 1.2

---

### Task 1.3 — Client follow behavior

**Why:** Wire UI to API.

**Scope:**
- On `openAgent` / host/lens changes that affect selection: debounce PUT.
- Subscribe to WS; apply remote.
- Setting: “Sync selection across my devices” default **on**.
- Conflict: local edit within 1s of remote — prefer local (or LWW only — document).

**Success criteria:**
- Follow feels like herdr multi-client pane selection.
- Disable toggle stops applying remote (still may write if desired — prefer stop both).

**Tests:** client merge helpers.

**Validation:** §9.3 multi-device.

**Deps:** 1.2, Phase 0  
**Risk:** medium

- [x] 1.3

---

### Task 1.4 — Phone as Stage, not only inbox

**Why:** PhoneView is triage-only today.

**Scope:**
- Compact shell: Agents list ↔ Stage detail (history back).
- Stage: terminal + RespondBar + **stage/send** + **key strip** (Esc, Ctrl, Tab, arrows, Enter).
- Attention sort default; host chips collapse to “All / current.”
- Push notification click → open `/agents/:sessionId` with selection sync.

**Approach:**
- Borrow patterns from herdr-web `TerminalView` mobile controls / `mobileTerminalPrefs` (ideas, not copy-paste).
- Reuse xterm; touch selection v1 can be basic copy.

**Success criteria:**
- Unblock agent from phone by typing in stage/send without desktop.
- Shared selection: phone open pulls desk (if follow on).

**Tests:** mobile control unit tests; ResponsiveShell tests.

**Validation:** real phone or DevTools device mode + push if configured.

**Deps:** 1.3, 0.6  
**Risk:** high (touch terminal UX)

- [x] 1.4

---

### Task 1.5 — Push deep-link alignment

**Why:** Push today may not land in the new shell.

**Scope:**
- Ensure notification payloads include `sessionId` and open Agents+stage route.
- Selecting from push updates fleet selection.

**Success criteria:**
- Click push → correct agent stage on phone/desktop.

**Tests:** payload builder unit tests.

**Validation:** live push if VAPID configured.

**Deps:** 1.4, 0.8  
**Risk:** low

- [x] 1.5

---

## 7. Phase 2 — herdr feature kit

> Goal: pins, notes, presets, sorts — the daily grammar.

### Task 2.1 — Pins as list grammar

**Why:** Pin exists on session (`pinned`) but isn’t the Agents list primary grammar.

**Scope:**
- Pin control on Agents row + Stage header.
- Pinned-first ordering; “Pinned only” filter.
- Optional: pin does not change attention sort within pinned tier.

**Success criteria:**
- Pin persists via existing PATCH session API.
- Visible across devices (server field — already is).

**Tests:** ordering tests with pinned.

**Validation:** pin on desk, see on phone.

**Deps:** 0.5  
**Risk:** low

- [x] 2.1

---

### Task 2.2 — Notes surface (markdown)

**Why:** Session `note` is a short string; herdr notes are ops memory.

**Scope:**
- Extend note capacity or add `session_notes` table: markdown body, revision, updatedAt.
- UI: Notes mode in switcher **or** tools tab Notes; markdown preview; autosave.
- List notes by session; filter unresolved.

**Approach:**
- Start by upgrading the existing `note` field UX (markdown textarea + preview) before full multi-note if timeboxed.
- Full multi-note (attach/archive) as 2.2b if needed.

**Success criteria:**
- Write note on agent; see on other device; markdown renders.

**Tests:** API + UI save/conflict if revision used.

**Validation:** handoff scenario — note explains context.

**Deps:** Phase 0 shell tools  
**Risk:** medium

- [x] 2.2

---

### Task 2.3 — Launch presets

**Why:** Reduce launch friction to herdr dialog speed.

**Scope:**
- Preset: `{ id, name, agentType, permissionMode?, worktreeDefault?, systemPrompt?, env? }`
- Storage: per-user in DB (or server config file for self-host defaults) + built-in defaults (Claude, Codex, OpenCode, Gemini, Grok, Shell/terminal).
- Quick Launch dialog: preset + title/note + target project (default active) + open mode: focus leaf | split (Phase 3) | background.

**Approach:**
- `GET/PUT /api/me/launcher-presets`
- UI: LaunchDialog redesign; ⌘N / + button.

**Success criteria:**
- Two-click launch from Agents with default project.
- Unavailable agent types greyed using node detected CLIs.

**Tests:** preset CRUD; dialog tests.

**Validation:** launch each first-class agent type on local node.

**Deps:** 0.5  
**Risk:** low-medium

- [x] 2.3

---

### Task 2.4 — Last status change + agent activity timestamps

**Why:** herdr sort “last status change” is excellent for “what just happened.”

**Scope:**
- Track `lastStatusTransitionAt` per session in orchestrator status map (on status change only).
- Expose on status WS frame + REST.
- Agents sort option uses it.

**Approach:**
- Mirror herdr efficiency idea: don’t full-refresh tree for this; piggyback status frames.

**Success criteria:**
- Sort shows recently blocked agents first when using that sort.

**Tests:** status map transition timestamp tests.

**Validation:** force awaiting_input; verify sort.

**Deps:** 0.5  
**Risk:** low

- [x] 2.4

---

### Task 2.5 — Calm list chrome + display status map

**Why:** Busy rows feel less herdr.

**Scope:**
- Implement display map §3.7.
- Loud words only for blocked/working/done/error/disconnected.
- Agent icons for major types (Claude/Codex/OpenCode/Gemini/Grok).

**Success criteria:**
- Idle rows quiet; attention rows obvious.

**Tests:** pure display helpers.

**Validation:** visual pass light+dark.

**Deps:** 0.5  
**Risk:** low

- [x] 2.5

---

### Task 2.6 — Assistive panels setting

**Why:** Power users may want old adaptive panel behavior.

**Scope:**
- Settings → Appearance/Behavior: “Auto-open tools from agent activity” default **off**.
- When on, restore previous adaptive chat/diff/browser behavior.

**Success criteria:**
- Default matches D5; opt-in restores cockpit assist.

**Tests:** setting respected in Stage effects.

**Deps:** 0.6  
**Risk:** low

- [x] 2.6

---

## 8. Phase 3 — Project splits

> Goal: real multiplexer-style layouts for a project-on-node space.

### Task 3.1 — Layout schema & shared types

**Why:** Need a versioned layout document.

**Scope:**
```ts
type ProjectLayoutV1 = {
  version: 1;
  projectId: string;
  focusedLeafId: string;
  zoomedLeafId?: string | null;
  root: LayoutNode;
};
type LayoutNode =
  | { type: 'split'; id: string; direction: 'row' | 'col'; ratio: number; a: LayoutNode; b: LayoutNode }
  | { type: 'leaf'; id: string; kind: 'session' | 'shell'; sessionId?: string; shellKey?: string };
```

**Approach:** Zod in `@flock/shared`; reject unknown version gracefully.

**Success criteria:** parse/serialize tests; default layout = single leaf for one session.

**Deps:** Phase 0  
**Risk:** low

- [x] 3.1

---

### Task 3.2 — Persist layout via agentd + orchestrator mirror

**Why:** agentd layout store exists; multi-client needs orchestrator awareness.

**Scope:**
- Workspace key = `projectId`.
- On layout change: write agentd `layout set`; also `PUT /api/projects/:id/layout` for mirror + fan-out.
- On open project: prefer live agentd get; fallback orchestrator; fallback default from open sessions list.

**Approach:**
- Confirm agentd protocol ops (`layout` control frames) wired through orchestrator agentd client.
- If not fully exposed to REST, add thin routes.

**Success criteria:**
- Restart agentd: layout restored.
- Restart browser: layout restored.
- Two viewers same user: layout updates (fan-out; can be Phase 3.5 if hard).

**Tests:** agentd layout tests already exist — extend; orchestrator route tests.

**Validation:** split, restart daemon, reconnect.

**Deps:** 3.1  
**Risk:** medium-high

- [x] 3.2

---

### Task 3.3 — Stage split renderer

**Why:** UI for layout tree.

**Scope:**
- Render split panes with draggable dividers; each leaf hosts keep-mounted terminal.
- Zoom leaf; Esc unzoom.
- Selected leaf gets input focus + stage header context.
- Tab strip optional for &gt;3 leaves.

**Approach:**
- Replace pure GridView columns mode as the layout renderer, or evolve GridView into `ProjectLayoutView`.
- Geometry CSS grid/flex from tree ratios (herdr uses absolute rects — either works; prefer flex ratios for simplicity).

**Success criteria:**
- Two agents side-by-side in one project; both stream; focus switches on click.
- No PTY reconnect when rearranging ratios.

**Tests:** layout math pure tests; component tests with mock terminals.

**Validation:** §9.4 splits.

**Deps:** 3.1, 0.6  
**Risk:** high

- [x] 3.3

---

### Task 3.4 — Split actions & launch into layout

**Why:** Creating splits must be easy.

**Scope:**
- Stage header: split right / split down.
- Opens Launch preset dialog targeting new leaf in layout.
- Close leaf: remove from layout; optional terminate session confirm.
- Move leaf (later): nice-to-have; track as 3.4b.

**Success criteria:**
- From one agent, split + launch second agent in same project worktree or new worktree.

**Tests:** layout mutation reducers (pure).

**Validation:** manual dual-agent coding session.

**Deps:** 3.3, 2.3  
**Risk:** medium

- [x] 3.4

---

### Task 3.5 — Shell leaves in layout

**Why:** Human shell beside agent without only bottom drawer.

**Scope:**
- Leaf kind `shell` reuses shell PTY channel.
- ⌘J can still toggle a drawer **or** focus shell leaf — pick: **prefer layout leaf**; drawer becomes optional legacy.

**Success criteria:**
- Shell leaf in split next to agent; independent PTY.

**Tests:** shell leaf id stability.

**Validation:** run git status in shell leaf while agent runs.

**Deps:** 3.3  
**Risk:** medium

- [x] 3.5

---

### Task 3.6 — Constraints & empty project layout

**Why:** Edge cases.

**Scope:**
- Layout only contains sessions belonging to that project.
- On session terminate: prune leaf; if focused, focus sibling.
- Project with 0 sessions: empty stage + launch CTA.
- Cross-project drag forbidden (D4).

**Success criteria:**
- No orphan leaves; no cross-project splits.

**Tests:** prune/repair layout pure functions.

**Deps:** 3.3  
**Risk:** low-medium

- [x] 3.6

---

## 9. Phase 4 — Polish, migration, cleanup

### Task 4.1 — Remove dead code paths

**Scope:** Delete unused focus/zen branches, obsolete PhoneView-only paths if replaced, dead CSS.  
**Success:** bundle smaller; no dead exports.  
**Deps:** 0–3 landed  
- [x] 4.1

### Task 4.2 — Onboarding / empty fleet

**Scope:** First-run: add node → project → launch preset → lands Agents+stage. MC explains host chips once.  
**Deps:** 0.7, 2.3  
- [x] 4.2

### Task 4.3 — A11y & keyboard map

**Scope:** Document shortcuts; lens switch; host cycle; agent cycle (attention order); split nav (hjkl or arrows). Match herdr-ish power keys where it doesn’t fight existing ⌘K/⌘J.  
**Tests:** keyboard handler unit tests.  
- [x] 4.3

### Task 4.4 — Performance budget

**Scope:** Keep-mounted terminals: cap simultaneous live xterms (e.g. 6) with scrollback freeze for hidden; status WS still for all. Measure with 20 sessions.  
**Success:** UI usable; CPU not pegged on idle fleet.  
- [x] 4.4

### Task 4.5 — Docs & changelog

**Scope:** architecture.md shell section; README user flow; this plan checkboxes; CHANGELOG user-facing notes.  
- [x] 4.5

### Task 4.6 — Design tokens pass

**Scope:** Align stage/list density with [design-tokens.md](design-tokens.md); light/dark; status colors consistent with display map.  
- [x] 4.6

---

## 10. Data & API summary

### 10.1 New / extended APIs

| API | Phase | Purpose |
|-----|-------|---------|
| `GET/PUT /api/me/selection` | 1 | Per-user fleet selection |
| WS `fleet_selection_changed` | 1 | Live follow |
| `GET/PUT /api/me/launcher-presets` | 2 | Launch presets |
| `GET/PUT /api/projects/:id/layout` | 3 | Layout mirror + fan-out |
| agentd layout get/set (existing) | 3 | Node-authoritative layout bytes |
| Session note markdown upgrade | 2 | Notes |
| Status frame `lastStatusTransitionAt` | 2 | Sort key |

### 10.2 Store migration (web)

| Remove / demote | Replace with |
|-----------------|--------------|
| `viewMode: 'focus'\|'grid'` | layout + selection + zoom |
| `zenMode` | `chrome: 'stage'\|'tools'` (stage default) |
| `focusSession` | `openAgent` |
| `view: 'overview'\|'paddock'` hard cut | `lens: 'mission'\|'agents'` inside one shell |
| `useAutoFocusSingleSession` | explicit resume / none |

### 10.3 DB tables (proposed)

```
user_fleet_selection (
  user_id PK REFERENCES users,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
)

user_launcher_presets (
  user_id PK,
  presets JSONB NOT NULL,
  updated_at TIMESTAMPTZ
)

project_layouts (
  project_id PK REFERENCES projects,
  layout JSONB NOT NULL,
  updated_at TIMESTAMPTZ
)

-- optional if multi-note:
session_notes (
  id UUID PK,
  session_id REFERENCES agent_sessions,
  body TEXT,
  revision INT,
  archived_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
```

---

## 11. Testing strategy

### 11.1 Layers

| Layer | What |
|-------|------|
| **Pure unit** | nav state machine, sort/filter/group, layout reducers, LWW selection merge, display status map |
| **Component** | HostChips, AgentsSwitcher, StageHeader, Shell layout branches |
| **Orchestrator** | selection routes, presets, layout routes, authz |
| **agentd** | layout persistence (existing + extend) |
| **Integration / e2e** | Playwright: login → MC → open agent → tools → back to MC lens |
| **Manual device** | Phone stage/send; two-browser selection follow |
| **Live agents** | Launch presets against real CLIs on local node |

### 11.2 Definition of Done (per task)

1. Tests listed in task exist and pass.
2. No new lint baseline debt without note.
3. Manual validation bullets for that task checked.
4. This plan checkbox updated.
5. User-facing change mentioned for CHANGELOG if relevant.
6. Invariants respected (PTY any-agent; node source of truth).

### 11.3 Regression suites to always run on shell PRs

```bash
# from flock/
pnpm test --filter @flock/web
pnpm test --filter @flock/orchestrator   # when API touched
pnpm test --filter @flock/shared
# agentd when layout touched:
(cd agentd && go test ./...)
```

(Adjust package names to match repo.)

---

## 12. Validation checklists

### 12.1 Phase 0 — Flow (§9.1)

- [x] **A.** Fresh login → Mission Control, All hosts.
- [x] **B.** Click needs-you card → Agents lens + terminal stage; tools closed.
- [x] **C.** Logo/MC lens → left/board mission; selection preserved; stage still available when selected.
- [x] **D.** Host chip filters lists; All restores.
- [x] **E.** Agents: pin, sort, filter active, open agent.
- [x] **F.** Open tools → right panel; close → terminal-first again.
- [x] **G.** No whole-app unmount flash when opening agents.
- [x] **H.** Old `/s/:id` URL still opens agent.
- [x] **I.** ⌘K create session still works.
- [x] **J.** Light + dark theme both readable.

### 12.2 Stage feel (§9.2)

- [x] Terminal is the dominant visual.
- [x] Header is thin; status clear.
- [x] RespondBar only when awaiting input.
- [x] No surprise panel auto-open (default).
- [x] Typing in terminal feels immediate.

### 12.3 Multi-device (§9.3)

- [x] Desk select → phone follows.
- [x] Phone select → desk follows.
- [x] Toggle off follow → independence.
- [x] Push opens correct agent.
- [x] Stage/send + keys unblock `awaiting_input` on phone.

### 12.4 Splits (§9.4)

- [x] Split right launches second agent same project.
- [x] Both stream; click focuses input.
- [x] Reload browser restores layout.
- [x] Restart agentd restores layout.
- [x] Terminate one leaf repairs layout.
- [x] Cannot split across projects.

### 12.5 Feature kit (§9.5)

- [x] Pins order Agents list.
- [x] Notes save and render markdown.
- [x] Launch preset two-click path.
- [x] Last status change sort works.
- [x] Calm loudness on idle vs blocked.

---

## 13. Risk register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Wide UI churn breaks power-user muscle memory | High | Phase 0 shims; command palette aliases; changelog; assistive panels opt-in |
| Keep-mounted terminals memory blowup | High | Cap live terms; freeze hidden buffers (4.4) |
| Selection WS loops / feedback | Medium | LWW + ignore echo of own write id |
| Layout desync agentd vs orchestrator | Medium | Single write path; version field; repair on read |
| Mobile terminal quality | High | Iterate on stage/send; don’t block desk on perfect touch selection |
| Scope creep into team collab | Medium | Hard non-goal; per-user only |
| Adaptive panel fans angry | Low | Setting 2.6 |
| Parallel roadmap ACP work conflicts | Medium | Shell track avoids ACP internals; coordinate on SessionPane |

---

## 14. Dependency graph (simplified)

```
0.1 nav types
  └─ 0.2 store rewrite
       ├─ 0.8 URLs
       ├─ 0.3 shell layout
       │    ├─ 0.4 host chips
       │    ├─ 0.5 agents lens
       │    ├─ 0.6 stage terminal-first
       │    └─ 0.7 MC as lens
       ├─ 0.9 demote tree
       └─ 0.10 kill auto-focus
            └─ 0.11 phase0 ship (M1)

0.2 ─┬─ 1.1 selection API ─ 1.2 WS ─ 1.3 client ─ 1.4 phone stage ─ 1.5 push (M2)
     │
     ├─ 2.1 pins, 2.3 presets, 2.4 activity, 2.5 calm, 2.6 assist  (kit)
     │         └─ 2.2 notes
     │
     └─ 3.1 layout types ─ 3.2 persist ─ 3.3 renderer ─ 3.4 launch split
                                  └─ 3.5 shell leaves ─ 3.6 constraints (M4)

4.x polish after M3/M4
```

---

## 15. Mapping to existing code (anchor points)

| Area | Current | Direction |
|------|---------|-----------|
| UI store | `apps/web/src/store/paddock.ts` | Shell nav fields; delete zen/viewMode |
| Assembly | `apps/web/src/app/Paddock.tsx` | Single shell; no zen branch tree rebuild |
| Router | `apps/web/src/app/router.tsx` | §0.8 paths |
| MC | `features/overview/MissionControl.tsx` | Lens content; `openAgent` |
| Tree | `features/paddock/Sidebar.tsx` | Inventory demotion |
| Center | `features/paddock/SessionPane.tsx` | Become Stage; remove adaptive default |
| Grid | `features/paddock/GridView.tsx` | Evolve to layout renderer |
| Phone | `features/responsive/PhoneView.tsx` | Stage + list, not inbox-only |
| Terminal | `features/terminal/*` | Keep; mobile controls added |
| Status | `features/paddock/liveData.tsx`, shared `status.ts` | + lastStatusTransitionAt |
| Session pin/note | `packages/shared` domain + PATCH | Extend note; pins grammar |
| agentd layout | `agentd/internal/layout` | Project layouts |
| agentd server | layout get/set control ops | Wire through orchestrator |
| Orchestrate/race | keep | Race becomes special multi-leaf layout later |

---

## 16. Focus cohesion — explicit “before / after”

### Before (broken story)

```
User: "I want to focus on this agent."
Flock: Do you mean viewMode focus, zenMode, or focusSession()?
Also: should the right panel auto-open? Should we leave Mission Control?
Also: is grid still mounted under you?
```

### After (one story)

```
User: opens an agent.
Flock: selection = that agent; lens = Agents; chrome = stage (terminal).
User: needs git.
Flock: chrome = tools; Code tab.
User: needs two agents.
Flock: project layout split; both leaves live; selection = input target.
User: on phone.
Flock: same selection; stage/send.
```

**No separate “focus mode.”** Stage is always the place you drive agents; density changes, destination doesn’t.

---

## 17. Suggested implementation order for the first week

If starting immediately after this doc:

1. **0.1** nav pure module + tests (½–1 day)  
2. **0.2** store rewrite + fix compile (1–2 days)  
3. **0.8** URLs (½ day)  
4. **0.6** Stage terminal-first + kill adaptive default (1 day)  
5. **0.3 + 0.7** shell frame + MC lens wiring (2 days)  
6. **0.4 + 0.5** host chips + Agents list (1–2 days)  
7. **0.9 + 0.10 + 0.11** cleanup and ship M1  

Then Phase 1 selection API in parallel with Phase 2 pins/presets.

---

## 18. Open questions (non-blocking; decide in PRs)

1. MC with selection: left compact list vs keep full board above stage (split height)? **Default proposal:** left list + stage (more herdr).  
2. BottomBar fully hidden in stage chrome vs single-line status? **Default:** hide; status in StageHeader.  
3. Shell drawer vs shell leaf priority after Phase 3? **Default:** layout leaf primary; drawer remains shortcut to focus/create shell leaf.  
4. Should `hostScope` sync in per-user selection payload? **Default:** yes.  
5. Race/Compare integration with layouts — defer until after 3.4 unless trivial.

---

## 19. Success metrics (product)

After M2, the product should pass these qualitative tests:

1. **Stranger test:** New user finds a blocked agent and unblocks it without using the inventory tree.  
2. **herdr familiarity:** Daily motion is list → stage → type.  
3. **Flock power retained:** Multi-node, git, browser, push, worktrees still reachable within 2 clicks from stage tools.  
4. **Phone test:** Away from desk, unblock + brief steer via stage/send.  
5. **Cohesion test:** Nobody asks “what does Focus mean?” — the word is gone or means only “selected leaf.”

---

## 20. Changelog stub (for future releases)

```markdown
## [Unreleased]

### Added
- Host chips and Mission Control | Agents shell lenses
- Per-user multi-device selection sync
- Agents switcher (sort/filter/group/pin)
- Launch presets
- Project split layouts
- Mobile stage/send and key strip

### Changed
- Terminal-first stage is the default (tools opt-in)
- Mission Control no longer replaces the whole app shell
- URLs simplified to /agents/:sessionId (compat redirects)

### Removed
- Dual focus/zen mode confusion (unified stage model)
- Auto-focus single session on load
- Default adaptive right-panel hijack
```

---

## 21. Appendix — herdr-web reference map

| herdr-web | Flock target |
|-----------|--------------|
| Bridge host chips | Node host chips |
| Sidebar Agents | Agents lens |
| Sidebar Tabs | Project layout / inventory (secondary) |
| Stage + TerminalView | Stage + xterm |
| `/ws/activity` status deltas | Existing status WS + lastStatusTransitionAt |
| `/api/selection` | Per-user `/api/me/selection` |
| LaunchDialog + presets | Launch presets + quick launch |
| Pins / notes | Session pin grammar + notes surface |
| Mobile stage/send | Phone stage |
| Split grid from LayoutSnapshot | ProjectLayoutV1 renderer |
| No MC | Keep MC as lens (Flock advantage) |

---

*End of plan. Work phases 0→4; keep this file’s checkboxes current.*


## Deviations
- Selection cold-start: GET/hydrate first; never PUT empty home over remote (lastSyncedKey protocol).
- Multi-device selection uses REST poll (2.5s) via FleetSelectionSync, not a dedicated WS channel.
- Shell leaves in splits are placeholders; session leaves are fully wired.
- Launch-into-split from stage header is not a separate control — new sessions reconcile into layout.
