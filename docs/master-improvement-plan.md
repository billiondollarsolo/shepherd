# Shepherd ← Herdr: Tech & Agent/AI Management Incorporation Plan

**Status:** Accepted decisions · agent-executable  
**Audience:** AI agents implementing; humans reviewing PRs  
**Date:** 2026-08-01  
**Decisions locked:** 2026-08-01 (product review)  
**Repos:** `herdr/`, `shepherd/`, `flock-tui/` (sibling trees under `shepherd-all/`)  
**Companions:**  
[`architecture.md`](./architecture.md) · [`agent-integration-matrix.md`](./agent-integration-matrix.md) · [`flock-agentd-design.md`](./flock-agentd-design.md) · [`roadmap.md`](./roadmap.md) · [`architecture/state-ownership.md`](./architecture/state-ownership.md) · herdr docs (`agents`, `agent-automation`, `socket-api`, `session-state`, `integrations`) · herdr `AGENTS.md` / `skills/herdr/SKILL.md`

---

## 0. How to use this document

1. **Read §1 Pass F first** — all product decisions are **locked**. Do not re-open them in implementation PRs without an explicit plan amendment.
2. **Phases are ordered.** Phase 0 is pure foundation; later phases depend on it.
3. **One task ≈ one branch ≈ one PR.** Prefer TDD against each task’s success criteria.
4. **Do not replace Shepherd’s product model with Herdr’s.** Port *capabilities and algorithms*, not the Herdr binary, TUI, or workspace/tab/pane identity.
5. **Update** `agent-integration-matrix.md`, this plan’s checkboxes, and `COMPATIBILITY.json` / agentd version in the same PR when behavior changes.
6. **Live validation** is required for detection, status authority, and automation surfaces — fixtures alone are not enough for agent UI that changes weekly.

Each task has: **Why · Scope · Approach · Success criteria · Tests · Validation · Deps · Risk · Out of scope**.

---

## 1. Multi-pass review summary

### Pass A — Product identity (what each system is)

| | **Herdr** | **Shepherd** |
| --- | --- | --- |
| One-liner | Terminal agent **multiplexer/runtime** (one machine, many panes) | Multi-node **operations platform** for coding agents |
| Primary UI | Mouse-first TUI (Rust) + CLI | Web paddock (React) + optional `flock-tui` |
| Process owner | Herdr server (headless runtime + PTY panes) | `flock-agentd` (Go daemon, privilege-separated) |
| Topology | Workspace → tab → pane → agent occupant | Node → project → session (+ pens presentation) |
| Multi-machine | Remote attach / experimental handoff | First-class SSH nodes + orchestrator |
| Client role | Thin client of server-owned runtime (migrating hard) | Browser/TUI are viewers; never in data path |
| Auth / multi-user | Local socket, single operator | Cookie auth, push, vault, audit, self-host fleet |
| Differentiator | Screen-aware agent state + agent-to-agent automation | Fleet, structured Chat, privilege boundary, Preview |

**Strategic conclusion:** Shepherd should **absorb Herdr’s agent intelligence and automation primitives into `agentd` + orchestrator APIs**, not become a Herdr fork. Herdr remains a competitive reference and a source of manifests/rules/UX patterns. `flock-tui` can expose the same control surface locally without the orchestrator.

### Pass B — Herdr capability inventory (what is worth taking)

Prioritized by value to Shepherd’s “Needs you / guide the flock” mission:

| Priority | Herdr capability | Why it matters for Shepherd | Fits where |
| ---: | --- | --- | --- |
| **P0** | **TOML screen-manifest detection** (`src/detect/manifests/*`, engine in `manifest.rs`) | Fills `awaiting_input` gaps for Codex (hooks unseeded), Grok (no approval event), Antigravity (TUI-only), Amp/Cursor/Aider terminal tier | `agentd` |
| **P0** | **Status authority model** (lifecycle integration vs screen vs process; `visible_blocker` / skip transcript viewers) | Shepherd has hooks + transcripts but **no arbitration** when they disagree or miss | `agentd` + orchestrator merge |
| **P0** | **Detection explain** (`agent explain`) | Debuggable status (“why is this Idle?”) — critical when shipping screen rules | agentd API + ops CLI |
| **P1** | **Agent automation API** (`agent.prompt`, `agent.wait`, `agent.send-keys`, `pane.wait_for_output`, event subscribe) | Multi-agent orchestration, scripts, “agents use Shepherd” | agentd ops + orchestrator REST/WS + skill |
| **P1** | **Agent skill** (`skills/herdr/SKILL.md` pattern) | Coding agents can spawn siblings, wait, read, coordinate | `skills/shepherd/` + env injection |
| **P1** | **Wider agent catalog** (19+ manifests + process labels) | Shepherd first-class set is smaller; terminal tier is thin | agentd detect + node tooling |
| **P1** | **Unseen-idle attention** (`unseenIdle` metadata; wire stays `idle`) | Better “what finished while away” without overloading session-end `done` or push spam | status model + web |
| **P2** | **Native session resume** after server/daemon restart (`agent_resume`, integration session refs) | Shepherd F4 (resume cursors) + “agents come back after agentd restart” | agentd + session registry |
| **P2** | **Manifest hot-reload / remote update / local override** | Rules track agent UI changes without full daemon redeploy | agentd + optional control plane |
| **P2** | **Alt-screen intelligent reads** (scroll agent UI to capture history when idle) | Structured capture from full-screen TUIs without Chat transport | agentd read path |
| **P3** | **Worktree CLI/API as automation primitive** | Shepherd has worktree service; Herdr exposes create/open/list to agents | orchestrator + skill |
| **P3** | **Plugins / marketplace** | Extensibility moat (roadmap Layer 2) — later | optional |
| **P3** | **Live PTY FD handoff across server replace** | Elite zero-downtime upgrade; hard with agentd root/setuid model | experimental later |
| **Defer** | Herdr TUI, mouse-first chrome, workspace/tab geometry as identity, libghostty-vt as product UI | Overlaps web + flock-tui; wrong stack ownership | — |
| **Defer** | Replacing agentd with Herdr server | Breaks privilege separation, multi-node, protocol v2, Go clients | — |

### Pass C — Shepherd baseline (what we already have)

Strengths **not** to regress:

- `flock-agentd` owns PTYs, scrollback ring, resize, status frames, privilege drop (`flock-agent`).
- Status from **transcript tails** (Claude, Codex, Antigravity) + **hooks** (Claude, OpenCode, Grok) + structured transports (`claude-stream`, `codex-app-server`, ACP spine).
- Unified `Status` enum already uses Herdr-aligned **display words** (`Working`, `Needs you`) in `packages/shared/src/status.ts`.
- Orchestrator merge → `/ws/status` → paddock dots + Web Push on `awaiting_input` / `error` / `done`.
- Structured Chat, Pens, multi-node SSH, Preview, git, vault.
- `flock-tui` local/fleet modes with `sessions wait` (poll-based), pens, VT client renderer.

Gaps vs Herdr (the incorporation target):

1. **No screen-manifest detection** on the live PTY. Status for permission UIs is hook/transcript-dependent; many agents only show blockers in the TUI.
2. **No authority arbitration** when hooks lag, transcripts are quiet, or OSC/title signals exist.
3. **No agent-facing control skill** equivalent to Herdr’s “agents can use herdr” socket/CLI skill.
4. **Automation primitives are incomplete** at the product API layer: create session + PTY write exist, but not first-class `prompt+wait`, `wait-until-status`, `wait-for-output`, pinned occupant waits, or `explain`.
5. **Agent catalog / process detection** narrower than Herdr’s 19+ manifests.
6. **Scrollback is a raw byte ring**, not a parsed screen model — insufficient for Herdr-class region matchers (`bottom_non_empty_lines`, `after_last_horizontal_rule`, OSC title regions) without new infrastructure.
7. **Daemon restart** loses live PTYs; no native agent session-ref resume path like Herdr integrations.
8. **Unseen review signal:** Shepherd uses turn-complete → `idle` and session-end → `done`. Locked direction: keep that wire model and add **`unseenIdle` metadata** + UI attention (not Herdr’s remap of unseen idle → `done`).

### Pass D — Conceptual mapping (do not invent parallel ontology)

| Herdr concept | Shepherd concept | Notes |
| --- | --- | --- |
| Server | `flock-agentd` (+ orchestrator for fleet) | Server-owned runtime already true |
| Client TUI | `apps/web` / `flock-tui` | Presentation only |
| Workspace | **Project** (or node-local group) | Do not add Herdr workspaces as identity |
| Tab | **Pen** or single session focus | Presentation / grouping |
| Pane | **Session** (1:1 with PTY) | Shepherd’s atomic unit stays session |
| Agent name (`reviewer`) | Session **display name** / alias | Unique among live sessions on node or project |
| `working` | `running` | Keep wire enum; map display “Working” |
| `blocked` | `awaiting_input` | Keep wire enum; display “Needs you” |
| `idle` / `done` / `unknown` | `idle` / `done` (session end only) / idle fallback + **`unseenIdle` metadata** | Locked: D9, H3.1 |
| Socket JSON API | agentd framed ops + orchestrator REST | Prefer extending agentd protocol with capability flags |
| Agent skill (`HERDR_ENV=1`) | `SHEPHERD_ENV=1` / `FLOCK_SESSION_ID` skill | Inject only into managed sessions |
| Integration hooks | Existing hook endpoint + seeders | Keep; classify as lifecycle authority when complete |
| Screen manifests | New `agentd/internal/screendetect` | Port rule engine + TOML (license: Herdr Apache-2.0 — see §5) |

### Pass E — Architectural constraints (must not break)

1. **Invariant (Shepherd):** any agent works via raw PTY; structured/screen paths enrich, never gate attach.
2. **Invariant:** node/`agentd` owns process truth; browser never owns PTYs.
3. **Privilege separation:** detection and automation run in agentd; agents remain unprivileged; no control credential in agent env.
4. **Protocol v2:** new ops behind capability negotiation (`screendetect_v1`, `agent_control_v1`, …); older daemons degrade cleanly.
5. **Status hot path:** still in-memory; Postgres write-behind only.
6. **Do not deepen “status only works if hooks installed.”** Screen path is the universal fallback for known TUIs; hooks/transcripts remain preferred when authoritative.
7. **License:** Herdr is Apache-2.0. Porting manifests/engine ideas into MIT Shepherd is OK with attribution in `THIRD_PARTY_NOTICES.md` and file headers where substantial code is copied. Prefer **reimplementation + adapted manifests** over vendoring Herdr as a dependency.

### Pass F — Decision table (**LOCKED** 2026-08-01)

All rows below are binding. Implementers treat them as requirements, not options.

| ID | Decision | Locked choice | Rationale |
| --- | --- | --- | --- |
| **D1** | Where screen detection runs | **Inside `agentd`**, on a **parsed bottom-buffer snapshot** per session | Only place with continuous PTY bytes, multi-client fanout, and node FS; matches “node is source of truth” |
| **D2** | VT / screen model in agentd | **Minimal Go line/grid decoder** in agentd (cols×rows or line buffer + OSC title/progress + alt-screen flag). Learn from `flock-tui/internal/vt`; **do not** vendor libghostty-vt; **do not** ship strip-ANSI-only as the long-term model | Enough for Herdr-class region matchers without Ghostty weight or full tui↔daemon package merge in v1 |
| **D3** | Herdr TOML manifests | **Yes for rule content**; engine **reimplemented in Go** with fixture compatibility tests; keep `min_engine_version` | Fastest path to real agent UIs |
| **D4** | Authority precedence (Terminal mode) | **Lifecycle authority (if active) > visible_blocker screen > transcript/hooks partial > PTY activity > idle fallback** | Fixes money-state misses; mirrors Herdr terminal behavior |
| **D5** | Automation surface (v1 after detection trusted) | **Full stack: agentd ops + orchestrator REST/WS + in-session skill** | Fleet + local + multi-agent coordination; not a second private socket language |
| **D6** | Domain model | **Keep node → project → session**; do **not** adopt Herdr workspace/tab/pane as identity | Pens already cover multi-agent presentation |
| **D7** | Live PTY FD handoff | **Out of v1** (Phase 5 research only) | High risk under setuid privilege separation |
| **D8** | Relationship to roadmap F4/F6/control plane | This plan **feeds** those epics; does not supersede structured Chat/ACP | Screen path for **Terminal** mode; structured path for **Chat** mode |
| **D9** | Done / unseen semantics | **`done` = session end only.** Turn complete → `idle`. Unseen finished work → **`unseenIdle` metadata + UI attention**, not wire `done`. Web Push on `done` stays session-end only | Avoids push spam and collision with session-end `done`; Herdr unseen→done is explicitly rejected |
| **D10** | Screendetect default when shipping | **Default on** after fixture/authority gate (H1.3 path + hard fixtures). Kill-switch: `FLOCK_SCREENDETECT=0\|false\|off\|no`. Live matrix still recommended for soak | Prevents false Needs you until fixtures green; product default now on |
| **D11** | Structured Chat mode vs screen | **Transport owns status.** Screen is **diagnostic-only** (explain/fixtures); `visible_blocker` must **not** override Chat/ACP/stream status | Avoid dual-source thrash in Chat mode |
| **D12** | Automation token scope | **Project siblings only.** Session automation token may list/prompt/wait/read/keys/create only within the **same project**. Never agentd control credential in agent env | Least privilege for multi-agent work |
| **D13** | Manifest maintenance | **Shepherd-owned adapted manifests** + **periodic Herdr import as reviewed patches** (script/process). Not a live runtime dependency on Herdr | Independent product control with upstream leverage |
| **D14** | When to build skill/REST | **After detection is trusted** (H1 path green). Then ship H2 full skill + REST + agentd ops together as designed | Wrong status + automation is worse than no automation |

---

## 2. Target architecture (after incorporation)

```text
                    ┌──────────────────────────────────────────┐
                    │  web / flock-tui / agent skill / scripts │
                    └───────────────────┬──────────────────────┘
                                        │ REST/WS (auth)
                                        ▼
                              orchestrator (merge + API)
                                        │ agentd proto v2 + caps
                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ flock-agentd                                                             │
│  PTY session ──▶ byte ring (scrollback)                                  │
│              ──▶ screen model (bottom buffer, OSC title, alt flag) NEW   │
│              ──▶ screendetect (TOML manifests) NEW                       │
│              ──▶ status arbitrator (screen | hooks | transcript | pty)   │
│              ──▶ agent_control (prompt/wait/keys/read/explain) NEW       │
│              ──▶ transcript watchers / ACP / stream transports (exist)   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Status projection (wire stays Shepherd enum):**

| Internal detection | Wire `Status` | Extra / UI |
| --- | --- | --- |
| working / PTY active turn | `running` | Working |
| blocked / visible_blocker (Terminal mode only) | `awaiting_input` | Needs you |
| idle (ready) | `idle` | Idle; if not yet focused/opened after becoming idle → `unseenIdle: true` (badge / attention list only) |
| process / session end | `done` | Done (+ Web Push per existing policy) |
| error | `error` | Error |
| no classification | keep last / `running` if output / `idle` fallback | explain shows fallback reason |

**Chat mode (D11):** structured transport projects to wire status; screen fields may still appear on explain, never on the live status merge.

---

## 3. Phased plan

### PHASE 0 — Foundations (no user-facing behavior change)

#### [x] H0.1 — Capability & protocol scaffolding

- **Why:** All new behavior must negotiate cleanly with old agentd.
- **Scope:** `agentd/COMPATIBILITY.json`, `agentd/proto`, orchestrator `protocol.ts` / `agentd-compatibility.ts`, flock-tui import path if shared.
- **Approach:** Add optional capabilities: `screendetect_v1`, `agent_control_v1`, `status_authority_v1`. Bump daemon version when shipping. Document in compatibility matrix.
- **Success criteria:** Old clients ignore unknown caps; new clients feature-detect; CI compatibility test covers helloOk caps list.
- **Tests:** Go + TS unit tests for helloOk capability advertising; orchestrator preflight “optional caps missing → degrade” test.
- **Validation:** Connect orchestrator and flock-tui to new agentd; existing open/subscribe/PTY still pass.
- **Deps:** none. **Risk:** low.
- **Out of scope:** implementing detection logic.

#### [x] H0.2 — License / provenance checklist

- **Why:** Manifest text and engine ideas come from Apache-2.0 Herdr.
- **Scope:** `THIRD_PARTY_NOTICES.md`, headers on ported TOML, short `docs/herdr-attribution.md`.
- **Approach:** Attribute Herdr; note adapted files; do not copy Herdr UI or full source tree.
- **Success criteria:** Legal note present; no accidental copy of Herdr non-manifest production code without attribution.
- **Tests:** none (doc review).
- **Validation:** human review.
- **Deps:** none. **Risk:** low.

#### [x] H0.3 — Characterization fixtures from Herdr

- **Why:** Porting without golden screens will thrash.
- **Scope:** `agentd/internal/screendetect/testdata/` (or `packages/agent-detection-fixtures/`).
- **Approach:** For each first-wave agent (claude, codex, opencode, grok, antigravity, cursor, amp): capture **detection-source** plain text (and ANSI when needed) for idle / working / blocked using Herdr’s method (`herdr agent read … --source detection`) or synthetic screens from committed TOML comments. Store with expected state + matched rule id.
- **Success criteria:** ≥3 states × ≥5 agents fixtures committed; README describes capture procedure (mirror Herdr AGENTS.md evidence rules).
- **Tests:** fixture loader unit test.
- **Validation:** fixtures reviewed against real UI once.
- **Deps:** H0.2. **Risk:** medium (UI drift) — mitigate with version tags on fixtures.
- **Out of scope:** live agent CI farm (later).

#### [x] H0.4 — Design doc: status authority ADR

- **Why:** Merge bugs will reappear without a written authority model.
- **Scope:** `docs/decisions/status-authority.md`.
- **Approach:** Codify **locked** Pass F decisions D4, D9, D11: Terminal-mode precedence; Chat-mode transport authority (screen diagnostic-only); `done` = session end only; `unseenIdle` metadata; what “lifecycle authority active” means; `skip_state_update` for transcript viewers.
- **Success criteria:** ADR matches Pass F; referenced from architecture.md and agent-integration-matrix.
- **Tests:** none.
- **Validation:** review pass.
- **Deps:** none. **Risk:** low.

---

### PHASE 1 — Screen model + detection engine (P0 core)

#### [x] H1.1 — Per-session screen model in agentd

- **Why:** Manifest regions need bottom-of-buffer text and OSC title, not raw ring scraps.
- **Scope:** `agentd/internal/session/` (or `internal/screen/`).
- **Approach (D2 locked):**
  - On PTY output, feed a **minimal Go line/grid VT decoder** that tracks: cell grid or line buffer, cursor, alt-screen active, OSC 0/2 title, optional OSC progress.
  - Learn from `flock-tui/internal/vt` semantics; **do not** import Ghostty; **do not** rely on strip-ANSI last-N alone as the permanent model.
  - Expose `DetectionSnapshot{ Text, OSCTitle, OSCProgress, AltScreen, Cols, Rows, Revision }`.
  - Snapshot for detection = **live bottom buffer**, independent of client scrollback view.
  - Expand decoder only when fixtures fail (CUP/EL/ED/alt-screen first).
- **Success criteria:** Unit tests with fixture byte streams produce stable bottom-line text for sample Claude/Codex screens; alt-screen enter/exit resets correctly; CPU/RSS bounded.
- **Tests:** table-driven VT cases; fuzz optional; race test on concurrent write+snapshot.
- **Validation:** attach real Claude TUI; dump snapshot; human-compare to visible bottom chrome.
- **Deps:** H0.1. **Risk:** high (VT correctness) — isolate package; screendetect **default off** (D10) until H1.3+H1.5 matrix green.
- **Out of scope:** full xterm compatibility; client-side detection; shared flock-tui package move (optional H5.4 later).

#### [x] H1.2 — TOML manifest engine (Go)

- **Why:** Portable, hot-reloadable rules without recompiling agents.
- **Scope:** `agentd/internal/screendetect/` — parser, regions, matchers (`contains`, `any`/`all`/`not`, `line_regex`, `regex`, priority, `skip_state_update`, `visible_*` flags).
- **Approach (D3, D13 locked):** Implement engine semantics compatible with Herdr `min_engine_version = 2`. Embed first-wave **Shepherd-adapted** TOML via `embed.FS` (attribute Herdr). Support local override dir under agentd state. Add a **periodic import script** (e.g. `scripts/import-herdr-manifests.mjs`) that diffs upstream Herdr TOML into a patch for human review — never a live runtime fetch from Herdr.
- **Success criteria:** All H0.3 fixtures pass; invalid TOML skipped with log warning; priority ordering matches expected rule ids; import script documents workflow in README under `screendetect/`.
- **Tests:** unit tests per region type; golden fixtures; property tests for AND/OR gates.
- **Validation:** `explain` (H1.4) on live sessions matches expected fixtures.
- **Deps:** H0.3, H1.1. **Risk:** medium.
- **Out of scope:** remote signed CDN (H4.2, still default off).

#### [x] H1.3 — Wire detection into status pipeline

- **Why:** Detection must move dots, not only exist offline.
- **Scope:** `agentd/internal/session/manager_status.go`, status emitter, proto status payload (optional fields: `statusSource`, `matchedRule`, `agentKindDetected`).
- **Approach:** Poll or event-drive snapshot evaluation (e.g. on output + 200–500ms debounce). Map detection → `status.Update`. **Default off (D10)** until live matrix green for claude/codex/opencode/grok/antigravity, then default on. In **Chat mode sessions, do not apply detection to wire status (D11)** — still maintain snapshot for explain if cheap.
- **Success criteria:** With flag on (Terminal mode), Codex/Grok/Claude permission screens flip to `awaiting_input` without hooks; idle prompt → `idle`; working spinner/title → `running` when no stronger source. Chat mode sessions unchanged by screen.
- **Tests:** mock session with injected snapshots; integration test with scripted PTY writing fixture ANSI; Chat-mode session ignores screen for status.
- **Validation:** Live matrix rows for claude, codex, grok, opencode, antigravity — update `agent-integration-matrix.md`. Only then flip default on.
- **Deps:** H1.2, H0.4. **Risk:** medium–high (false blocked). Prefer strict blocked rules (fallback idle, not blocked).
- **Out of scope:** changing Web Push policy.

#### [x] H1.4 — `status.explain` / session explain API

- **Why:** Operators and agents must debug wrong dots.
- **Scope:** agentd control op + orchestrator `GET /api/sessions/:id/status-explain` + optional CLI in flock-tui.
- **Approach:** Mirror Herdr explain fields: agent, state, source, matched rule, evaluated rules (truncated), visible flags, fallback reason, manifest version.
- **Success criteria:** Explain JSON stable schema in `packages/shared`; UI can show “why Needs you” in session menu (minimal).
- **Tests:** schema tests; engine explain unit tests.
- **Validation:** manual on mis-detected pane.
- **Deps:** H1.3. **Risk:** low.

#### [x] H1.5 — Status authority arbitrator

- **Why:** Hooks + transcripts + screen will fight without explicit rules.
- **Scope:** agentd status merge (preferred) or orchestrator merge with source tags.
- **Approach (D4, D11 locked):** Implement ADR H0.4 exactly:
  - **Chat / ACP / stream mode:** transport is sole lifecycle authority; screen is diagnostic-only; **no `visible_blocker` override**.
  - **Terminal mode + full lifecycle hooks** (e.g. OpenCode plugin actively reporting): hooks author; screen skipped while authority active.
  - **Terminal mode + incomplete hooks** (Claude/Codex/Grok session-id style): **screen authors blocked/idle/working**; transcript authors tokens/model/plan/chat.
  - `skip_state_update` screens do not clobber state.
  - In Terminal mode, `visible_blocker` may override non-blocked partial integration state (Herdr-like).
- **Success criteria:** Documented matrix; unit tests for conflict cases including Chat-mode non-override; no double-push flapping in 10‑min live soak.
- **Tests:** table of (sources × outcomes); soak test optional.
- **Validation:** live Claude permission with hooks enabled — single transition to awaiting_input.
- **Deps:** H1.3, H0.4. **Risk:** high (product correctness). Ship behind screendetect flag; metrics on source wins.

---

### PHASE 2 — Agent automation & skill (P1)

> **Gate (D14):** start this phase only after H1.3 + H1.5 live matrix is green (or run H2.1 behind caps with no skill install until then). Full skill + project tokens are post-detection.

#### [x] H2.1 — Agent control ops in agentd

- **Why:** Herdr’s “agents use herdr” is the multi-agent superpower.
- **Scope:** proto ops under capability `agent_control_v1`:
  - `session.prompt` — text + enter, honor bracketed paste if known
  - `session.wait_status` — until statuses, timeout, **pin occupant** (reject if session process replaced)
  - `session.send_keys` — logical keys (`esc`, `ctrl+c`, …)
  - `session.read_screen` — sources: `visible` / `detection` / `recent` (from screen model + ring)
  - `session.wait_output` — substring/regex on read source
- **Approach:** Implement server-side waits (event-driven on status updates), not client poll only. Stall detection for prompt: if non-working and no lifecycle change within ~5s → `prompt_stalled` error (Herdr pattern).
- **Success criteria:** Capability advertised; ops rejected cleanly when cap missing; waits cancel on session close.
- **Tests:** unit tests with fake session; race tests for wait+replace; timeout tests.
- **Validation:** scripted flow start codex → prompt → wait idle.
- **Deps:** H0.1, H1.3 (for meaningful wait). **Risk:** medium (input injection safety).
- **Out of scope:** layout split (no panes).

#### [x] H2.2 — Orchestrator REST/WS façade

- **Why:** Browser, mobile, and remote automation need auth’d HTTP, not raw agentd.
- **Scope:** routes e.g.:
  - `POST /api/sessions/:id/prompt`
  - `POST /api/sessions/:id/wait` (long-poll or WS job)
  - `POST /api/sessions/:id/keys`
  - `GET /api/sessions/:id/screen`
  - `POST /api/sessions/:id/wait-output`
- **Approach:** Authz same as session access; audit log mutating ops; timeouts capped (e.g. max 10m); stream wait via existing WS channel optional.
- **Success criteria:** OpenAPI/Zod schemas in shared; e2e test with fake agentd; rate limits documented.
- **Tests:** route tests; authz denial tests; audit assertions.
- **Validation:** curl against local stack.
- **Deps:** H2.1. **Risk:** medium (DoS via long wait — require timeout).

#### [x] H2.3 — Shepherd agent skill

- **Why:** In-session coding agents should coordinate peers the way Herdr skill teaches.
- **Scope:** `skills/shepherd/SKILL.md` (and install path into agent config dirs on launch).
- **Approach (D5, D12, D14 locked):** Port structure of Herdr skill adapted to Shepherd:
  - Require env markers (`SHEPHERD_SESSION_ID` / `FLOCK_SESSION_ID`, project id, API base) + **session automation token**.
  - Token scope: **same project only** — list/prompt/wait/read/keys/create sessions in that project; deny cross-project and all node/admin ops.
  - **Forbidden:** agentd control credential, SSH secrets, master keys, or hook tokens for other sessions in the agent environment.
  - CLI helper may wrap orchestrator REST; never talk agentd with the node control secret from agent context.
  - Document primitives: list, create, prompt, wait, read, send-keys.
  - Ship only after H1 detection path is trusted (D14); feature-flag skill install default off until H2.3 security review.
- **Success criteria:** Skill installable for Claude/Codex/OpenCode on launch (flag); token cannot act outside project; demo script two-agent review in one project; security review signed off in PR description.
- **Tests:** token scope unit tests (allow sibling, deny other project, deny admin); skill dry-run docs test.
- **Validation:** live two-session coordination; `/proc`/env review shows no control credential.
- **Deps:** H2.2, H1.5. **Risk:** **critical security** — threat-model addendum in `docs/security/agent-environment.md`.
- **Out of scope:** whole-node tokens; plugin marketplace.

#### [x] H2.4 — flock-tui / CLI parity for wait & explain

- **Why:** Local elite ops without browser.
- **Scope:** `flock-tui` CLI: improve `sessions wait` to use server-side wait when cap present; add `sessions explain`, `sessions prompt`.
- **Success criteria:** Docs in flock-tui KEYBINDS/PRODUCT updated; works local mode.
- **Tests:** backend mock tests.
- **Validation:** manual local.
- **Deps:** H2.1. **Risk:** low.
- **Done (thin slice):** `sessions explain` / `prompt` / server-side `wait` via `AgentController` when `agent_control_v1` present; poll fallback; unit dispatch tests + CLI help. Full KEYBINDS/PRODUCT polish optional.

---

### PHASE 3 — Attention model, catalog, resume (P1–P2)

#### [x] H3.1 — Unseen-idle attention (`unseenIdle`)

- **Why:** Surface “finished while you were away” without Herdr’s remap of idle → `done`.
- **Scope:** status/telemetry metadata + web (and flock-tui) attention UI.
- **Approach (D9 locked):**
  - Wire status on turn complete remains **`idle`**.
  - Wire **`done` only on session/process end** (existing calm push model).
  - Add boolean (or timestamp) **`unseenIdle`**: set when session becomes idle while not focused/opened; clear when user focuses session, opens pen focus, or sends input.
  - UI: badge / attention section “Ready to review”; **no Web Push** solely for `unseenIdle`.
- **Success criteria:** Away agent finishes turn → appears in review attention; status dot stays Idle; no extra push; focus clears badge.
- **Tests:** unit tests for seen bit transitions; web unit for badge; assert `shouldNotify` unchanged for idle.
- **Validation:** multi-session manual.
- **Deps:** H1.5. **Risk:** low.

#### [x] H3.2 — Expand agent process detection + manifests

- **Why:** Match Herdr catalog for terminal-tier agents.
- **Scope:** agent path detection, launch recipes, manifests for cursor, amp, pi, copilot, etc. as terminal integrations.
- **Approach:** Extend `DetectAgent` / node-info; ship manifests; matrix rows.
- **Success criteria:** node-info lists new tools; screen status works when TUI known; launch from UI.
- **Tests:** path detection tests; fixture tests per new manifest.
- **Validation:** install each CLI on a node once.
- **Deps:** H1.2. **Risk:** low–medium maintenance.

#### [x] H3.3 — Native session resume after agentd restart

- **Why:** Aligns with roadmap F4 + Herdr resume_agents_on_restore.
- **Scope:** persist per-session `{agentKind, cwd, resumeRef, argv, mode}` on node state volume; on agentd start, rehydrate registry and optionally relaunch with native `--resume` / `--continue`.
- **Approach:** Capture resume refs from integrations/hooks/transcripts (Claude session id, Codex rollout, OpenCode session). Do **not** claim PTY continuity — new process, restored conversation.
- **Success criteria:** kill agentd → restart → eligible sessions relaunch resumed or mark `disconnected`/`done` explicitly; UI never spins “reconnecting” forever.
- **Tests:** unit for resume command builders; int test with fake resume ref.
- **Validation:** Vagrant kill -9 agentd; measure recovery.
- **Deps:** roadmap F4 alignment. **Risk:** medium.
- **Out of scope:** live FD handoff (H5.x).

#### [x] H3.4 — Integration install model (optional lifecycle authority)

- **Why:** Herdr separates session-identity integrations vs full lifecycle authority.
- **Scope:** document + optionally seed integrations that only report session ids; keep OpenCode-style plugins as full authority.
- **Approach:** Update matrix “authority” column explicitly (Herdr-style table).
- **Success criteria:** matrix lists authority per agent; no agent claims lifecycle authority without complete events.
- **Tests:** translator tests already exist — add authority tags.
- **Validation:** doc + one live audit.
- **Deps:** H0.4, H1.5. **Risk:** low.

---

### PHASE 4 — Hardening, hot-reload, alt-screen reads (P2)

#### [x] H4.1 — Manifest hot-reload + local overrides

- **Why:** Agent UIs change weekly; shipping a daemon for every rule tweak is too slow.
- **Scope:** `reload_agent_manifests` control op; watch override dir; version logging.
- **Approach:** Same precedence as Herdr: local override > remote cache > bundled. Start without remote CDN.
- **Success criteria:** drop override file → reload → explain shows new rule without process restart.
- **Tests:** reload unit test; invalid override ignored.
- **Validation:** manual.
- **Deps:** H1.2. **Risk:** low.

#### [ ] H4.2 — Optional remote manifest updates

- **Why:** Fleet-wide rule updates without image bump.
- **Scope:** signed manifest bundle URL in orchestrator or agentd config; verify checksum/signature.
- **Approach:** **Security-sensitive** — only signed payloads; default off.
- **Success criteria:** threat model updated; signature failure refuses apply.
- **Tests:** crypto verify tests.
- **Validation:** staging.
- **Deps:** H4.1. **Risk:** high (supply chain) — may defer indefinitely.

#### [ ] H4.3 — Alt-screen intelligent `read` for idle agents

- **Why:** Full-screen agents don’t put history in host scrollback.
- **Scope:** `session.read_screen` recent source: if idle recognized agent + alt-screen + mouse wheel reported, page-scroll capture (Herdr behavior), restore viewport.
- **Approach:** Feature-flag; only when status idle; refuse when working/blocked.
- **Success criteria:** read returns more than one viewport of Claude transcript when idle; viewport restored.
- **Tests:** simulated alt-screen agent; safety tests refuse when working.
- **Validation:** live Claude.
- **Deps:** H1.1, H2.1. **Risk:** medium (input side effects).

#### [x] H4.4 — Performance & memory bounds

- **Why:** Screen model per session must not blow RSS on large fleets.
- **Scope:** metrics: detect latency, RSS delta, CPU; caps on explain evaluated rules.
- **Success criteria:** documented bounds in `operations-memory-bounds.md`; 50 sessions soak OK on reference node.
- **Tests:** benchmark optional.
- **Validation:** soak.
- **Deps:** H1.3. **Risk:** medium.

---

### PHASE 5 — Optional / research (P3)

#### [ ] H5.1 — Worktree automation API for agents

- Expose create/list/open worktree to skill with project scope (Shepherd already has worktree service — wrap for agents).

#### [ ] H5.2 — Plugin model

- Evaluate Herdr plugins vs MCP/skills; do not copy marketplace until skill automation is proven.

#### [ ] H5.3 — Live PTY handoff research

- Spike: can root agentd pass PTY FDs across restart safely under privilege separation? Write spike doc; no production commitment.

#### [ ] H5.4 — Cross-pollinate flock-tui VT with agentd screen model

- Share Go package if useful; avoid two diverging VT stacks long-term.

---

## 4. Dependency graph (implementation order)

```text
H0.1 ─┬─► H1.1 ─► H1.2 ─► H1.3 ─► H1.4
H0.2 ─┤              │       │
H0.3 ─┘              │       ├─► H1.5 ─► H3.1
H0.4 ────────────────┘       │
                             ├─► H2.1 ─► H2.2 ─► H2.3
                             │         └─► H2.4
                             ├─► H3.2
                             ├─► H3.3 (also roadmap F4)
                             └─► H4.1 ─► H4.2
                                   └─► H4.3
H1.3 ─► H4.4
```

**Critical path to “Herdr-class Needs you”:** H0.* → H1.1 → H1.2 → H1.3 → H1.5.  
**Critical path to “agents manage agents”:** critical path above + H2.1 → H2.2 → H2.3.

---

## 5. Testing & validation strategy

### 5.1 Layers

| Layer | What | Gate |
| --- | --- | --- |
| Unit | Engine, VT, authority tables, schema | Always |
| Fixture | Golden detection screens | Always for manifest changes |
| Agentd race | `go test -race` | Always if agentd touched |
| Integration | Fake PTY + orchestrator | PR |
| Live matrix | Real CLIs on Vagrant/local node | Task “done” for detection/automation |
| Security | Token scope, env scrub, no credential leak | H2.3 required |
| Soak | 50 sessions, 30–60 min, flap metrics | Before default-on flag |

### 5.2 Live validation matrix (minimum)

For each agent in `{claude, codex, opencode, grok, antigravity}` × mode Terminal:

| Scenario | Expected |
| --- | --- |
| Fresh launch ready | `idle` (or starting→idle) |
| Running turn | `running` |
| Permission / question UI | `awaiting_input` |
| Turn complete | `idle` |
| Explain | non-empty matched rule or fallback reason |
| Prompt+wait | returns on idle/blocked within timeout |

Chat mode sessions: authority stays on structured transport; screen must not thrash status (H1.5 tests).

### 5.3 Global Definition of Done (inherits Shepherd)

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:int && pnpm build
cd agentd && go test -race ./...
# if web touched:
pnpm test:e2e
```

Plus task-specific live checks above.

### 5.4 Feature flags

| Flag | Default | Flip when |
| --- | --- | --- |
| `screendetect` / env | **on** (D10 flipped; kill-switch `0/false/off/no`) | Live soak continues; fixture/authority gate green |
| `agent_control` | **on** when agentd advertises caps (clients type-assert) | H2.1 + H2.4 CLI |
| `session_automation_token` / skill install | **off** (D14) | H1 path trusted + H2.3 threat model signed off → enable skill install |
| `alt_screen_read` | **off** | H4.3 validated |
| `remote_manifests` | **off** | H4.2 signed (optional; D13 does not require this) |

---

## 6. Explicit non-goals (this program)

1. Replacing `flock-agentd` with the Herdr Rust server.
2. Making Herdr workspace/tab/pane the Shepherd domain model.
3. Shipping Herdr’s mouse-first TUI as Shepherd’s primary UI.
4. Vendoring libghostty-vt into agentd for v1.
5. Guaranteeing zero-downtime PTY FD handoff in v1.
6. Claiming full lifecycle authority for agents whose hooks are incomplete (Claude/Codex hooks for session-id only).
7. Breaking privilege separation to make automation “easier.”
8. Remapping turn-complete unseen idle to wire `done` (Herdr-style) — rejected in D9.
9. Whole-node automation tokens for agents — rejected in D12.
10. Screen `visible_blocker` overriding structured Chat/transport status — rejected in D11.

---

## 7. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| False `awaiting_input` | Alert fatigue, bad automation | Strict blocked rules; idle fallback; explain; flag |
| VT decoder wrong on edge TUIs | Missed state | Fixtures + live matrix; iterative regions |
| Authority flapping | UI noise, push spam | Debounce; source priority ADR; soak |
| Automation token escape | Node takeover | Scoped tokens; no agentd secret; audit; security tests |
| Manifest drift vs Herdr | Divergent maintenance | D13 periodic import script + review; fixtures |
| Scope creep (plugins, handoff) | Never ships P0 | Phase 5 parking lot |
| Protocol drift flock-tui | TUI broken | Shared proto packages (existing alignment work) |

---

## 8. Suggested first implementation sprint (2 weeks, one agent)

If only one sprint: **land screen detection for money state**.

1. H0.1, H0.2, H0.4 (days 1–2)  
2. H0.3 fixtures for claude + codex blocked/idle (day 2–3)  
3. H1.1 minimal screen model (days 3–6)  
4. H1.2 engine + two manifests (days 5–8)  
5. H1.3 default-off → live matrix → only then default-on (D10) (days 8–10)  
6. H1.4 explain (days 10–12)  
7. H1.5 arbitrator (incl. Chat non-override D11) (days 12–14)

**D14:** do not start H2 skill/token work until this sprint’s detection path is trusted.

---

## 9. Doc updates checklist (as work lands)

- [ ] `docs/architecture.md` — screen model + authority + agent control
- [ ] `docs/agent-integration-matrix.md` — authority column; screen path rows
- [ ] `docs/decisions/status-authority.md` (new)
- [ ] `docs/flock-agentd-design.md` — new caps/ops
- [ ] `docs/security/agent-environment.md` — automation tokens
- [ ] `docs/roadmap.md` — cross-links (do not duplicate all tasks)
- [ ] `agentd/COMPATIBILITY.json` — caps
- [ ] `THIRD_PARTY_NOTICES.md` — Herdr attribution
- [ ] flock-tui docs if CLI changes
- [ ] This plan checkboxes

---

## 10. Locked product decisions (summary)

Recorded 2026-08-01. Full table: **§1 Pass F**. No open product questions remain.

| Topic | Locked |
| --- | --- |
| Unseen turn-complete | Wire stays **`idle`** + **`unseenIdle`** metadata; **`done` = session end only** |
| Screendetect rollout | **Default off** until live matrix green, then **default on** |
| Chat mode vs screen | **Transport owns status**; screen diagnostic-only |
| Automation token | **Same project siblings only** |
| Manifest ownership | **Shepherd-adapted** + **periodic reviewed Herdr import** |
| Automation v1 scope | **agentd ops + REST + skill** (after detection trusted) |
| VT approach | **Minimal Go decoder in agentd** |

---

## 11. Appendix — Herdr source map (for implementers)

| Concern | Herdr path |
| --- | --- |
| Detection engine | `herdr/src/detect/manifest.rs`, `mod.rs` |
| Manifests | `herdr/src/detect/manifests/*.toml` |
| Authority / publish | `herdr/src/pane.rs` (screen detection publish, lifecycle skip) |
| Agent API schema | `herdr/src/api/schema/agents.rs`, `common.rs` |
| Waits | `herdr/src/api/wait.rs` |
| Skill | `herdr/skills/herdr/SKILL.md` |
| Agent docs | `herdr/docs/next/.../agents.mdx`, `agent-automation.mdx`, `socket-api.mdx` |
| Session restore | `herdr/docs/.../session-state.mdx`, `src/agent_resume.rs`, integrations |
| Principles | `herdr/AGENTS.md` (state/runtime split, evidence-based detection) |

| Concern | Shepherd path |
| --- | --- |
| Daemon | `shepherd/agentd/` |
| Status transcripts | `shepherd/agentd/internal/status/` |
| Session PTY/ring | `shepherd/agentd/internal/session/` |
| Hook translators | `shepherd/apps/orchestrator/src/status/translators/` |
| Status enum | `shepherd/packages/shared/src/status.ts` |
| Protocol | `shepherd/agentd/proto/`, orchestrator `nodes/agentd/` |
| Matrix | `shepherd/docs/agent-integration-matrix.md` |
| TUI VT (reference) | `flock-tui/internal/vt/` |

---

## 12. Appendix — Status vocabulary crosswalk

| Herdr | Shepherd wire | Shepherd UI |
| --- | --- | --- |
| working | `running` | Working |
| blocked | `awaiting_input` | Needs you |
| idle | `idle` | Idle |
| done (Herdr: often unseen idle) | `done` **only** for session/process end; unseen idle → `idle` + `unseenIdle` | Done / Idle + review badge |
| unknown | *(no wire)* keep previous / idle fallback | — |
| *(n/a)* | `starting` | Starting |
| *(n/a)* | `error` | Error |
| *(n/a)* | `disconnected` | Disconnected |

---

**End of plan.** Decisions are locked. Next step: implement **H0 → H1** critical path (screen detection for Needs you), then **H2** automation per D14.
