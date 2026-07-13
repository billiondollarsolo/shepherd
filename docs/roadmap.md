# Shepherd — Elite Web Platform Roadmap & Execution Plan

> **Audience:** the engineering team (human or AI agents) building Shepherd from its current
> state into the elite, web-native agent **operations** platform.
> **Status:** authoritative forward plan. Supersedes ad-hoc planning.
> **Companion docs:** [architecture.md](architecture.md) (current system),
> [agent-integration-matrix.md](agent-integration-matrix.md) (per-agent capture),
> [flock-agentd-design.md](flock-agentd-design.md) (the node daemon). Appendix A
> condenses the Synara competitive analysis that motivated this plan.

---

## 0. How to use this document

This is a build plan, not prose. Work it like this:

1. **Pick the lowest-numbered unblocked task** in the current phase (respect the
   dependency graph, §8). Phases are ordered; **Phase 0 (Foundation) gates everything.**
2. **One task = one branch = one PR.** Keep PRs small and reviewable.
3. **TDD by default.** Write the failing test from the task's _Success criteria_ first,
   then implement. Every task lists the tests it must add/extend.
4. **Pass every gate before merge** (§3, _Definition of Done_). No exceptions, including
   greenfield. "Greenfield" means we move fast and break our _own_ assumptions — never
   the test gates.
5. **Validate on live nodes** where a task touches `agentd` or an agent integration
   (§3). Doc-only or unvalidated changes to external-payload parsing are not "done."
6. **Update docs** (`agent-integration-matrix.md`, this file's checkboxes, relevant
   design docs) in the same PR.
7. **Never weaken the two invariants** in §2.

Each task has: **Why · Scope · Approach · Success criteria · Tests · Deps · Risk**.
Check the box when merged + validated.

---

## 1. Vision

Shepherd is the **operations platform for coding agents** — run, supervise, and direct a
fleet of agents across any number of machines, from any browser or phone, as an
individual or a team.

Today Shepherd _observes_ agents (it watches their terminals and scrapes status). The
end state _directs_ them: a full control plane on a structured spine, **plus** the
web-native, fleet-native capabilities that a single-machine desktop tool structurally
cannot offer.

**Three strategic layers** (this plan's phases map to them):

- **Layer 0 — Foundation.** A typed end-to-end contract, event-sourced rebuildable
  state, resume cursors, and a **structured agent-I/O transport (ACP-first)** alongside
  the PTY. This is the leverage for everything above it.
- **Layer 1 — Per-session power (Synara superset).** Dual surface (terminal **and**
  structured chat), a full control plane (approve / answer / steer / switch model /
  inject / queue), handoff, the commit→push→PR loop, telemetry parity, more agents.
- **Layer 2 — The moat.** Teams/RBAC/SSO, shared & live-collaborative sessions,
  fleet orchestration (run-N-and-compare, cross-node handoff), mobile-first supervision,
  cost & policy governance, extensibility (MCP/skills/plugins), audit & observability.

The bet: **be a superset of the best desktop tool _and_ own the territory it can't reach.**

---

## 2. Invariants (never violate)

1. **Any agent works.** The raw PTY is the _universal fallback_: every CLI that draws to
   a terminal is a usable session on day one, with no integration. Structured transports
   (ACP/SDK) are the _rich path_, never a prerequisite. A change that drops "any-agent"
   support is rejected.
2. **The node is the source of truth; the client is a viewer.** Sessions live in
   `agentd` on always-on nodes and survive client _and_ orchestrator restarts. Postgres
   is the durable record, never on the live hot path. Nothing in this plan moves the data
   path onto the user's machine (no local-first / desktop pivot).

**Explicit non-goals:** desktop/Electron, local-first/SQLite, a full Effect-TS rewrite,
making ACP the _only_ transport. Borrow ideas, not the stack.

---

## 3. Engineering standards (baked into every task)

**Definition of Done (global gate — all must pass):**

```bash
pnpm typecheck                      # tsc across the monorepo — clean
pnpm lint                           # eslint — clean
pnpm test:unit                      # vitest: shared + orchestrator + web — all green
pnpm test:int                       # dockerized integration (Postgres + sshd) — green
pnpm build                          # every workspace builds
cd agentd && go build ./... && go vet ./... && go test -race ./...   # if agentd touched
pnpm test:e2e                       # Playwright — for web-surface changes
```

- **Baseline to preserve/grow:** unit ≈ shared 60 / orchestrator 639 / web 308;
  integration 83. A task may only _increase_ these. A red suite blocks merge.
- **Live validation:** any `agentd` or agent-integration task is validated on a Vagrant
  node (`vagrant/`) before "done" — capture a real payload, confirm the behavior
  end-to-end. Parsing of external agent output is **never** shipped on docs alone
  (tolerant parsers + a captured fixture).
- **Type safety:** `packages/shared` (Zod) is the single source of truth for every wire
  shape. No duplicated/hand-synced types across process boundaries (this is what F1 fixes
  permanently).
- **Tolerant parsers** for anything an external agent emits: accept both the documented
  and the empirically-observed shape; normalize internally; degrade to `null`/fallback,
  never throw.
- **Security:** no secret in the repo or in an image layer; auth on every UI/API/WS path
  (per-session token for the hook endpoint only); agentd control channel keeps its
  shared-secret + `0600` discipline; new endpoints get authz tests.
- **Feature flags** for anything risky on the live path; default off until validated, then
  flip and remove the flag in a follow-up.
- **`agentd` rollout:** bump `agentd/VERSION` → `make dist` → the orchestrator
  auto-re-ships to nodes on version mismatch → validate on vm-1 then vm-2. Keep the PTY
  path working throughout (Invariant 1).
- **Docs:** update `agent-integration-matrix.md` and this roadmap in the same PR.
- **Observability:** new subsystems emit structured logs + (where state-changing) audit
  rows; no silent truncation/caps — `log()` what was dropped.

---

## 4. Current baseline (starting point)

- **`agentd`** (Go): raw PTYs, framed binary protocol over SSH loopback / unix socket,
  transcript + hook tailing → status/telemetry, node + per-session metrics (RSS/CPU),
  versioned with auto-redeploy. Hand-written proto mirrored in TS.
- **`orchestrator`** (Fastify + Drizzle/Postgres): REST + WS, in-memory `StatusMap`
  (live truth), append-only `events` table (write-behind, off the hot path), per-agent
  hook endpoint + translators, SSH/agentd transport, web push, per-session browser,
  secret store, worktree-service.
- **`web`** (React/Vite/xterm.js/Zustand/TanStack): the "paddock" — node→project→session
  tree, focus + grid/hive terminals, status dots, telemetry bottom bar, source-control
  (diff + stage/commit/push), live plan artifact, activity timeline, node file browser,
  per-session browser screencast, ripgrep search, command-palette **shell** (mostly
  empty), per-session worktree toggle.
- **Agents (5):** claude-code, codex, opencode, gemini, grok — transcript + hooks →
  unified `Status` enum + telemetry. Tolerant parsers as of the 2026-06 audit.
- **Already shipped (do not re-plan):** per-session git worktrees, find-in-files search,
  command-palette shell, calm web-push model, multi-node SSH + persistence.

---

## 5. PHASE 0 — Foundation

> Gates all later phases. Build the spine before the features.

### Epic F-A: One typed contract, edge to edge

- [ ] **F1 — Single-source wire contracts (REST + WS + agentd proto).**

  - **Why:** REST is Zod-validated but the live WS frames and the Go↔TS agentd proto are
    hand-typed in two places — the biggest correctness gap vs Synara.
  - **Scope:** `packages/shared/src/` (new canonical schemas), `apps/orchestrator/src/live-channels.ts`,
    `agentd/proto/proto.go`, `apps/orchestrator/src/nodes/agentd/protocol.ts`.
  - **Approach:** define every live WS message + control frame as a Zod schema in shared;
    validate on decode at both ends; generate (or conformance-test) the Go structs against
    the shared schema so the Go↔TS seam can't drift.
  - **Success criteria:** every WS message + agentd control frame has one schema;
    decoding an unknown/invalid frame is a typed, logged rejection (never a crash); a CI
    check fails if a Go proto field and its TS schema diverge.
  - **Tests:** schema round-trip unit tests; a Go↔TS conformance test (golden fixtures);
    an int test asserting a malformed WS frame is rejected cleanly.
  - **Deps:** none. **Risk:** medium (touches the hot path) — land behind a decode-warn
    mode first, then enforce.

- [x] **F2 — Typed error envelope (REST).** Shipped: shared `FlockErrorEnvelope`
      (`{ error: { code, message, details? } }`); `http/reply.ts` `errorEnvelope`/`replyError`
      build it; a global `setErrorHandler` + `setNotFoundHandler` in `buildServer` return it
      for uncaught/404 errors and **never leak a 5xx internal message** (logged instead).
      Tests: `http/error-envelope.test.ts` (2). _(WS-side error frames fold in with F1.)_
  - **Why:** routes return ad-hoc JSON; the client can't discriminate failure modes.
  - **Scope:** `packages/shared` (error schema), all `apps/orchestrator/src/**/*-route.ts`,
    web data layer.
  - **Approach:** one `FlockError` Zod envelope (`code`, `message`, `details?`); a Fastify
    error hook + WS error frames use it; web maps codes to UX.
  - **Success criteria:** every error response/ frame conforms; web can branch on `code`.
  - **Tests:** route error-shape tests; a web test that renders distinct UX per code.
  - **Deps:** F1. **Risk:** low.

### Epic F-B: Durable, rebuildable state

- [x] **F3 — Rebuildable live status (event-sourcing-lite).** Shipped: `rehydrateStatus`
      (`status/rehydrate.ts`, exported via `status/index.ts`) seeds the in-memory `StatusMap`
      from the `agent_sessions.status` write-behind mirror via `StatusMap.seed` (no event-log
      write, no fan-out). Wired OFF the hot path in `live-channels.ts` (open sessions only;
      a slow/down DB can't block startup). Tests: `status/rehydrate.test.ts` (3). _(Follow-up:
      an int test that restarts against real Postgres — the unit test covers the reducer.)_

  - **Why:** on orchestrator restart the in-memory `StatusMap` blanks until agents
    re-emit. Synara rebuilds from its event log.
  - **Scope:** `apps/orchestrator/src/status/map.ts`, `status/index.ts`, `db/schema.ts`
    (`events`), startup.
  - **Approach:** keep `StatusMap` in-memory for the hot path; on boot, rehydrate from the
    latest per-session events (already indexed `(session_id, seq)`) and/or re-query agentd
    for current session status.
  - **Success criteria:** after an orchestrator restart with live sessions, status +
    telemetry are correct within one reconcile cycle without waiting for new agent output.
  - **Tests:** int test — seed events, restart the server, assert `StatusMap` rehydrates;
    unit test for the rebuild reducer.
  - **Deps:** none. **Risk:** low–medium.

- [ ] **F4 — Resume cursors at the agentd boundary.**
  - **Why:** Shepherd survives orchestrator loss (PTY lives on the node) but not _agentd_
    loss → "reconnecting forever." Synara persists a resume cursor.
  - **Scope:** `agentd/internal/session/`, orchestrator agentd client, `db/schema.ts`.
  - **Approach:** persist enough per-session state (transcript/rollout path, last seq,
    PTY handle metadata) that after an agentd restart the orchestrator re-binds or cleanly
    re-attaches; surface a precise "reattaching" vs "lost" state.
  - **Success criteria:** kill `agentd` on a node, restart it → sessions reattach (or
    report a definitive terminal state); no infinite "reconnecting."
  - **Tests:** int/e2e on a Vagrant node — kill+restart agentd, assert reattach.
  - **Deps:** F1. **Risk:** medium (daemon + live validation required).

### Epic F-C: The structured-I/O transport (keystone)

- [x] **F5 — Canonical agent runtime-event taxonomy.** Shipped: `packages/shared/src/
agentEvents.ts` — the `AgentEvent` discriminated union (session/turn lifecycle, content
      deltas w/ stream kinds, tool calls, plan, usage, approval/input `request.opened`,
      error) + `agentEventToStatus` proving the existing `Status` is a projection of it.
      Tests: `agentEvents.test.ts` (4). Modeled on Synara's `providerRuntime.ts`.

  - **Why:** a structured spine needs one normalized event vocabulary (Synara's
    ~50-event `ProviderRuntimeEvent` is the model) so every transport projects into it.
  - **Scope:** `packages/shared/src/` (new `agentEvents` schemas).
  - **Approach:** define a typed union covering session/turn lifecycle, content deltas
    (assistant/reasoning/plan/command-output), tool-call start/update/complete, token/usage,
    diff updated, approval `request.opened/resolved`, `user-input.requested/resolved`,
    plan/tasks updated, errors/warnings. Each event keeps a `raw` source pointer. **This
    union is the contract the chat view, control plane, and telemetry all consume.**
  - **Success criteria:** the existing `Status` + telemetry are derivable as a projection
    of this union; reference docs the taxonomy.
  - **Tests:** projection unit tests (taxonomy → `Status`/telemetry).
  - **Deps:** F1. **Risk:** low (additive schema).

- [~] **F6 — ACP client spine in `agentd` (structured transport #2). CORE DONE.**
  Shipped `agentd/internal/acp/` — a working Agent Client Protocol client:
  ndjson JSON-RPC 2.0 `Conn` (concurrent `Call` + read loop), the handshake helpers
  (`Initialize`/`NewSession`/`Prompt`/`Cancel`), `session/update` → canonical `Event`
  mapping (assistant/reasoning/user chunks, tool_call/\_update, plan, usage), the
  **bidirectional `session/request_permission` round-trip** (P1's foundation), and the
  verified per-agent launch table (`gemini --experimental-acp`, `grok agent --no-leader
stdio`, `cursor-agent acp`) — all referencing Synara's `effect-acp`. Tests:
  `acp_test.go` (launch table, `session/update` parsing, a mock-agent handshake+stream,
  permission round-trip; `-race` clean).
  **Wiring layer DONE** (`internal/session/acp_bridge.go` + `acp_runner.go`): `acpEventToUpdate`
  maps ACP events → `status.Update` (reusing the existing `status` frames → orchestrator, so
  NO proto change for status/telemetry); `newACPHandlers` flips to `awaiting_input` on a
  permission request + answers it; `runACPOverConn` drives the handshake→prompt→idle
  lifecycle; `RunACPSession` is the spawn wrapper. Tests: `acp_bridge_test.go` (mappings,
  permission handler, full run loop vs a mock agent; `-race` clean).
  **Remaining:** register an "acp" session mode in `Manager.Open` (a non-PTY session that
  calls `RunACPSession`) + per-session prompt-input/permission-responder plumbing, then
  **validate against a live ACP agent on a node** (the flagged gate; PTY stays the default —
  Invariant 1 preserved, PTY path untouched).

  - **Why:** the keystone. Unlocks chat, the control plane, handoff, and the
    Gemini/Grok/Cursor telemetry gaps — without losing any-agent (PTY stays the fallback).
  - **Scope:** `agentd/` (new `internal/acp/` — JSON-RPC over stdio client), session
    launch (a session can run in `pty` or `acp` mode), proto (carry runtime events),
    orchestrator ingestion → F5 taxonomy. Reference: `synara/packages/effect-acp`.
  - **Approach:** implement an ACP client (initialize/newSession/prompt/cancel/
    setSessionModel + client handlers requestPermission/elicit/createTerminal/
    sessionUpdate). A new agent "mode" launches the agent's ACP entrypoint and streams
    `session/update` → canonical events. PTY mode unchanged and default.
  - **Success criteria:** at least one ACP agent (Gemini _or_ Grok — both ship ACP) runs
    in `acp` mode end-to-end on a live node, producing canonical events (tokens, plan,
    tool calls, approval requests); PTY mode for all agents still works unchanged.
  - **Tests:** Go unit tests against a **mock ACP agent** (stdio fixture); int test for an
    ACP session lifecycle; live validation on a Vagrant node with a real ACP agent.
  - **Deps:** F1, F5. **Risk:** high (new transport + daemon + live agent) — flag-gated;
    PTY remains default until proven.

- [ ] **F7 — Lifecycle rigor: readiness gate + ordered shutdown.**

  - **Why:** avoid "starting forever" (clients served before channels are wired) and
    lossy shutdowns.
  - **Scope:** orchestrator startup/shutdown, `live-channels.ts`.
  - **Approach:** a readiness barrier (node connections + status fan-out wired before live
    channels are served); ordered shutdown drains agentd connections + flushes the
    write-behind log.
  - **Success criteria:** no live channel is served before readiness; shutdown loses no
    buffered events.
  - **Tests:** int tests for the readiness gate and graceful drain.
  - **Deps:** none. **Risk:** low.

- [ ] **F8 — Test harness: mock ACP agent + event-replay kit.**
  - **Why:** the structured spine needs deterministic test doubles.
  - **Scope:** `agentd/` test utils, orchestrator test utils.
  - **Approach:** a scriptable mock ACP agent (emits a recorded session/update stream) +
    a runtime-event replay helper for projection/UI tests.
  - **Success criteria:** F6/Phase-1 tasks can test against the mock without a real agent.
  - **Tests:** self-test of the mock.
  - **Deps:** F5. **Risk:** low.

**Phase 0 exit criteria:** one typed contract enforced edge-to-edge; status rebuildable
on restart; sessions reattach after agentd restart; an ACP session runs live alongside
unchanged PTY sessions; all gates green.

---

## 6. PHASE 1 — Per-session power (the Synara superset)

> After Phase 0. Makes Shepherd match _and exceed_ the best desktop tool, per session.

### Epic L1-A: The control plane (observe → act)

- [~] **P1 — Respond to approvals & user-input from the cockpit. GENERIC PATH SHIPPED.**
  `RespondBar` (`features/paddock/RespondBar.tsx`) appears on the focused session when it's
  `awaiting_input` and sends a typed reply (or quick keys ⏎/y/n/Esc) straight to the agent
  via the `terminalInput` seam — answer a blocked agent without diving into the terminal.
  Works TODAY with the authed PTY agents. Tests: `RespondBar.test.tsx` (3). **Remaining:**
  the fully-structured one-click Approve/Deny (exact prompt options, no keystroke guessing)
  rides on the ACP transport (F6 finish) — the permission round-trip engine is already
  built (`acp` + `newACPHandlers`); same bar, richer buttons, once ACP sessions launch.

  - **Why:** the #1 gap. Today you detect `awaiting_input` but must SSH into the TUI to
    answer.
  - **Scope:** shared (`request.opened/resolved`, `user-input.requested/resolved`,
    `respondToRequest`/`respondToUserInput`), orchestrator (respond routes + WS), agentd
    (deliver decisions back), web (approve/deny/answer UI on the session).
  - **Approach:** start with **OpenCode** (its plugin already round-trips
    `permission.updated` — extend it to accept a decision back). Then Claude/Gemini hooks
    (return `permissionDecision`), then ACP agents (F6 `requestPermission`/`elicit`),
    then Codex (app-server). PTY-only agents: surface the prompt + let the user type into
    the terminal (graceful fallback).
  - **Success criteria:** for OpenCode + ≥1 ACP agent, a permission/plan prompt can be
    approved/denied/answered from the browser, live on a node; the agent proceeds.
  - **Tests:** translator/route unit tests; int test for the respond round-trip; live
    validation per agent.
  - **Deps:** F1, F5, F6 (for ACP agents). **Risk:** medium; per-agent live validation.

- [ ] **P2 — Steer / inject / switch-model / queue (full control).**
  - **Why:** parity with Synara's composer — direct the agent without the TUI.
  - **Scope:** shared (control commands), orchestrator, agentd (ACP `steerTurn`,
    `setSessionModel`, prompt injection), web (composer affordances).
  - **Approach:** for structured (ACP/SDK) sessions: mid-turn steer, model switch, inject
    a turn, queue follow-ups with edit/delete. For PTY sessions: inject typed input
    (already possible) — advanced steering is structured-only (documented limitation).
  - **Success criteria:** on a structured session, steer + model-switch + queued turns
    work live.
  - **Tests:** unit + int against the mock ACP agent; live validation.
  - **Deps:** F6, P1. **Risk:** medium.

### Epic L1-B: Dual surface (terminal + structured chat)

- [ ] **P3 — Structured chat view (read-side projection).**

  - **Why:** readable history, addressable turns, reviewable tool calls — _alongside_ the
    terminal, not replacing it.
  - **Scope:** web (new chat panel sibling to the terminal), orchestrator (serve the F5
    event stream per session), derive from ACP events (rich) or tailed transcripts
    (Claude/Codex/OpenCode).
  - **Approach:** render the canonical event union as a timeline (user/assistant/
    reasoning/tool-call/plan/diff rows). Degrade to "terminal only" where events are thin
    (PTY-only agents). The terminal stays the control surface.
  - **Success criteria:** a chat timeline renders live for an ACP agent and for a
    transcript-rich agent; switching chat↔terminal is instant and lossless.
  - **Tests:** web render tests off replayed events (F8); e2e for the dual surface.
  - **Deps:** F5; richer with F6. **Risk:** medium.

- [ ] **P4 — Addressable turns: recap, pin, jump-to-diff, cite.**
  - **Why:** the cheap wins structured messages unlock.
  - **Scope:** web chat panel, orchestrator (a stateless summarize endpoint for recap).
  - **Approach:** stable turn IDs → per-session **recap** (idle-debounced summary), pin a
    message, jump from a tool-call to its diff, copy/cite a turn.
  - **Success criteria:** recap renders + refreshes; pin/jump/cite work.
  - **Tests:** unit for recap trigger/cache; web interaction tests.
  - **Deps:** P3. **Risk:** low.

### Epic L1-C: The git loop & handoff

- [x] **P5 — Close the git loop: PR creation + branch ops** _(checkpoints/revert deferred)._
      Shipped: `gh pr create` with duplicate-PR reuse + friendly missing/unauthed `gh` hints
      (`git-service.ts` `createPr`/`createBranch`/`switchBranch` + argv builders), routes
      (`/git/branches|branch|switch|pr`), shared contracts (`GitPrResponse` etc.), web hooks
      (`useCreatePr`/`useCreateBranch`/`useSwitchBranch`) + a "PR" control in the Source
      Control `CommitBar`. Tests: `git-pr.test.ts` (18). Per-turn checkpoints/revert = follow-up.

  - **Why:** Shepherd stops at push; elite is commit→push→**PR** from the cockpit.
  - **Scope:** orchestrator `sessions/git-service.ts` + `git-route.ts`, web Source Control
    panel. Reference: `synara/apps/server/src/git/Layers/GitHubCli.ts`.
  - **Approach:** `gh pr create` (with duplicate-PR detection), combined commit→push→PR,
    branch create/switch UI, optional per-turn checkpoints + revert.
  - **Success criteria:** create a PR from the panel against a real repo on a node; branch
    create/switch works.
  - **Tests:** git-service unit tests (mock `gh`); int test on a seeded repo; e2e for the
    panel.
  - **Deps:** none (independent of the spine). **Risk:** low–medium.

- [ ] **P6 — Cross-provider handoff.**
  - **Why:** "hand this task from Gemini to Claude with context" — a natural fleet move.
  - **Scope:** orchestrator (serialize transcript/events → bootstrap prompt → spawn target
    agentType), web (handoff action). Reference:
    `synara/apps/server/src/orchestration/handoff.ts`.
  - **Approach:** port `buildHandoffBootstrapText` (summary + last-N verbatim, budget-
    capped); spawn a new session of the chosen agent seeded with the bootstrap. Scope to
    transcript/event-rich agents; UI states it's a lossy context transfer.
  - **Success criteria:** handoff produces a new session of a different agent that
    continues the task coherently.
  - **Tests:** unit for the serializer; int for spawn+seed; live spot-check.
  - **Deps:** P3 (structured history). **Risk:** medium.

### Epic L1-D: Reach (telemetry parity + more agents)

- [ ] **P7 — Telemetry parity.**

  - **Why:** known gaps from the matrix.
  - **Scope:** Codex cost/token split (stop discarding parsed input/output), Gemini
    transcript tailer (`~/.gemini/tmp/.../chats/*.jsonl` → tokens/model/ctx%), Grok via
    ACP (F6).
  - **Success criteria:** matrix shows ✅ tokens/model/context% for Codex, Gemini, Grok.
  - **Tests:** per-agent translator/tailer unit tests with captured fixtures; live
    validation.
  - **Deps:** F6 for Grok. **Risk:** low–medium.

- [ ] **P8 — More agents via ACP: Cursor, Kilo Code, Pi.**
  - **Why:** 8 first-class agents ≥ Synara, cheaply, once F6 exists.
  - **Scope:** agent-launch caps + per-agent ACP support, detection, model-info, matrix.
  - **Success criteria:** each new agent launches + reports status/telemetry on a node.
  - **Tests:** per-agent launch/translator tests; live validation.
  - **Deps:** F6. **Risk:** medium (per-agent validation).

### Epic L1-E: UX polish

- [x] **MC — Mission Control (elite flagship).** New `overview` view: every open agent
      across every node as cards, **awaiting_input ("needs you") sorted to the top**, with
      status/node/project/tool/model/tokens/cost; click → focus that session. Built on
      existing live data (no backend). `features/overview/MissionControl.tsx`, wired into the
      store (`openOverview`), `Paddock` (center pane), the Sidebar (rail + menu), and the
      command palette. Tests: `MissionControl.test.tsx` (needs-you count, attention-first
      sort, click-to-focus).
- [x] **P5 follow-up — branch create UI.** "+branch" control in the Source Control header
      (`useCreateBranch`), completing P5's branch ops with a UI.

- [x] **P9 — Populate the command palette.** Shipped: `buildPaddockCommands` +
      `<PaddockCommands />` (`app/usePaddockCommands.tsx`) registers create / view / panel /
      settings actions + live navigation to every open session, project, and node. Wired in
      `Paddock.tsx`. Tests: `usePaddockCommands.test.ts` (3).
- [ ] **P10 — Rich, configurable keybindings.** Expand beyond Cmd+K/J; optional
      JSON config + `when` contexts. _Tests:_ web. _Risk:_ low.
- [ ] **P11 — Browser pane → real preview.** Address bar, tabs, back/forward, and CDP
      input takeover (currently screencast/view-only). _Scope:_ `features/browser/`. _Tests:_
      e2e. _Risk:_ medium.
- [ ] **P12 — Session archiving + auth-tier + one-click agent self-update.** Archive in
      the sidebar; surface subscription tier/auth method in node-info; `npm/brew/native`
      upgrade per agent. _Risk:_ low.
- [ ] **P13 — Clear the pre-existing lint baseline (hygiene).** `pnpm lint` is currently
      red (~36 errors / 56 warnings) from before this roadmap — mostly `no-unused-vars`,
      `no-explicit-any`, `no-useless-escape`, `no-regex-spaces`, `no-empty-object-type` in
      `auth`/older files. Run `eslint --fix` for the auto-fixable set, then resolve the rest,
      so the DoD "lint clean" gate is actually green and new work can't hide a regression in
      the noise. _Risk:_ low. _Note:_ new code (P5/P9) was verified to add **zero** new lint
      problems against this baseline.

**Phase 1 exit criteria:** a session is fully directable from the browser (approve/answer/
steer/switch/inject), has a dual terminal+chat surface, can open a PR and hand off to
another agent; 8 agents integrated; UX polish shipped; all gates green; live-validated.

---

## 7. PHASE 2 — The moat (web-native, fleet-native — what desktop can't do)

> The runaway lead. Each epic is a capability a single-machine app cannot offer.

### Epic L2-A: Teams & access

- [ ] **M1 — Multi-user + RBAC.** Users, roles (owner/admin/operator/viewer),
      per-resource authorization (node/project/session), invitations. _Scope:_ orchestrator
      auth/authz, `db/schema.ts`, web admin. _Success:_ a viewer cannot mutate; an operator
      can run sessions but not manage nodes; all enforced server-side + tested. _Tests:_
      authz matrix int tests. _Deps:_ F2. _Risk:_ medium.
- [ ] **M2 — Auth control plane: sessions, pairing links, revocation, short-lived WS
      tokens.** Reference: `synara/apps/server/src/auth`. _Success:_ device pairing + per-
      session revocation. _Deps:_ M1. _Risk:_ medium.
- [ ] **M3 — SSO (OIDC/SAML).** The enterprise surface the PRD phases. _Deps:_ M1.
      _Risk:_ medium.

### Epic L2-B: Collaboration

- [ ] **M4 — Shared & live-collaborative sessions.** Multiple users watch one live
      session; permalink a session/turn; presence indicators. _Scope:_ WS fan-out to N
      viewers, web. _Success:_ two browsers see the same live terminal + chat; a permalink
      opens a turn. _Deps:_ F1, M1. _Risk:_ medium.
- [ ] **M5 — Person-to-person handoff.** Reassign/handoff a session to a teammate with
      context + a note. _Deps:_ M1, P6. _Risk:_ low.

### Epic L2-C: Fleet orchestration (the new primitives)

- [ ] **M6 — Run-N-and-compare (agent bake-offs).** Launch the same task across N
      agents/models/nodes, then diff outcomes (diffs, cost, time) side by side. _Scope:_ an
      orchestration layer over sessions + the chat/diff projections. _Success:_ one prompt →
      N sessions → a comparison view. _Deps:_ P3, P5. _Risk:_ high (new product surface).
- [ ] **M7 — Cross-node handoff & scheduling.** Move a session/task to a freer node;
      schedule/pool sessions by node capacity (uses the per-session CPU/mem metrics). _Deps:_
      F4, P6. _Risk:_ high.

### Epic L2-D: Anywhere & governed

- [ ] **M8 — Mobile-first PWA supervision.** Approve a prompt, read a recap, kick a stuck
      agent from a phone; push-to-action from the notification. _Scope:_ web responsive +
      PWA + push. _Success:_ the core supervise loop is fully usable on a phone. _Deps:_ P1,
      P4, M4. _Risk:_ medium.
- [ ] **M9 — Cost & policy governance.** Fleet-wide + per-user/per-agent budgets, spend
      dashboards, alerts; sandbox/permission policy as config. _Deps:_ P7 (telemetry), M1.
      _Risk:_ medium.
- [ ] **M10 — Extensibility: MCP / skills / plugins.** Discover + manage each agent's
      MCP servers, skills, and plugins (Synara surfaces these). _Deps:_ F6. _Risk:_ medium.
- [ ] **M11 — Audit & observability.** Fleet dashboards (status, throughput, errors,
      spend) + a searchable audit trail UI over the existing audit rows. _Deps:_ M1. _Risk:_
      low–medium.

**Phase 2 exit criteria:** a team can securely co-operate a fleet from anywhere, run and
compare agents at scale, govern cost, and audit everything — capabilities no single-
machine tool can match.

---

## 8. Sequencing & dependencies

```
PHASE 0 (Foundation) ───────────────────────────────────────────────┐
  F1 ─┬─ F2                                                           │
      ├─ F3                                                           │
      ├─ F4 ───────────────────────────────────────┐                 │
      └─ F5 ─┬─ F6 ─┬─ (unlocks ACP everywhere)     │                 │
             └─ F8  └───────────────┐               │                 │
  F7 (independent)                  │               │                 │
                                    ▼               ▼                 ▼
PHASE 1   P1(OpenCode→ACP) ◀── F6   P7(Grok◀F6)   (F4)            P3◀F5
  P1 ─ P2 ─ P3 ─ P4 ─ P6        P5 (independent, can start anytime)
                 P8 ◀── F6       P9/P10/P11/P12 (independent UX, anytime)
                                    │
                                    ▼
PHASE 2   M1 ─ M2/M3/M4/M5/M9/M11       M6 ◀ P3,P5     M7 ◀ F4,P6     M8 ◀ P1,P4,M4     M10 ◀ F6
```

**Critical path:** F1 → F5 → F6 → P1/P3 → (Phase 2 fleet/collab). **Parallelizable now
(no spine dep):** F2, F3, F7, P5, P9–P12. Start those immediately alongside the spine.

**Milestones:**

- **M-Foundation:** F1–F8 merged + green; an ACP session runs live; status rebuildable.
- **M-Superset:** P1–P8 merged; a session is fully directable; dual surface; PR loop;
  handoff; 8 agents. _(Shepherd ≥ Synara per session.)_
- **M-Moat:** M1, M4, M6, M8 merged. _(Team + fleet + mobile — the lead desktop can't
  follow.)_

---

## 9. Risk register

| Risk                                                         | Mitigation                                                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP transport (F6) destabilizes sessions                     | Flag-gated; PTY stays default + universal fallback (Invariant 1); mock-agent tests + live validation before flip                               |
| Hot-path schema validation (F1) adds latency / breaks frames | Land in warn-mode first; benchmark; enforce only after a clean window                                                                          |
| External agent payloads differ from docs                     | Tolerant parsers + captured fixtures + live validation are mandatory (§3)                                                                      |
| Daemon changes break live nodes                              | Versioned auto-redeploy; validate vm-1 → vm-2; keep PTY path working throughout                                                                |
| Scope creep into a desktop/Effect rewrite                    | Invariants (§2) + non-goals are review gates; reject PRs that violate them                                                                     |
| Chat view drifts toward "chat as the only input"             | Doctrine: terminal is the control surface + source of truth; chat is read-mostly until P2 adds structured input _for structured sessions only_ |
| Multi-user authz gaps (M1)                                   | Server-side enforcement + an authz-matrix test suite; never trust the client                                                                   |

---

## 10. Working agreements (for the agent team)

- Pick the lowest unblocked task; announce it (check the box → in-progress).
- TDD: failing test from _Success criteria_ first.
- Small PRs; every PR passes the full DoD gate (§3) and updates docs.
- `agentd`/integration tasks: capture a real payload + validate on a Vagrant node before
  "done." No external-payload parsing merged on docs alone.
- Never weaken §2 invariants or the test baselines.
- Leave the matrix + this roadmap accurate in the same PR.

---

## Appendix A — Synara competitive analysis (condensed)

Synara (`synara/`, gitignored reference) is a **local-first Electron desktop app** (Bun

- Effect-TS + Turbo), with a web/remote mode. It is the per-session bar to clear.

**What Synara does that motivated this plan:**

- **Structured control, not observation:** agents run as ACP / app-server / SDK
  JSON-RPC servers; a ~50-event normalized taxonomy drives a **chat transcript**; the UI
  can **respond to approvals, answer plan prompts, steer, switch model, fork, handoff**.
- **8 providers** (adds Cursor, Kilo, Pi); ACP via `packages/effect-acp`.
- **Git:** full `gh pr create`, branch ops, checkout-PR-into-worktree, per-turn
  checkpoints/diff/revert.
- **Rigor:** one Effect-Schema contract end-to-end (RPC + streams + typed errors);
  event-sourced SQLite with projections; resume cursors; readiness gate + ordered
  shutdown; a real auth control plane (pairing/roles/revocation).
- **UX:** useful command palette, configurable keybindings, multi-tab in-app browser,
  thread recap, queued-message composer, archiving.

**Where Shepherd already wins (protect these):** multi-node over SSH, sessions persistent
independent of client _and_ orchestrator, any-CLI-day-one via PTY, Postgres-grade
persistence, per-node/session metrics, the grid/hive view, the calm push model.

**Where Shepherd's ceiling is higher (Phase 2):** Synara is single-user, single-machine. It
_cannot_ be a multi-user, multi-node, mobile, governed, collaborative web service. That
gap is Shepherd's moat — and the point of this plan is to take Synara's per-session power
_and_ build the moat on top.

> Detailed evidence (file-level) lives in the four review threads that produced this
> analysis; key Synara references: `packages/effect-acp/`,
> `apps/server/src/provider/{Services/ProviderAdapter.ts,acp/,Layers/ProviderHealth.ts}`,
> `apps/server/src/orchestration/handoff.ts`, `packages/contracts/src/providerRuntime.ts`.
