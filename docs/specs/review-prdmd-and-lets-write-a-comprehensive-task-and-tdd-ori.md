# Flock — Comprehensive TDD Build Plan & Specification

**Project:** Flock — a web cockpit for supervising a _flock_ of CLI coding agents
**Derived from:** `PRD.md` (working name "Conductor"; renamed **Flock**)
**Spec type:** Implementation spec + TDD-oriented, phased task plan
**Status:** Ready for implementation
**Created:** 2026-05-29

> This document layers concrete engineering decisions (stack, structure, sequencing,
> testing) on top of `PRD.md`. The PRD remains the authoritative source for _product
> intent_; this spec is the authoritative source for _how we build it_. Every FR-/NFR-
> reference points back to `PRD.md`.

---

## 1. Overview

Flock is a self-hosted, web-based cockpit for running and supervising multiple CLI coding
agents (Claude Code, Codex, OpenCode) across one or more machines over SSH. It runs as a
Docker deployment on an always-on VPS. Users interact entirely through a browser (PWA).
The UI deliberately mirrors the OpenAI Codex desktop app's spatial model — a
`node → project → session` tree on the left, a live agent terminal in the center, a
supervisor-fed activity sidebar on the right, a toggleable bottom shell drawer, and a
per-session live browser — **but runs on the web**.

Defining properties (from PRD §1):

1. **Sessions never die when the user leaves** (tmux owns processes; Postgres + always-on
   orchestrator own identity/history; the user's machine is only a viewer).
2. **You always know which agent needs you** (unified status model → live sidebar +
   Web Push; the money state is `awaiting_input`).
3. **Each session gets its own isolated browser** (three layers over one Chrome).
4. **Works with any CLI agent** (3 first-class hook integrations + OSC/PTY fallback).

## 2. Problem statement

A developer running several agents in parallel loses track of which need input, wants the
work off their laptop, and wants to reach it from anywhere. Existing CLI agents die with
the terminal and give no unified, away-from-keyboard signal of "this one is blocked on
_you_." Flock solves persistence, unified status, away alerts, and per-session browser
supervision in one Codex-familiar surface.

---

## 3. Engineering decisions (interview outcomes)

| Area                            | Decision                                                                                         | Rationale                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                         | **Node.js + TypeScript**                                                                         | Best ecosystem fit: `ws`, `node-pty`, `ssh2`, `chrome-remote-interface`, Prisma/Drizzle. Client-agnostic API.                                                                                         |
| Frontend                        | **React + Vite + TypeScript**                                                                    | wterm ships a React component + `useTerminal` hook (PRD §6.1). Tailwind + Radix/shadcn for Codex-calm density.                                                                                        |
| Repo                            | **pnpm monorepo**                                                                                | `apps/orchestrator`, `apps/web`, `packages/shared` (domain types, status enum, API/WS contracts, zod schemas). `apps/mobile` drops in later.                                                          |
| Mobile                          | **PWA now + native-ready API**                                                                   | Installable PWA + Web Push (iOS 16.4+). REST/WS contracts + shared TS types so a native app later needs only an APNs/FCM push adapter — no backend rework.                                            |
| v1 scope                        | **Full PRD Phase 1 + read-only Diff pane**                                                       | Includes 3-layer per-session browser. Browser comments (FR-B5) and worktrees → v1.x. Supervisor-agent (§9) → Phase 2. Enterprise (§3 PRD phasing) → Phase 3.                                          |
| Node transport                  | **Local + SSH in parallel behind a `NodeTransport` interface**                                   | Same test suite runs against both impls; local = SSH minus the hop (FR-N5).                                                                                                                           |
| Browser location                | **Per-session Chrome containers always on the orchestrator VPS**                                 | Keeps nodes 100% dumb (§6.4). Agent reaches CDP over the reverse tunnel; Layer C screencast is local to the orchestrator.                                                                             |
| Hook injection                  | **Session-scoped config dirs + env**                                                             | Per-session isolated config dir (e.g. `CLAUDE_CONFIG_DIR`/`XDG_CONFIG_HOME` → per-session temp dir) layered over the user's real config; reversible; cleaned on teardown (PRD open-Q #3).             |
| Reconcile                       | **Re-attach + ground-truth probe + resync event + coarse PTY-scrollback heuristic**              | On reconnect, re-attach tmux, probe state, scan recent scrollback to infer idle/awaiting during the gap, write a resync event; do not replay missed transitions (PRD §7.2).                           |
| Screencast controls (all in v1) | **Cap concurrent streams · throttle/pause unfocused · adjustable JPEG quality · on-demand only** | NFR-PERF3; screencast is the known bottleneck.                                                                                                                                                        |
| Spikes                          | **Phase 0, gated before commit**                                                                 | wterm OSC-handler spike (blocks §6.1 terminal choice) and browser-harness 3-gate spike (blocks §6.5 Layer B). Throwaway, timeboxed, explicit go/no-go.                                                |
| Auth                            | **First-run admin setup + invite**                                                               | argon2id hashing, httpOnly secure session cookies, TLS required, roles `admin`/`member` (FR-A2).                                                                                                      |
| Secrets                         | **App-level encryption at rest**                                                                 | SSH private keys + hook tokens encrypted (libsodium/XChaCha20-Poly1305 or AES-256-GCM) with a master key from env/secret file; ciphertext in Postgres; key use logged; pluggable for KMS/Vault later. |
| Center pane                     | **Terminal-first**                                                                               | Center = live agent TUI (tab group: Terminal \| Browser \| Diff). Conversation/summary feel lives in the right activity sidebar.                                                                      |
| Design fidelity                 | **Codex-faithful skeleton + distinctive Flock polish**                                           | Match spatial model, calm density, light/dark, Cmd+K/J exactly; use `frontend-design` skill for an original production-grade Flock identity (not a pixel clone).                                      |
| Testing                         | **Layered pyramid**                                                                              | Vitest unit (pure logic, TDD-first), dockerized integration (real tmux/ssh/Postgres), Playwright e2e (UI shell), per-agent hook **contract tests**.                                                   |
| CI gate                         | **Full gate**                                                                                    | `tsc --noEmit` + eslint + vitest unit + dockerized integration + Playwright e2e smoke + production build.                                                                                             |

---

## 4. Scope

### 4.1 In scope (v1)

- Monorepo, shared contracts package, Postgres schema + migrations.
- Local auth (first-run admin + invite), roles, session cookies, TLS, encrypted secret store, append-only audit log.
- `Node → Project → Session` domain model with a single authoritative session record.
- `NodeTransport` abstraction with **local** and **SSH** implementations; managed SSH connections, autossh-style supervision, loopback reverse tunnel for hook callbacks.
- tmux-backed process persistence; PTY ⇄ WebSocket bridge; web terminal (wterm primary / xterm.js fallback, decided by Phase-0 spike).
- Unified status model + per-session-token hook HTTP endpoint; first-class integrations for **Claude Code, Codex, OpenCode**; OSC 9/777 + BEL fallback; PTY-activity floor.
- WebSocket live status fan-out; **Web Push** on `awaiting_input` / `done` / `error`.
- In-memory status map (live path) + async/write-behind Postgres event log.
- Reconcile-on-reconnect (re-attach + probe + scrollback heuristic + resync event).
- Three-layer per-session browser: Layer A (isolated Chrome container on VPS), Layer B (agent drives via injected opaque CDP endpoint; native/MCP driving fallback in v1, browser-harness post-spike), Layer C (CDP screencast view + input takeover) with all four bandwidth controls.
- Codex-style UI: 3-region layout, bottom shell drawer (`Cmd+J`), command palette (`Cmd+K`), light/dark themes, status-bearing tree with "needs attention" ordering, center tab group (Terminal \| Browser \| **read-only Diff**), right activity sidebar, responsive/PWA, keyboard parity.
- Docker Compose deploy (orchestrator + Postgres + dynamic per-session browser containers).

### 4.2 Out of scope (v1 — explicit)

- Supervisor-agent capabilities (§9 PRD) — Phase 2.
- SSO/SAML/OIDC, deep RBAC, multi-tenancy — Phase 3.
- Node-side agent/daemon and thin relay — rejected for v1 (§6.4); hooks during gaps are **lost, not queued**.
- Native mobile app (API is native-_ready_ only).
- Browser comments/annotations (FR-B5), git worktree mode, diff stage/commit/PR actions — v1.x.
- WebRTC browser streaming — documented upgrade path, not built.
- Hosting/proxying model API traffic; agents auth to their own providers.

### 4.3 What Ralph/implementer should ignore even if it seems relevant

- Do **not** add any node-side logic/daemon (PRD §6.4 is non-negotiable for v1).
- Do **not** put Postgres on the live status path (PRD §6.6).
- Do **not** embed target sites via iframe for Layer C (PRD §6.5 — framing is blocked).
- Do **not** expose inbound ports on nodes (reverse tunnel only, PRD §6.2).

---

## 5. Architecture (concrete)

```
Browser/PWA (viewer only)  ──WS: status + PTY──┐   ──Web Push: away alerts──┐
                                               ▼                            ▼
apps/web (React+Vite+TS, wterm)        apps/orchestrator (Node+TS, Docker, VPS)
  - tree sidebar (status)                ├─ in-memory status map  ← LIVE; hooks update; WS fan-out
  - center tabs: term|browser|diff       ├─ hook HTTP endpoint (per-session token auth)
  - right activity sidebar               ├─ NodeTransport: { LocalTransport | SshTransport }
  - bottom shell drawer (Cmd+J)          │     ├─ PTY stream (tmux attach)
  - command palette (Cmd+K)              │     └─ reverse tunnel (ssh -R, loopback) [SSH only]
  - light/dark themes                    ├─ per-session browser harness (CDP) on VPS
                                         │     ├─ Layer A: isolated Chrome container
packages/shared (TS)                     │     ├─ Layer B: agent drives via opaque CDP ws
  - StatusEnum, domain types             │     └─ Layer C: Page.startScreencast → WS → UI
  - REST + WS contracts (zod)            ├─ Web Push (VAPID)
  - agent hook payload schemas           └─ Postgres (registry, nodes/projects, event log
                                                async/write-behind, push subs, audit, users, secrets)
```

### 5.1 Component responsibility table (PRD §5.2 — enforced in code)

- **Browser client:** rendering, input, local notification display. Owns no source of truth.
- **Orchestrator:** status model, agent-contract translation, fan-out, SSH/tunnel/browser lifecycle, secrets, auth.
- **Postgres:** durable identity, history, config, subscriptions, audit. Never on the live status critical path.
- **Node:** dumb transport only (tmux, loopback hook forwarding). No logic.

---

## 6. Data model (Postgres)

> Implemented via migrations (Prisma or Drizzle — implementer's choice; Drizzle preferred
> for SQL transparency + lightweight migrations). All `id` are uuid. Secrets stored as
> ciphertext columns, never plaintext.

- **users**: `id, username (unique), password_hash (argon2id), role (admin|member), created_at, last_login_at, is_active`
- **sessions_auth** (web login sessions): `id, user_id, expires_at, created_at, user_agent, revoked_at` (httpOnly cookie holds the id)
- **nodes**: `id, name, kind (local|ssh), host, port, ssh_user, ssh_key_ref (FK secrets), connection_status (connected|connecting|disconnected|error), last_seen_at, created_by, created_at`
- **projects**: `id, node_id, name, working_dir, created_at`
- **agent_sessions** (the single authoritative session record, PRD §4.2): `id, node_id, project_id, agent_type (claude-code|codex|opencode|generic), tmux_session_name, working_dir, browser_cdp_endpoint (nullable opaque ws URL w/ GUID), hook_token_hash, status, status_detail, created_at, last_status_at, created_by, closed_at`
  - **Note:** live `status` is in-memory authoritative; this column is the **mirror** (PRD §4.2, §6.6).
- **events** (append-only, write-behind): `id, session_id, ts, type, source (hook|osc|pty|orchestrator), agent_event_raw (jsonb), mapped_status, detail`
- **push_subscriptions**: `id, user_id, endpoint, p256dh, auth, created_at`
- **audit_log** (append-only, FR-A3): `id, ts, user_id, action (login|node_add|node_remove|session_create|session_terminate|browser_takeover|secret_access|...), target_type, target_id, ip, detail`
- **secrets**: `id, kind (ssh_key|hook_token|...), ciphertext (bytea), nonce, key_version, created_at` (master key from env/secret file; `key_version` enables rotation)

**Invariant (PRD §4.2):** one `session_id` names the tmux session, scopes the hook token,
and binds the browser endpoint. This thread-through is asserted in tests.

---

## 7. The status model (PRD §7 — heart of the product)

`StatusEnum` (in `packages/shared`): `starting | running | awaiting_input | idle | done | error | disconnected`.

| Status             | Rings sidebar   | Web Push |
| ------------------ | --------------- | -------- |
| starting           | no              | no       |
| running            | no              | no       |
| **awaiting_input** | **yes**         | **yes**  |
| idle               | gentle dot      | no       |
| done               | no ring         | yes      |
| error              | yes             | yes      |
| disconnected       | stale indicator | no       |

**Source→status translation** is a pure function per agent (PRD §7.1), unit-tested first
via contract tests over recorded payloads:

- Claude Code: `SessionStart`→starting; `PreToolUse/PostToolUse`→running; `Notification:permission_prompt`→awaiting_input; `Notification:idle_prompt`→idle; `Stop`→done; `StopFailure`/nonzero PostToolUse→error.
- Codex: analogous `PreToolUse/PostToolUse`, `PermissionRequest`→awaiting_input, turn-complete+quiet→idle, `Stop`→done, PostToolUse failure→error.
- OpenCode: plugin events `session.idle`, permission/question→awaiting_input, error→error, completion→done.
- Universal fallback: pane created→starting; output activity→running; OSC 9/BEL→awaiting_input; quiet timer→idle; bell-then-quiet→done.
- `disconnected` is orchestrator-derived (SSH/tunnel down).

---

## 8. API & WS contracts (in `packages/shared`, zod-validated)

### 8.1 REST (authed via session cookie unless noted)

- `POST /api/auth/setup` (first-run only; 409 once an admin exists) — create initial admin.
- `POST /api/auth/login` → sets cookie; `POST /api/auth/logout`; `GET /api/auth/me`.
- `POST /api/users` (admin) invite/create; `GET /api/users` (admin).
- `GET/POST /api/nodes`, `DELETE /api/nodes/:id`, `GET /api/nodes/:id/status`.
- `GET/POST /api/projects`, scoped by node.
- `GET/POST /api/sessions`, `DELETE /api/sessions/:id` (terminate), `GET /api/sessions/:id`.
- `GET /api/sessions/:id/diff` — read-only `git diff` of working dir.
- `POST /api/push/subscribe`, `DELETE /api/push/subscribe`.
- `POST /api/sessions/:id/browser/(start|stop|takeover|release)`.
- **`POST /api/hooks/:sessionId`** — hook callback endpoint; auth via per-session `Authorization` token (NOT cookie); body = agent event JSON; **fast-path**, never blocks on DB.

### 8.2 WebSocket channels (one authed socket, multiplexed)

- `status` — every status transition fans out `{sessionId, status, detail, ts}`.
- `pty:<sessionId>` — binary PTY stream (terminal in/out), reconnect-capable.
- `screencast:<sessionId>` — Layer C frames (JPEG) + input forwarding when in control.
- `nodes` — node connection-status changes.

---

## 9. User stories (TDD-first; each ≈ one focused session)

> Each story: write the failing test(s) first, then implement to green. "Verify in
> browser" stories also get a Playwright smoke. Every story must also pass the global CI
> gate (§12).

### Phase 0 — Spikes (throwaway, gated)

**US-0a: wterm OSC-handler spike.**
_As a builder, I need to know whether wterm exposes OSC 9/777 + BEL handlers so I can pick the terminal emulator._

- [ ] Timeboxed throwaway harness loads wterm, feeds a stream containing OSC 9, OSC 777, BEL.
- [ ] **Go/no-go documented:** if wterm surfaces handlers for all three → adopt wterm; else → xterm.js. Decision written to `docs/decisions/terminal.md`.
- [ ] No production code depends on the spike artifacts.

**US-0b: browser-harness 3-gate spike.**
_As a builder, I need to resolve the browser-harness gates before relying on it for Layer B._

- [ ] Verify it can attach to **our** launched headless Chrome (not `chrome://inspect` Allow-popup flow).
- [ ] Decide where mutable skill state (`agent_helpers.py`, `domain-skills/`) lives without violating dumb-node (§6.4) — documented.
- [ ] Maturity assessment recorded. **Decision:** adopt post-spike or ship native/MCP Layer B fallback for v1. Written to `docs/decisions/browser-driving.md`.

### Phase 1 — Foundation

**US-1: Monorepo + shared contracts.**

- [ ] `pnpm` workspace with `apps/orchestrator`, `apps/web`, `packages/shared`.
- [ ] `packages/shared` exports `StatusEnum`, domain types, zod schemas for REST/WS; imported by both apps.
- [ ] `pnpm -r typecheck` and `pnpm -r build` pass; a sample shared type used in both apps compiles.

**US-2: Postgres schema + migrations.**

- [ ] Migrations create all §6 tables; `pnpm migrate` is idempotent.
- [ ] Integration test (dockerized Postgres) inserts/reads a session record and asserts the §4.2 identity invariant.

**US-3: Secret store (encryption at rest).**

- [ ] `encrypt(plaintext)`/`decrypt(ciphertext)` using master key from env; unit tests cover round-trip, wrong-key failure, `key_version`.
- [ ] Storing an SSH key writes ciphertext only (assert no plaintext in DB); `secret_access` audit row written on decrypt.

**US-4: First-run admin setup.**

- [ ] `POST /api/auth/setup` creates admin when none exists; returns 409 otherwise. argon2id hash stored.
- [ ] Web first-run screen creates admin and redirects to login. Verify in browser.

**US-5: Login / session cookies / roles.**

- [ ] `POST /api/auth/login` validates argon2id, sets httpOnly+Secure+SameSite cookie; bad creds → 401.
- [ ] Authed middleware rejects no/invalid cookie with 401; admin-only routes reject `member` with 403.
- [ ] `login` audit row written. Logout revokes the session row.

**US-6: User invite (admin).**

- [ ] Admin creates a `member`; member can log in; member cannot hit admin routes. Verify in browser.

### Phase 2 — Node transport, tmux, terminal

**US-7: `NodeTransport` interface + LocalTransport.**

- [ ] `NodeTransport` defines `exec`, `openPty`, `dispose`. Local impl runs against the orchestrator host.
- [ ] Same contract test suite green for LocalTransport (dockerized).

**US-8: SshTransport + supervised connection.**

- [ ] Add SSH node (host/port/user/key-ref); orchestrator opens a managed `ssh2` connection; status → `connected`.
- [ ] autossh-style auto-reconnect: killing the connection flips node to `disconnected` then back to `connected`; integration test against a dockerized sshd.
- [ ] Same `NodeTransport` contract suite green for SshTransport.

**US-9: Reverse tunnel for hooks (SSH).**

- [ ] `ssh -R` loopback-bound tunnel established per SSH node; a `curl localhost:<port>` on the node reaches the orchestrator hook endpoint.
- [ ] Tunnel bound to loopback only (no GatewayPorts) — asserted (NFR-SEC4).

**US-10: tmux session create/attach.**

- [ ] Creating a session runs `tmux new-session -A -s <name>` in the working dir via the node's transport; record persisted (FR-S3).
- [ ] Orchestrator-boot re-attach: an existing tmux session is rediscovered and re-bound on restart (FR-S4). Integration test kills+restarts orchestrator process, asserts session survives (NFR-AV1).

**US-11: PTY ⇄ WebSocket bridge.**

- [ ] `pty:<id>` streams tmux output to the client and forwards input; binary framing; reconnect resumes.
- [ ] Two clients attach to the same session concurrently and both see output (FR-S6).

**US-12: Terminal renders in the web shell.**

- [ ] Selecting a session mounts the chosen emulator (wterm/xterm.js per US-0a) bound to `pty:<id>`; typing echoes; vim/htop alt-screen works. Verify in browser + Playwright smoke.

**US-13: Terminate session.**

- [ ] `DELETE /api/sessions/:id` kills tmux + browser harness, marks record closed, writes `session_terminate` audit row (FR-S5).

### Phase 3 — Status, hooks, notifications

**US-14: In-memory status map + WS fan-out.**

- [ ] Status transitions update the in-memory map and fan out over `status` WS **without any DB read/write on the path** (NFR-PERF1) — asserted by a test that fails if the DB is touched synchronously.

**US-15: Hook endpoint + per-session token auth.**

- [ ] `POST /api/hooks/:sessionId` accepts valid token (header), rejects missing/invalid with 401 (NFR-SEC3); token compared against `hook_token_hash`.

**US-16: Claude Code translator (contract test).**

- [ ] Recorded Claude payloads map to the correct `StatusEnum` per §7.1; pure-function unit tests cover every event.

**US-17: Codex translator (contract test).** — analogous to US-16.
**US-18: OpenCode translator + plugin (contract test).**

- [ ] OpenCode plugin in `.opencode/plugin/` POSTs events; recorded payloads map correctly.

**US-19: Session-scoped hook config injection.**

- [ ] On session create, Flock seeds a per-session config dir (env-pointed) with its hooks layered over the user's real config; the user's own config files are untouched (asserted); teardown removes the scoped dir (PRD open-Q #3).

**US-20: OSC 9/777 + BEL fallback.**

- [ ] Emulator/PTY-side OSC handler maps OSC 9/BEL → `awaiting_input` for a generic agent (FR-ST2). Floor: output-then-quiet heuristic → idle/done.

**US-21: Async event log (write-behind).**

- [ ] Every transition enqueues an `events` row written off the live path; a slow/blocked DB does not delay fan-out (NFR-PERF1) — tested with an artificially slow writer.

**US-22: Web Push.**

- [ ] VAPID subscribe endpoint stores subscription; transitions to `awaiting_input`/`done`/`error` send a push (FR-ST4); other transitions do not. Service worker shows the notification. Verify in browser (PWA).

**US-23: Sidebar status + "needs attention" ordering.**

- [ ] Tree shows per-session status dot/ring; `awaiting_input` + `error` sort to the top (FR-ST6, FR-UI3). Verify in browser.

**US-24: Disconnect + reconcile.**

- [ ] Node link down → dependent sessions `disconnected` with "last seen X, Ym ago" from Postgres (FR-N4, §7.2).
- [ ] On reconnect: re-attach tmux, probe ground truth, scan recent scrollback to infer idle/awaiting during the gap, write a `resync` event; missed transitions are **not** replayed (PRD §7.2 + coarse heuristic). Integration-tested across a simulated gap.

### Phase 4 — Three-layer per-session browser (on VPS)

**US-25: Layer A — isolated Chrome container per session.**

- [ ] Optionally launching a session browser starts a Chrome container on the VPS bound to container loopback; only that session's mapped opaque CDP ws endpoint (incl. GUID) is exposed (FR-B1, NFR-SEC5). Concurrency cap enforced.
- [ ] Teardown on session terminate removes the container (FR-B6); no orphan containers after a kill (integration test).

**US-26: Layer B — agent-driving via injected endpoint.**

- [ ] `SESSION_BROWSER_CDP` (full ws URL w/ GUID, never a bare port) injected into session env; agent instructed not to launch its own browser (FR-B2). v1 ships native/MCP driving; browser-harness only if US-0b cleared.

**US-27: Layer C — screencast view.**

- [ ] `Page.startScreencast` frames stream over `screencast:<id>` to the Browser tab **on demand only** (start on tab open, stop on tab switch) (FR-B3, NFR-PERF3).

**US-28: Layer C — input takeover/release.**

- [ ] `takeover` forwards click/scroll/keys as CDP input events; `release` stops forwarding; `browser_takeover` audit row written (FR-B4, FR-A3).

**US-29: Screencast bandwidth controls.**

- [ ] Cap on concurrent active streams; unfocused panes throttle/pause; JPEG quality adjustable; verified a backgrounded session stops consuming bandwidth (NFR-PERF3, all four controls).

### Phase 5 — Codex-style UI shell + polish (frontend-design skill)

**US-30: Three-region layout + drawer + palette.**

- [ ] Left tree sidebar, center session pane, right activity sidebar; bottom shell drawer toggles on `Cmd+J`; command palette on `Cmd+K`; Codex spatial proportions/calm density (FR-UI1, FR-UI7). Verify in browser.

**US-31: Light + dark themes.**

- [ ] Both themes first-class, toggle persists; all components legible in both (FR-UI2). Verify in browser, both themes.

**US-32: Tree as supervision dashboard.**

- [ ] `Node → Project → Session` tree with live status + needs-attention ordering doubles as the "which agent needs me" view (FR-UI3). (Builds on US-23.)

**US-33: Center tab group (Terminal | Browser | Diff).**

- [ ] Center defaults to Terminal; tabs switch to Browser (Layer C) and **read-only Diff** (`git diff` of working dir, syntax-highlighted) (FR-UI4). Verify in browser.

**US-34: Right activity sidebar.**

- [ ] Shows status timeline (from events) + session metadata + artifact list placeholders; structured for the Phase-2 supervisor to fill (FR-UI5).

**US-35: Bottom shell drawer.**

- [ ] `Cmd+J` opens a second shell in the session's working dir, distinct from the agent's terminal (PRD §12.2).

**US-36: Responsive / PWA.**

- [ ] Layout collapses to a phone-friendly "which agent needs me + approve/deny" view; installable PWA with service worker (FR-UI6). Verify in browser at mobile viewport.

**US-37: frontend-design pass.**

- [ ] Apply `frontend-design` skill for a distinctive, production-grade Flock identity (type scale, color, motion) over the Codex skeleton; document the design tokens. Verify in browser.

### Phase 6 — Deploy, audit, hardening, e2e

**US-38: Docker Compose deploy.**

- [ ] `docker compose up` brings up orchestrator + Postgres; per-session browser containers managed dynamically (NFR-DEP1); secrets via env/secret files, not baked images (NFR-DEP2).

**US-39: TLS + auth on all surfaces.**

- [ ] TLS termination in front; all UI/API/WS require auth (NFR-SEC1, NFR-SEC6); hook endpoint excepted (per-session token only).

**US-40: Audit log surface.**

- [ ] login, node add/remove, session create/terminate, browser takeover, secret access all produce audit rows (FR-A3); admin can read them.

**US-41: e2e happy path (Playwright).**

- [ ] Full flow: first-run setup → login → add local node → create project → create Claude session → terminal renders → trigger `awaiting_input` → sidebar rings + push fires → open browser tab → screencast renders → terminate. Green in CI.

**US-42: Reconnect/restart resilience e2e.**

- [ ] Restart orchestrator mid-session: agent work survives, session re-attaches, status reconciles (NFR-AV1/AV2). Green in CI.

---

## 10. Edge cases (test these explicitly)

- Hook arrives for an unknown/closed session → 404/410, audited, no map mutation.
- Two `takeover` requests on one browser → second is rejected or queued (single controller).
- Node added with a bad key → connection `error`, dependent UI shows actionable message, no crash.
- DB down at boot → orchestrator surfaces a clear fatal; DB down at runtime → live status keeps flowing (in-memory), event-log writes buffer/retry.
- tmux session name collision → `new-session -A` attaches existing; record reconciled, not duplicated.
- Screencast over a slow link → frame-rate/quality auto-degrade, no unbounded queue.
- Master secret key missing/rotated → clear startup error; `key_version` allows decrypt of old ciphertext.
- Concurrent browser container cap reached → new browser request queued/refused with a clear message.

---

## 11. Non-functional requirements (mapped)

- **Security:** NFR-SEC1 TLS; NFR-SEC2 encrypted SSH-key store + use logging; NFR-SEC3 per-session hook tokens; NFR-SEC4 loopback-only reverse tunnels; NFR-SEC5 per-session browser isolation (container); NFR-SEC6 authn on all UI/API/WS.
- **Performance:** NFR-PERF1 status off the DB path; NFR-PERF2 imperceptible terminal echo on datacenter links; NFR-PERF3 screencast controls (all four).
- **Availability:** NFR-AV1 orchestrator restart preserves work; NFR-AV2 graceful `disconnected` + reconcile; NFR-AV3 Postgres backed up.
- **Deployability:** NFR-DEP1 single `docker compose up`; NFR-DEP2 reproducible config, secrets external.

---

## 12. Definition of done & CI gate

**Per story:** failing test(s) written first → implementation → all pass.
**Full CI gate (every phase boundary, and the Ralph verification loop):**

```
pnpm -r typecheck      # tsc --noEmit across workspace
pnpm -r lint           # eslint
pnpm -r test:unit      # vitest (pure logic, translators, reducers)
pnpm -r test:int       # dockerized integration (tmux, sshd, Postgres)
pnpm -r test:e2e       # Playwright smoke for the phase's UI stories
pnpm -r build          # production build (orchestrator + web)
```

**Feature complete when:** all US acceptance criteria pass · all 7 phases verified · full
gate green · `docker compose up` yields a working cockpit per US-41/US-42.

---

## 13. Implementation phases (milestones)

### Phase 0 — Spikes (gate before any production commit)

- US-0a (wterm OSC), US-0b (browser-harness 3-gate).
- **Verification:** decisions recorded in `docs/decisions/`; no spike code in production paths.

### Phase 1 — Foundation

- US-1..US-6 (monorepo, shared contracts, Postgres, secrets, auth, invite).
- **Verification:** `pnpm -r typecheck && pnpm -r test:unit && pnpm -r test:int && pnpm -r build`.

### Phase 2 — Node transport, tmux, terminal

- US-7..US-13.
- **Verification:** full gate incl. `test:int` (local + sshd containers) and a terminal Playwright smoke.

### Phase 3 — Status, hooks, notifications

- US-14..US-24.
- **Verification:** full gate incl. agent hook contract tests + push + reconcile integration.

### Phase 4 — Three-layer browser

- US-25..US-29.
- **Verification:** full gate incl. container lifecycle + screencast integration tests.

### Phase 5 — Codex-style UI shell + design polish

- US-30..US-37 (uses `frontend-design` skill).
- **Verification:** full gate incl. Playwright e2e across both themes + mobile viewport.

### Phase 6 — Deploy, audit, hardening, e2e

- US-38..US-42.
- **Verification:** `docker compose up` smoke + full e2e (US-41/US-42) green in CI.

---

## 14. Open questions / risks (carried from PRD, with mitigation)

1. **Screencast bandwidth at scale** (PRD #1) — all four controls ship in v1; run a load test before locking CDP-screencast as the long-term default; WebRTC remains the documented escalation.
2. **Per-session browser containers vs processes** (PRD #2) — resolved: containers on the VPS, with a concurrency cap; lifecycle/cleanup covered by US-25.
3. **Hook config injection** (PRD #3) — resolved: session-scoped config dirs (US-19).
4. **Reconcile fidelity** (PRD #4) — re-attach + probe + coarse scrollback heuristic + resync event (US-24); per-agent approximation accepted, documented.
5. **Generic-agent UX expectations** (PRD #5) — UI must label OSC/PTY-only sessions as "coarse status."
6. **Secret depth for v1** (PRD #6) — resolved: app-level encryption at rest, pluggable for KMS/Vault.
7. **wterm OSC spike** (PRD #7) — Phase 0 US-0a.
8. **browser-harness spike** (PRD #8) — Phase 0 US-0b; native/MCP fallback otherwise.
9. **Center-pane model** (PRD #9) — resolved: terminal-first; summary lives in the right sidebar.

---

## 15. Implementation notes

- Keep the §4.2 single-session-record invariant central; add a test that fails if `session_id` ever diverges across tmux name / hook token scope / browser endpoint.
- The hook endpoint is the one path that must be fast and DB-free on the hot path; treat any synchronous DB call there as a bug.
- `NodeTransport` is the seam that lets local and SSH share one test suite — write the contract suite once, run twice.
- The `frontend-design` skill pass (US-37) should be a deliberate, late step over a working skeleton — do not pixel-chase Codex (PRD §12.4); aim for a distinctive Flock identity on the correct Codex bones.

---

## Appendix A — Codex app UI reference (researched 2026-05-29)

> Compiled from OpenAI's published Codex app docs (developers.openai.com/codex/app and
> /features, /review, /browser, /settings) and third-party reviews. Use this as the
> concrete skeleton US-30..US-37 dress. Where a detail is Codex-specific and Flock diverges,
> the divergence is noted.

### A.1 Confirmed Codex spatial model

- **IDE-like Electron three-region shell:** left **project sidebar** → center **active thread** workspace → right **review/task pane**. (Flock: left `node→project→session` tree → center **live terminal** tab group → right **activity sidebar**.)
- **Left sidebar:** top-level items are **projects**; inside each are **threads** (one thread = one agent instance). A **filter icon next to the "Threads" label** switches thread views by state. (Flock: add the **Node** level above Project; the per-session **status dot/ring + needs-attention ordering** is the filter analog — FR-UI3.)
- **Center:** conversation/thread + composer. (Flock divergence: center is the agent's **live terminal**; Terminal | Browser | Diff tab group.)
- **Bottom terminal drawer:** integrated terminal scoped to the project/worktree, toggled by terminal icon or **`Cmd+J`**; supports **multiple terminal tabs**; the agent can **read current terminal output**. (Flock: secondary user shell drawer, `Cmd+J`, US-35.)
- **Right task/review pane:** surfaces the agent's **plan, sources, generated artifacts, task summary**; previews **PDF/spreadsheets/docs/slides**; the **diff/review pane** shows a Git diff with **inline comments**, stage/unstage/revert at chunk level, commit/push/PR (Git repos only). (Flock v1: read-only diff + activity sidebar; stage/commit/PR → v1.x.)

### A.2 Confirmed keyboard + interaction model

- **`Cmd+K`** command palette · **`Cmd+J`** terminal · **`Ctrl+L`** clear terminal · **`Ctrl+M`** (hold) voice dictation · **`Cmd+,`** settings → Appearance/Keyboard Shortcuts (rebindable, searchable by command or keystroke).
- **Pop-out windows** (detach a thread, optional always-on-top). (Flock: nice-to-have, not v1; our away-view is the PWA.)
- Thread **modes** Local / Worktree / Cloud shown as composer mode options. (Flock: replaced by **Node selection**; worktree → v1.x per §4.1.)

### A.3 Confirmed theming model → Flock design tokens

- Codex uses a **`codex-theme-v1` JSON** describing the full visual chrome: **surface colors, accent, ink, semantic diff colors, font choices (UI font + code font), window opacity.** Ships base themes (Catppuccin, Monokai, Solarized light/dark) + partner themes (Linear); OS light/dark aware; user-adjustable accent/bg/fg + fonts; shareable.
- **Flock requirement (refines US-31/US-37):** define a **`flock-theme` token set** mirroring that structure — `surface.{0,1,2}`, `accent`, `ink.{primary,muted}`, `status.{starting,running,awaiting,idle,done,error,disconnected}` (drive the sidebar dots from these), `diff.{add,remove,context}`, `font.ui`, `font.code`. Ship **light + dark first-class**, **auto-follow OS preference**, with a small built-in theme set. Keep it JSON-driven so themes are data, not code — directly Codex-parity and future-proof.

### A.4 "Calm density" cues to match

- IDE-grade information density without clutter; reviewers call the UI "the real product" — sharp, AI-native, **diff views and environment controls that remove obstacles rather than add features.** Favor quiet surfaces, a single accent, generous-but-tight spacing, and status conveyed by small colored indicators (not loud badges). The status-bearing tree (FR-UI3) is the one element that must feel unmistakably Codex-like.

### A.5 Honest gaps (carried from PRD §12.4)

- No pixel-level screenshots were inspected; exact spacing, type scale, and motion remain to be tuned against the running app during US-37. This appendix fixes **structure, terminology, interactions, keybindings, and the theming data-model** — the correct skeleton to dress, not a finished visual spec.

### A.6 Sources

- [App – Codex | OpenAI Developers](https://developers.openai.com/codex/app)
- [Features – Codex app](https://developers.openai.com/codex/app/features)
- [Review – Codex app](https://developers.openai.com/codex/app/review)
- [In-app browser – Codex app](https://developers.openai.com/codex/app/browser)
- [Settings – Codex app](https://developers.openai.com/codex/app/settings)
- [Codex App Theming and Customisation (codex-theme-v1)](https://codex.danielvaughan.com/2026/03/30/codex-app-theming-customisation/)
- [I Tested OpenAI's New Codex Desktop App — The UI Is the Real Product (Medium)](https://medium.com/@ariaxhan/i-tested-openais-new-codex-desktop-app-the-ui-is-the-real-product-c2c59bdcb5f6)
- [Complete Beginner's Guide to OpenAI's Codex App](https://getpushtoprod.substack.com/p/complete-beginners-guide-to-openais)
