# PRD: Conductor — A Web Cockpit for Supervising Coding Agents

**Status:** Draft v1
**Document type:** Build-spec PRD
**Last updated:** 2026-05-28

> Working name: **Conductor**. Rename freely; the name is not load-bearing.

---

## 1. Summary

Conductor is a self-hosted, web-based cockpit for running and supervising multiple
CLI coding agents (Claude Code, Codex, OpenCode) across one or more machines. It runs
as a Docker deployment on an always-on VPS and connects out to other machines ("nodes")
over SSH. Users interact entirely through a browser. The interface deliberately mirrors
the OpenAI Codex desktop app (see §12, Visual design): a left sidebar organizes work as a
`node → project → session` tree, a center pane shows the selected session, a terminal
drawer toggles along the bottom, and a right-hand context/activity sidebar plus a live
browser view round out the session surface.

The product's defining properties:

- **Sessions never die when the user leaves.** Processes live in tmux on always-on
  nodes; management state lives in an always-on orchestrator backed by Postgres. The
  user's own machine is never in the data path — it is just a viewer.
- **You always know which agent needs you.** A unified status model, fed by agent
  lifecycle hooks, drives live sidebar indicators and away-from-keyboard push
  notifications. The key state is "an agent is blocked waiting for *you*."
- **Each session gets its own isolated browser.** A per-session browser stack lets the
  agent drive a real browser (agent-driving layer), and lets the user watch, comment, and
  take over (view/control layer) — both against the same Chrome instance, streamed into
  the web UI. This mirrors the Codex app's split between its in-app browser and "browser
  use."
- **Works with any CLI agent.** Three first-class integrations at launch, with a
  universal terminal-escape-sequence fallback so any agent that can ring a bell gets
  basic status.

This document specifies v1 (small team, single tenant, local auth) and phases the
enterprise surface (SSO, RBAC depth, multi-tenancy) explicitly.

---

## 2. Goals and non-goals

### 2.1 Goals (v1)

1. Run and persist coding-agent sessions on local and remote (SSH) nodes such that
   neither a browser refresh, a user logout, nor an orchestrator restart loses running
   work.
2. Present a `node → project → session` tree with live, accurate per-session status.
3. Deliver a unified status + notification model across Claude Code, Codex, and OpenCode,
   with an escape-sequence fallback for other agents.
4. Provide a live, interactive terminal per session in the browser.
5. Provide an optional live, isolated browser per session that the agent can drive and
   the user can observe/control.
6. Notify the user (in-app and via Web Push) when a session needs attention or finishes.
7. Ship as a reproducible Docker deployment with local authentication and an audit-log
   foundation.

### 2.2 Non-goals (v1)

- Multi-tenant isolation (single tenant only; architected for but not built).
- SSO / SAML / OIDC (phased; local auth only at launch).
- Fine-grained RBAC beyond a small role set (phased).
- A node-side agent/daemon (explicitly rejected for v1 — see §6.4).
- Mobile-native apps (the web UI should be responsive/PWA-capable, but no native app).
- Replacing the agents' own intelligence; Conductor supervises agents, it is not itself
  the coding model.
- Hosting/proxying model API traffic; agents authenticate to their own providers.

---

## 3. Users and use cases

**Primary user:** a developer or small team running several coding agents in parallel
and losing track of which need input, wanting the work off their laptop and reachable
from anywhere.

Representative scenarios:

- Start three agents on three projects, close the laptop, later open a phone browser and
  see that one finished, one errored, and one is waiting for a permission decision.
- Watch an agent navigate a web app in its session browser to verify a UI change, then
  take over the browser to click something itself.
- Reconnect after a week away and find every session exactly where it was, with a
  summary of what happened while away.
- SSH-reach a powerful remote build box as a node and run heavy agents there while the
  orchestrator VPS stays light.

---

## 4. Core concepts and domain model

### 4.1 The tree

```
Node            an execution target: the orchestrator host (local) or a remote SSH host
  └─ Project    a working directory / repo root on that node
       └─ Session   one agent instance = one tmux session = one browser = one status
```

The **session is the atomic unit** and the most important modeling decision: one session
equals one tmux session equals (at most) one browser harness equals one status record.
There is no many-panes-per-session ambiguity. "Project" and "node" are grouping levels in
the sidebar; all binding (browser endpoint, hook callback, agent config) happens at the
session level.

### 4.2 The single session record (single source of truth)

Every session has exactly one authoritative record. Its identity threads through every
subsystem; the same `session_id` names the tmux session, scopes the hook callback token,
and binds the browser endpoint. This discipline is non-negotiable and is what keeps the
system debuggable.

A session record contains at minimum:

- `id` (uuid), `node_id`, `project_id`
- `agent_type` (`claude-code` | `codex` | `opencode` | `generic`)
- `tmux_session_name`
- `working_dir`
- `browser_cdp_endpoint` (nullable; opaque ws URL incl. unguessable GUID)
- `hook_token` (per-session secret carried by hook callbacks)
- `status` (current, see §7) — *runtime/in-memory authoritative; mirrored to DB*
- `created_at`, `last_status_at`, `created_by`

### 4.3 Two independent persistence layers

- **Process persistence (per node):** tmux owns the running agent processes. Survives
  orchestrator restarts and user disconnects.
- **Management persistence (central):** Postgres + always-on orchestrator own identity,
  history, and config. Survives node reboots and connection drops.

The combination is what makes the system bulletproof: a user can vanish for a week and
return to find agents still running and fully tracked.

---

## 5. Architecture overview

```
        Browser (viewer only — never in the data path)
   sidebar + terminal + browser pane
        │  WebSocket: live status + PTY stream
        │  Web Push: away-from-keyboard alerts
        ▼
   Orchestrator  (your app, Docker, always-on VPS)
     ├─ in-memory session status map     ← LIVE path; hooks update; fans out over WS
     ├─ central supervisor-agent         ← the premium differentiator (§9)
     ├─ Postgres                         ← registry, nodes/projects, event log, push subs
     │                                      (NOT on the live status path)
     ├─ per node: one managed SSH connection
     │     ├─ PTY stream (tmux attach)
     │     └─ reverse tunnel (ssh -R)    ← remote-agent hooks curl localhost → back to us
     └─ per session: browser harness (CDP) + screencast stream
```

### 5.1 Topology assumptions

- The orchestrator runs in Docker on an always-on VPS.
- Nodes are other always-on machines reached over SSH (the orchestrator host is itself
  the "local" node). Server-to-server links are far more stable than laptop links, which
  is why best-effort hook delivery is acceptable in v1.
- The user's machine runs only a browser. Closing it affects nothing but the live view.

### 5.2 Component responsibilities

| Component | Owns | Must NOT own |
|---|---|---|
| Browser client | Rendering, input, local notification display | Any source of truth |
| Orchestrator | Status model, agent-contract translation, fan-out, supervisor logic, SSH/tunnel/browser lifecycle | — |
| Postgres | Durable identity, history, config, subscriptions | The live status critical path |
| Node | Dumb transport only (tmux, loopback hook forwarding) | **Any logic or decision-making** |

---

## 6. Technology decisions (and the reasoning)

These are deliberate, researched choices, not defaults. Each names the rejected
alternative so the decision is auditable.

### 6.1 Terminal + persistence: tmux + a web terminal emulator over WebSocket

- **Decision:** PTYs live inside named tmux sessions on each node (`tmux new-session -A
  -s <name>` attaches-or-creates). The browser renders via a web terminal emulator. The
  orchestrator bridges PTY ⇄ WebSocket.
- **Terminal emulator — primary: wterm; fallback: xterm.js.**
  - *Primary — `wterm` (vercel-labs/wterm):* a DOM-rendering web terminal with a VT100/
    VT220/xterm escape-sequence parser written in Zig and compiled to a ~12 KB WASM binary.
    DOM rendering gives native text selection, clipboard, browser find, and screen-reader
    support for free. It ships exactly the transport we need — a WebSocket transport to a
    PTY backend with binary framing and reconnection — plus a React component and
    `useTerminal` hook, alternate-screen support (vim/htop/less), dirty-row rendering, and
    24-bit color. Chosen for fit with the PTY⇄WebSocket bridge and for raw speed
    ("fast" is a launch goal). Apache-2.0.
  - *Fallback — `xterm.js`:* the battle-proven default (VS Code, ttyd). Use it if wterm's
    maturity (currently v0.1.x) or its OSC-handler surface proves insufficient.
- **De-risking spike (required):** confirm wterm exposes handlers for OSC 9/777 (needed
  for the status fallback in §6.3) before committing. If absent or awkward, fall back to
  xterm.js, which has well-established OSC parsing. This single question is the deciding
  factor between primary and fallback.
- **Note on terminology:** "Ghostty/libghostty" is a native GPU terminal and does not
  embed in a web page; a web terminal emulator (wterm or xterm.js) is the correct web
  primitive. This is not a downgrade.

### 6.2 SSH layer

- **Decision:** The orchestrator holds outbound SSH connections to nodes. Terminal
  traffic is tmux-over-SSH. A reverse tunnel (`ssh -R`, loopback-bound) carries hook
  callbacks back from remote nodes. `autossh`-style supervision keeps connections alive.
- **Why:** No inbound ports on nodes, no exposing the orchestrator publicly. The only
  connection needed is the one the orchestrator initiates.

### 6.3 Status signal: agent hooks (primary) → OSC escape sequences (fallback) → PTY watch (floor)

Three channels in descending reliability; the orchestrator translates all into one model.

- **Primary — lifecycle hooks → orchestrator HTTP endpoint.**
  - *Claude Code:* native **HTTP hooks** POST event JSON directly to the orchestrator.
    Events: `SessionStart`, `PreToolUse`/`PostToolUse`, `Notification`
    (subtyped `permission_prompt`, `idle_prompt`), `Stop`/`StopFailure`. A per-session
    token rides an `Authorization` header.
  - *Codex:* same event taxonomy (`PreToolUse`, `PermissionRequest`, `PostToolUse`,
    `Stop`, etc.) via config-declared **command hooks**; the hook is a one-line `curl`
    to the orchestrator (Codex command hooks only — prompt/agent handlers are skipped).
  - *OpenCode:* a small first-party **plugin** (`.opencode/plugin/`) subscribes to events
    (`session.idle`, permission/error/question events, subagent events) and POSTs to the
    orchestrator.
- **Fallback — OSC escape sequences.** The web terminal emulator registers handlers for
  OSC 9 / OSC 777 and BEL (see the §6.1 spike — this capability is the deciding factor in
  the wterm-vs-xterm.js choice). Any agent that emits these (Codex's `tui.notification_method` can be set to
  `osc9`; bare processes can ring BEL) gets basic status with zero integration. This is
  the "any CLI agent" floor.
- **Floor — PTY activity watch.** Detect bell / output-then-quiet for agents with neither
  hooks nor OSC. Heuristic; last resort only.

### 6.4 Node intelligence: dumb courier, central brain (node agent REJECTED for v1)

- **Decision:** Nodes run **no Conductor software**. All intelligence — status model,
  per-agent translation, fan-out, supervisor logic — lives centrally. The node does dumb
  transport only.
- **Why this, despite the pull toward a premium node agent:**
  - The "works with any SSH box out of the box" property requires zero node install.
  - A node-side daemon is a second program that can disagree with the orchestrator about
    state; sidebar-vs-reality disagreement is the fastest way to feel *un*-premium.
    Centralizing truth removes that entire bug class.
  - Premium feel comes from instant, correct status and a smart central supervisor — none
    of which the user can attribute to where logic physically runs.
  - The contract-translation table grows as agents are added; central means one edit
    upgrades the whole fleet instantly, vs. a fleet-wide redeploy.
- **Upgrade path (not v1):** a *thin relay* — a trivial node-side mailbox that buffers
  hook events across SSH gaps and replays them — is the first sanctioned escalation, and
  only if connection gaps prove painful in practice. It holds **no logic**, only buffered
  bytes. A "fat" node agent is justified later only by **data-residency / security**
  requirements (enterprise tier), never by features.

### 6.5 Per-session browser: three layers over one Chrome

The per-session browser is **three distinct layers sharing one real Chrome instance**.
Conflating them (as the original draft did) hides a real design decision. This split also
mirrors how the Codex app separates its in-app browser (view/comment) from "browser use"
(agent operates the page).

**Layer A — the Chrome instance (per session).** One real, isolated browser per session.
Prefer **one container per session** with Chrome bound to the container's loopback,
exposing only that session's mapped endpoint — isolation enforced by the container
boundary, not convention. This is the shared object the other two layers attach to. Note:
like the Codex in-app browser, this isolated instance has no access to the user's real
profile, cookies, extensions, or signed-in sessions — a deliberate isolation boundary,
not a gap.

**Layer B — the agent-driving layer.** How the coding agent *operates* the browser. The
agent connects via CDP to Layer A using the opaque endpoint injected at session creation
(`SESSION_BROWSER_CDP`, full ws URL incl. unguessable GUID — never a bare port), and is
instructed not to launch its own browser.
- *Candidate (behind a spike): `browser-use/browser-harness`.* A thin (~1k-line, MIT,
  Python) editable CDP harness — one websocket to Chrome — where the agent writes missing
  helper code at runtime and accumulates per-site "domain skills." Appealing because it is
  built for exactly this VPS/persistent-browser topology and would give agents strong,
  improving browser control. **Spike gates required before adoption:** (1) its documented
  setup attaches to a user's existing browser via `chrome://inspect` with an interactive
  Allow popup — that is *not* our headless-per-session model, so we'd point it at our own
  launched Chrome / cloud browsers instead; (2) it writes mutable skill state
  (`agent_helpers.py`, `domain-skills/`) on the node — decide where that state lives
  (per-session vs shared, central sync) so it does not violate the dumb-node principle
  (§6.4); (3) it is young and release-less — treat as an option, not a load-bearing v1
  dependency.
- *Fallback:* agents drive the browser through their own native browser tooling / MCP
  over the same CDP endpoint. v1 can ship with the fallback and adopt browser-harness once
  the spike clears.

**Layer C — the human view/control layer.** How the *user* watches and takes over. The
orchestrator pulls frames from the **same** CDP target (Layer A) via
`Page.startScreencast`, streams them to the web UI, and forwards user input (click/scroll/
keys) back as CDP input events when the user takes control. Because B and C attach to the
same Chrome, "the agent's browser" and "the browser I'm watching" are automatically the
same object — no syncing.

- **Why not embed an iframe for Layer C:** target sites block framing (X-Frame-Options/
  CSP). A real driven browser + screencast is the robust path.
- **Upgrade path (Layer C):** for a full interactive desktop or smoother video under load,
  a WebRTC-streamed containerized browser (Neko-style) is the documented escalation. CDP
  screencast is the lighter v1 default.
- **Known cost (Layer C):** screencast frames (JPEG, ~50–100 KB/frame at 720p, per-frame
  round-trip ack, one CDP session per page) are the heaviest traffic in the system.
  Mitigations are first-class requirements (§10.2), not afterthoughts.

### 6.6 Persistence store: Postgres, beside the live path

- **Decision:** Postgres is the durable system of record: session registry, node/project
  definitions, append-only event log (written **async / write-behind**), and Web Push
  subscriptions. The live status map is in memory and fans out over WebSocket without
  touching the DB.
- **Why:** A status dot turning yellow must never wait on a disk write. But identity and
  history must survive an orchestrator crash — on boot, the orchestrator reads the
  registry and re-attaches to still-running tmux sessions and browsers. Memory is the
  present; Postgres is the past and the identity.

### 6.7 Notification delivery: WebSocket (live) + Web Push (away)

- **Decision:** Every status transition updates the in-memory map and fans out over
  WebSocket to connected clients. Transitions to `awaiting_input` or `done` additionally
  fire **Web Push** so the user is alerted with the tab closed or phone pocketed.
- **Why:** WebSocket covers the live view; Web Push covers away-from-keyboard, which is
  the whole point of "don't make me babysit." Both are needed; the same transition
  triggers both.

---

## 7. The status model (the heart of the product)

A single, agent-agnostic status enum per session. Agent-specific events are translated
into it centrally.

| Status | Meaning | Rings sidebar? | Web Push? |
|---|---|---|---|
| `starting` | session/agent initializing | no | no |
| `running` | agent actively working (tool calls in flight) | no | no |
| `awaiting_input` | **blocked, needs the user** (permission/decision) | **yes** | **yes** |
| `idle` | soft idle — quiet but not blocked | gentle dot | no |
| `done` | agent finished its turn/task | no ring | yes |
| `error` | tool/agent failure | yes | yes |
| `disconnected` | node link down; last-known state stale | stale indicator | no |

`awaiting_input` is the money state: it means *the user is the bottleneck*. It is the
primary driver of both the sidebar ring and push.

### 7.1 Source-to-status mapping

| Status | Claude Code | Codex | OpenCode | Universal fallback |
|---|---|---|---|---|
| `starting` | `SessionStart` | `SessionStart` | session start event | pane created |
| `running` | `PreToolUse`/`PostToolUse` | `PreToolUse`/`PostToolUse` | tool execute events | output activity |
| `awaiting_input` | `Notification:permission_prompt` | `PermissionRequest` | permission/question event | OSC 9 / BEL |
| `idle` | `Notification:idle_prompt` | turn-complete + quiet | `session.idle` | quiet timer |
| `done` | `Stop` | `Stop` / agent-turn-complete | `session.idle` / completion | bell then quiet |
| `error` | `StopFailure` / nonzero `PostToolUse` | `PostToolUse` failure | error event | — |
| `disconnected` | (orchestrator-derived: SSH/tunnel down) | same | same | same |

### 7.2 Reconcile-on-reconnect

Hooks fired during an SSH/tunnel gap are **lost, not queued** (v1). On reconnect the
orchestrator re-attaches to the tmux session, establishes current ground truth, and writes
a resync event. It does not attempt to recover individual missed transitions. Postgres
holds last-known state so a disconnected session still shows something meaningful
("last seen: awaiting input, 6m ago").

---

## 8. Functional requirements

### 8.1 Node management
- FR-N1: Add a node by SSH connection details (host, port, user, key reference).
- FR-N2: Establish and supervise a persistent SSH connection per node; auto-reconnect.
- FR-N3: Establish a loopback-bound reverse tunnel per node for hook callbacks.
- FR-N4: Surface node connection status in the UI; mark dependent sessions
  `disconnected` when a node link is down.
- FR-N5: The orchestrator host is a first-class node ("local") using the same model minus
  the SSH hop.

### 8.2 Project management
- FR-P1: Define a project as a working directory on a node.
- FR-P2: List projects per node in the sidebar tree.

### 8.3 Session lifecycle
- FR-S1: Create a session: pick node + project + agent type; orchestrator creates the
  tmux session in the working dir, writes per-session agent hook config / installs the
  OpenCode plugin, injects env (`SESSION_BROWSER_CDP`, hook token/URL), launches the agent.
- FR-S2: Attach the live terminal (web terminal emulator ⇄ PTY) on session select.
- FR-S3: Persist the session record to Postgres at creation; mirror status on transitions.
- FR-S4: On orchestrator boot, read the registry and re-attach to surviving tmux sessions
  and browser harnesses.
- FR-S5: Terminate a session (kill tmux session + browser harness; mark record closed).
- FR-S6: Multiple browser clients may view the same session concurrently.

### 8.4 Status & notifications
- FR-ST1: Accept hook callbacks at a per-session-authenticated HTTP endpoint; translate to
  the status enum; update in-memory map.
- FR-ST2: Parse OSC 9/777 and BEL from the PTY stream as fallback signals.
- FR-ST3: Fan out every transition over WebSocket to connected clients.
- FR-ST4: Fire Web Push on `awaiting_input`, `done`, `error`.
- FR-ST5: Write every event to the Postgres event log asynchronously (off the live path).
- FR-ST6: Render per-session status in the sidebar (dot/ring) and a "needs attention"
  ordering.

### 8.5 Per-session browser (three layers, §6.5)
- FR-B1: Optionally launch an isolated browser (Layer A) per session — prefer one
  container per session.
- FR-B2: Inject the opaque CDP endpoint into the session env; instruct the agent to drive
  it (Layer B). Ship with native/MCP driving as fallback; adopt browser-harness post-spike.
- FR-B3: Stream the browser viewport to the UI via CDP screencast on demand (Layer C).
- FR-B4: Forward user input to the browser via CDP when the user takes control (Layer C).
- FR-B5: Support browser comments/annotations on the streamed page that the agent can be
  asked to address (Codex-parity feature; may be v1.x).
- FR-B6: Tear down the entire browser stack on session termination.

### 8.6 Auth & audit (v1 scope)
- FR-A1: Local username/password authentication; sessions/cookies; TLS required.
- FR-A2: A minimal role set (e.g., `admin`, `member`) gating node/session management.
- FR-A3: Append-only audit log of security-relevant actions (login, node add, session
  create/terminate, takeover of a browser) in Postgres — the foundation later extended
  for enterprise.
- FR-A4: Secure storage/reference for node SSH keys (not plaintext columns).

---

## 9. The differentiator: the central supervisor-agent

This is where "premium / enterprise" is earned — in the **central brain**, surfaced in the
UI, not in a hidden node daemon. It operates over the session graph and the event log the
system already collects.

Candidate capabilities (prioritize for post-core v1 / v1.x):
- **Attention triage:** rank sessions by who needs the user most (e.g., a 4-minute-blocked
  permission prompt surfaces above a glance-only idle).
- **Away summaries:** on reopening a session, greet with "ran the test suite, 2 failures,
  waiting on your call about the migration" instead of a wall of scrollback.
- **Recursive watching:** watch CI or long tasks and notify by urgency.
- **Recovery narration:** after a reconnect, state what was recovered and what is stale.

Design rule: the supervisor reads from central data and acts through the orchestrator. It
never requires logic on a node.

---

## 10. Non-functional requirements

### 10.1 Security
- NFR-SEC1: TLS termination in front of the orchestrator; no plaintext exposure.
- NFR-SEC2: The orchestrator concentrates SSH keys to all nodes — treat as a high-value
  secret store; encrypt at rest, restrict access, log use.
- NFR-SEC3: Per-session hook tokens; reject hook callbacks without a valid token.
- NFR-SEC4: Reverse tunnels bound to node loopback only (no `GatewayPorts`).
- NFR-SEC5: Browser harness isolation per session (container boundary preferred).
- NFR-SEC6: Authn required for all UI/API/WebSocket connections.

### 10.2 Performance / "fast"
- NFR-PERF1: Sidebar status updates must not block on DB writes (in-memory + async log).
- NFR-PERF2: Terminal input-to-echo latency target: imperceptible on LAN/datacenter links.
- NFR-PERF3: Browser screencast is the known bottleneck; provide controls: cap concurrent
  active streams, reduce frame rate on background/unfocused panes, adjustable JPEG quality,
  and a documented WebRTC upgrade path for heavy use.

### 10.3 Availability / resilience
- NFR-AV1: Orchestrator restart must not kill running agent work (tmux owns processes).
- NFR-AV2: Node reboot or link drop degrades gracefully to `disconnected` + reconcile.
- NFR-AV3: Postgres is the recovery anchor; back it up.

### 10.4 Deployability
- NFR-DEP1: Single `docker compose up` brings up orchestrator + Postgres (+ per-session
  browser containers managed dynamically).
- NFR-DEP2: Reproducible config; secrets via environment/secret files, not baked images.

---

## 11. Open questions / risks

1. **Browser-at-scale bandwidth.** Several concurrent session-browsers over SSH to remote
   nodes will stress the screencast path. Mitigations specced (NFR-PERF3); validate early
   with a load test before committing to CDP-screencast as the long-term default.
2. **Per-session browser containers vs. processes.** Containers give real isolation but add
   orchestration weight (lifecycle, cleanup, resource caps). Decide the default and a cap
   on concurrent browsers per node.
3. **Hook config injection mechanics per agent.** Writing per-session
   `.claude/settings.json` / Codex `config.toml` / OpenCode plugin without clobbering a
   user's own config needs a clean, reversible strategy (e.g., session-scoped config dirs).
4. **Reconcile fidelity.** Establishing exact "current state" of an agent after a gap may
   be imperfect for some agents; define acceptable approximation per agent.
5. **Generic-agent UX expectations.** The OSC/PTY fallback gives coarse status only; set
   user expectations so "any agent" doesn't imply full-fidelity status for unintegrated
   agents.
6. **Secret management depth for v1.** How far to go on SSH key protection before SSO/RBAC
   land — pick a pragmatic v1 bar that does not require rework later.
7. **wterm OSC-handler spike (blocks §6.1).** Confirm wterm exposes OSC 9/777 handlers
   needed for the status fallback. If not, use xterm.js. Resolve before terminal work.
8. **browser-harness adoption spike (blocks §6.5 Layer B).** Resolve the three gates:
   headless attach (vs. its `chrome://inspect` flow), where mutable skill state lives, and
   maturity risk. Until resolved, ship native/MCP browser-driving as the Layer B fallback.
9. **Center-pane model.** Codex's center is a chat thread; ours is a live agent terminal.
   Validate that a terminal-first center still delivers the Codex *feel* (it should, since
   the supervision value lives in the sidebars), or whether a light conversation/summary
   overlay above the terminal is worth adding for parity.

---

## 12. Visual design — match the Codex app

> **Sourcing note (read this).** This section is built from OpenAI's *published descriptions*
> of the Codex desktop app — its docs pages at developers.openai.com/codex/app and
> /codex/app/features, including screenshot alt-text and feature prose. It is **not** built
> from pixel-level inspection of the rendered app; no actual screenshots were viewed. Treat
> this as a high-fidelity *design intent* spec derived from authoritative descriptions, to
> be refined against real screenshots/the running app during design. Where Conductor must
> diverge from Codex, it is called out explicitly.

**Goal:** Conductor's UI should feel like the Codex desktop app to anyone who has used it —
same spatial model, same calm density, same supervision-first emphasis — while honestly
diverging where our product is terminal/agent-CLI-first rather than chat-thread-first.

### 12.1 Reference layout (as Codex describes it)

The Codex app is described as "a focused desktop experience for working on Codex threads in
parallel," with screenshots captioned as "a project sidebar, active thread, and review
pane." The reconstructed spatial model:

- **Left sidebar:** projects, each containing **threads** (Codex's unit of work). Also
  hosts Skills and navigation. This is the supervision list — the "what's running / what
  needs me" surface.
- **Center pane:** the active **thread** — in Codex, a conversation view.
- **Bottom terminal drawer:** an integrated terminal scoped to the current project/
  worktree, toggled with `Cmd+J`, that the agent can also read from.
- **Right-hand task sidebar:** surfaces the agent's plan, sources, generated artifacts, and
  task summary; also previews non-code artifacts (PDF/sheets/docs/slides).
- **Diff / review pane:** Git diff with inline comments, stage/revert, commit/push/PR.
- **In-app browser view:** preview/comment on local dev servers and public pages.
- Light and dark themes are both first-class (every screenshot ships `-light` and `-dark`).
- Command palette on `Cmd+K`; clear terminal is `Ctrl+L`.

### 12.2 Conductor's mapping (and deliberate divergences)

| Codex element | Conductor equivalent | Divergence |
|---|---|---|
| Project → **Thread** | Project → **Session** | We add a **Node** level above Project (multi-machine over SSH); Codex is single-machine with Local/Worktree/Cloud *modes* per thread. |
| Center = chat thread | Center = **live terminal (the agent's TUI)** | **Primary divergence:** our agents are CLI TUIs, so the center is a real terminal (wterm), not a chat transcript. The agent's own UI *is* the conversation. |
| Bottom terminal drawer (`Cmd+J`) | Secondary shell drawer (`Cmd+J`) | Optional: a second shell in the session's dir for the user, distinct from the agent's terminal. |
| Right task sidebar (plan/sources/artifacts/summary) | Right **activity sidebar** | Strong fit — fed by hook events + the supervisor-agent (§9): status timeline, away-summary, plan/steps, artifacts. This is where our premium supervisor surfaces. |
| Diff / review pane | Diff / review pane | Parity feature; can be v1.x. Reads `git diff` in the session working dir. |
| In-app browser + "browser use" | Three-layer per-session browser (§6.5) | Direct parity; our Layer C ≈ in-app browser, Layer B ≈ "browser use." |
| Local / Worktree / Cloud modes | Node selection (+ optional worktree) | Our "where it runs" axis is Node; worktree support is a v1.x parity add. |
| Notifications when backgrounded | WebSocket + Web Push (§6.7) | We extend to true away-from-device push since we're web/always-on, not a local desktop app. |

### 12.3 Look-and-feel requirements

- **FR-UI1:** Three-region desktop layout — left tree sidebar, center session pane, right
  activity sidebar — with a toggleable bottom terminal drawer (`Cmd+J`) and a command
  palette (`Cmd+K`). Match Codex's spatial proportions and calm density.
- **FR-UI2:** First-class light and dark themes.
- **FR-UI3:** The left sidebar is both navigation *and* the supervision dashboard: every
  session shows a status indicator (§7) and a "needs attention" ordering, so the tree
  doubles as the "which agent needs me" view. This is the single most important
  Codex-parity behavior — the status-bearing list is what makes it *feel* like Codex
  rather than a file tree with terminals.
- **FR-UI4:** Center pane defaults to the session's live terminal; tabs/segments switch to
  the session's browser view (Layer C) and the diff/review pane.
- **FR-UI5:** Right activity sidebar shows the supervisor-derived plan, status timeline,
  away-summary, and artifacts for the selected session.
- **FR-UI6:** Responsive / PWA-capable so the same layout collapses gracefully to a phone
  (the away-from-keyboard "which agent needs me + approve/deny" use case).
- **FR-UI7:** Keyboard-first parity where sensible (`Cmd+K` palette, `Cmd+J` terminal,
  quick session switching).

### 12.4 Honest gap

The closest pixel match requires the real app in front of the designer. This section gets
the *structure, regions, terminology, interactions, and theming* right from authoritative
descriptions; final spacing, type scale, color, and motion should be tuned against the
actual Codex app during the design phase. Do not treat 12.3 as a finished visual spec —
treat it as the correct skeleton to dress.

---

## 13. Phasing

**Phase 1 — Core (this PRD's center of gravity)**
Single tenant, local auth. Node/project/session tree in a Codex-style layout (§12).
tmux + web-terminal (wterm, xterm.js fallback) with persistence. Claude Code + Codex +
OpenCode hook integrations on the unified status model; OSC/PTY fallback. WebSocket live
status + Web Push. Postgres registry + async event log + audit-log foundation.
Three-layer per-session browser (CDP screencast). Docker Compose deploy.

**Phase 2 — Premium supervisor**
Central supervisor-agent capabilities (§9): attention triage, away summaries, recursive
watching, recovery narration.

**Phase 3 — Enterprise surface**
SSO/SAML/OIDC; deeper RBAC; richer audit/compliance reporting; multi-tenancy isolation.
Optional node-side **thin relay** for guaranteed hook delivery across gaps. Optional
edge processing for **data-residency** customers. WebRTC browser-streaming upgrade.

---

## 14. Appendix: rejected alternatives (quick reference)

- **Node-side agent/daemon in v1** — rejected (§6.4): scope, sync-bug risk, fights
  zero-install promise. Logic stays central.
- **iframe-embedded browser** — rejected (§6.5): target sites block framing.
- **Postgres on the live status path** — rejected (§6.6): couples a status dot to a disk
  write.
- **libghostty in the browser** — not applicable (§6.1): native-only; a web terminal
  emulator (wterm primary, xterm.js fallback) is the web primitive.
- **Inbound hook connections to remote nodes** — rejected (§6.2): requires exposing ports;
  reverse tunnel uses the connection we already own.
