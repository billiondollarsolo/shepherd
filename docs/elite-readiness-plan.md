# Flock — Elite Readiness Plan

> Status: **DRAFT for review.** Generated 2026-06-03 from a 4-dimension audit
> (security, agent capabilities, production readiness, reliability). Nothing here
> is implemented yet. Review, adjust priorities/scope, then we execute task by task.

## How to use this doc
- Tasks are grouped into **phases** by priority. Within a phase, do them top-down.
- Each task has: **What / Why / Where / How / Acceptance / Effort / Risk**.
- Check the box (`[ ]` → `[x]`) as we complete each one.
- Severity tags: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Polish.
- Effort: S (≤1h) · M (a few hours) · L (a day+).

## ⚠️ Decision required before Phase 2 (gates security scope)
**What is Flock's threat model?**
- **(A) Single trusted team / private network** — every logged-in user is trusted;
  Flock is not exposed to the public internet.
- **(B) Untrusted multi-user and/or internet-exposed** — users don't fully trust
  each other, or the app is reachable from hostile networks.

Several Phase-2 tasks (per-session authorization, WS Origin checks, login
rate-limiting, SSH host-key pinning) are **must-fix now** under (B) but
**lower priority** under (A). The app already ships invite + admin/member roles,
which implies (B). **Please pick A or B so we set Phase-2 urgency correctly.**

> **Selected threat model:** _____ (fill in: A or B)

---

## What's already good (don't touch)
So we don't regress these while fixing the rest:
- argon2id password hashing with a dummy-verify timing guard.
- Secrets encrypted at rest (AES-256-GCM, key versioning); never echoed to clients.
- Default-deny global surface guard; httpOnly + Secure + SameSite=Strict cookies;
  DB-validated (non-forgeable) session ids.
- Live status path is independent of Postgres; bounded write-behind event queue
  (10k cap, sheds oldest, retries, never awaited on the hot path).
- Reconnect/resume: alt-screen-aware reattach (clean enter + forced SIGWINCH),
  resize dedup, transient-vs-terminal exit, the heartbeat `emit('connection')` fix.
- Worktrees (isolated branches + safe merge), dev-session auto-restart supervision,
  browser screencast + single-controller takeover, agentd bootstrap (atomic binary
  swap, systemd --user + linger, nohup fallback).

---

# Phase 1 — Critical: make the core actually work & stop node-wide crashes
These two have the highest leverage and are not gated by the threat-model decision.

## [x] T1 — Wire the orphaned hook-config injection 🔴 (Effort: M) ✅ DONE
> Implemented as **agentd-seeded** config (works local + SSH, unlike the orchestrator-fs
> module): `Spec.ConfigDirEnv/ConfigFiles/ConfigBaseSubdir` → `seedScopedConfig` on the
> node (copies the user's real config as base, writes Flock's files, substitutes the
> `__FLOCK_CONFIG_DIR__` placeholder, **merges** Flock hooks into the user's settings.json
> instead of clobbering), exports the config-dir env, removes on Close. Forwarder is a
> robust `flock-hook.sh` script (fixes the old `$FLOCK_HOOK_CMD` quoting bug).
> Orchestrator: `renderScopedConfig(agentType)` → passed via `client.open`. Validated:
> Go unit tests (seed/merge/noop), live end-to-end (real Claude session seeded the dir
> with merged settings + creds + executable forwarder; cleaned up on terminate).
**What:** Actually install per-session agent hook config (Claude `settings.json`,
Codex/OpenCode equivalents) at launch so agents call back into Flock's hook
endpoint. Today only the `FLOCK_HOOK_URL/TOKEN/CMD` env vars are injected — not the
config that tells the agent to use them.

**Why:** This is the single biggest functional gap. Without it:
- `awaiting_input` (the "an agent needs you" state) **never fires** for Claude/Codex
  (it's not in the transcript — it requires the Notification hook).
- The **Plan / TodoWrite artifact** is dead code.
- **US-22 Web Push** has nothing to notify on (it keys off awaiting_input/done/error).
All of this is built and tested — it's simply not connected to the launch path.

**Where:**
- Built but unused: `apps/orchestrator/src/sessions/config-injection/`
  (`config-injection.ts` `seedScopedConfigDir`/`removeScopedConfigDir`, `hook-templates.ts`).
- Launch path that needs to call it: `apps/orchestrator/src/index.ts` (`sessionEnv`
  ~L444-459, `agentdLaunch` ~L403-461) and `apps/orchestrator/src/sessions/session-rest-service.ts` (~L248-269).
- Status derivation that depends on it: `agentd/internal/status/claude.go` (notes
  permission prompts need hooks).

**How:**
1. In the session create flow (before `agentdLaunch`), call `seedScopedConfigDir`
   for the agent type → it returns the scoped env (`CLAUDE_CONFIG_DIR` /
   `CODEX_HOME` / `XDG_CONFIG_HOME`) and writes the settings/hook templates.
2. Merge that env into `sessionEnv` so it ships with the launch.
3. **Credential caveat:** scoped config dirs must still see the agent's real login
   (`~/.claude` etc.). Ensure the seed copies/symlinks existing credentials into the
   scoped dir, or logins break (the audit flagged this explicitly).
4. Call `removeScopedConfigDir` in the terminate/teardown path.
5. Verify Codex + OpenCode hook templates are emitted too (not just Claude).

**Acceptance:**
- Start a Claude session, trigger a permission prompt → session flips to
  `awaiting_input` in the UI and a Web Push fires (if subscribed).
- A `TodoWrite` shows up as the Plan artifact in the Activity panel.
- `events` table shows hook-sourced rows (not just `status_transition`).
- Terminating the session removes the scoped config dir.

**Risk:** Touching credential paths can break agent login — test login persistence
after the change on a real session before calling it done.

## [~] T2 — Daemon crash-safety: no panic, auto-restart, reconcile 🔴 (Effort: M) — CORE DONE
> ✅ **Panic fixed + validated**: `broadcast` fan-out is now NON-BLOCKING and under
> `s.mu` (mutually exclusive with `finalize`'s `close`) → no send-on-closed panic and
> the pump can't be flow-controlled by a slow subscriber. `recover()` added to `pump`,
> `supervise`, and `HandleConn`. Go `-race` regression test (concurrent broadcast +
> finalize on a full subscriber) passes.
> ✅ **Local supervisor**: run-dev.sh now restarts the local daemon if it exits.
> ⏳ **Remaining**: orchestrator-side RECONCILE (on reconnect, diff `client.list()` vs
> DB open sessions → mark DB-only as error/done to stop the "reconnecting" loop; close
> daemon-only orphans). Deferred — needs a grace-period vs just-created race handling;
> doing it wrong kills live sessions, so it warrants careful validation.
**What:** Make `flock-agentd` survive a single bad session and a crash without
taking down every session on the node.

**Why:** Three compounding issues:
- **Panic:** `broadcast()` snapshots subscriber channels, **unlocks**, then does a
  blocking `ch <- chunk`; `finalize()` closes those channels under lock → a blocked
  send races `close(ch)` → **send on closed channel → panic**. No goroutine has
  `recover()`, so the whole daemon dies, killing every session on the node. A slow
  browser subscriber (backpressure) makes this likely.
- **No local supervisor:** if the local daemon crashes, nothing restarts it or
  re-opens its sessions (remote nodes self-heal via bootstrap; local doesn't).
- **No reconcile:** after a daemon/orchestrator restart, DB "open" sessions and
  live daemon sessions diverge — dead sessions loop "reconnecting" forever; orphan
  daemon sessions leak.

**Where:**
- `agentd/internal/session/session.go` (`broadcast` ~L209-225, `finalize` ~L284-293,
  `pump`, `supervise`).
- `agentd/main.go` (no `recover()` on goroutines; serve loop).
- `agentd/internal/server/server.go` (`HandleConn` goroutine).
- Orchestrator: `apps/orchestrator/src/nodes/agentd/agentd-connections.ts`
  (`clientForLocal`), `apps/orchestrator/src/index.ts` (~L512 "connectivity hook is
  left unbound"; `agentdHealthSnapshot` ~L205-268 reports `live` but acts on nothing).

**How:**
1. Fix the fan-out: send under a scheme that can't race `close` — either
   non-blocking `select { case ch <- chunk: default: /* drop or coalesce */ }`, or
   have `finalize` wait for the pump goroutine to exit (a `sync.WaitGroup`/done) before
   closing channels. (Dropping frames on a full buffer is fine for a terminal — it
   repaints.)
2. Add `defer recover()` to `pump`, `supervise`, and the per-connection `HandleConn`
   goroutine so one bad session can never crash the process.
3. Local-daemon supervision: run the local agentd under systemd --user (preferred)
   or a small Node child-process supervisor that restarts it; on local reconnect,
   re-`open` known-open sessions from the DB (mirror the remote re-bootstrap path).
4. Reconcile on (re)connect: bind the connectivity hook → diff `client.list()` vs DB
   open sessions; mark DB-only sessions `error`/`done` (stops the reconnect loop) and
   `close()` daemon-only orphans.

**Acceptance:**
- Kill a session's process under a deliberately-stalled subscriber → daemon stays up,
  other sessions unaffected (add a Go test simulating a full subscriber buffer at
  finalize).
- `kill -9` the local daemon → it restarts and live sessions re-attach (or are
  cleanly marked dead, not stuck "reconnecting").
- A session in the DB but not on the daemon resolves to `error/done` within one
  reconcile cycle instead of looping.

**Risk:** Concurrency change in Go — write the test first to prove the panic, then
prove it's gone.

## [~] T3 — Backpressure isolation on the shared link 🟠 (Effort: M) — CORE DONE
> ✅ The non-blocking `broadcast` (T2) means a slow subscriber no longer flow-controls
> the agent or stalls the pump — the chunk is dropped (ring retains it for reattach).
> ⏳ **Remaining**: the orchestrator↔node socket write still shares one `wmu`, so a
> blocked socket write can stall control frames for other sessions on that connection.
> Decouple with a per-connection async write queue (bounded, drop/disconnect on
> overflow). Deferred to a focused follow-up.
**What:** Stop one slow browser viewer from stalling other sessions on the same node.

**Why:** All sessions on a node multiplex over one connection with one write mutex
(`wmu`). A slow/congested subscriber blocks its `stream` write → its 256-buffer fills
→ `broadcast` blocks → `pump` stops reading the PTY → the agent is flow-controlled to
a halt; worse, the shared `wmu` means a stalled data write also blocks **control**
frames (opened/exit/status) for every other session on that node.

**Where:** `agentd/internal/server/server.go` (`stream` ~L155-161, `sendData`/`sendControl`
share `wmu` ~L218-222); `agentd/internal/session/session.go` (`broadcast`).

**How:** Give each session its own bounded queue with a drop/coalesce-on-overflow
policy, and/or decouple the socket writer from the per-session pump with a
per-connection write queue so one slow session never blocks others' control frames.
(Partially overlaps T2's non-blocking fan-out — do them together.)

**Acceptance:** Artificially stall one subscriber; other sessions on the node keep
streaming and their control frames still arrive.

---

# Phase 2 — Security hardening (urgency depends on threat model A/B)
Under model (B) these are **must-fix**; under (A) they're hardening for later.

## [x] T4 — Per-session authorization on WS endpoints 🟠 (Effort: M) — DONE
**Done:** New `auth/ws-auth.ts` `makeWsAuthorizer` (cookie→user→owner-or-admin per
session id; null owner = legacy allowed; null sessionId = any authed for the status
stream). Wired through `live-channels.ts` (`authorizeUpgrade`) into `PtyWsServer` +
status WS, and into `browser-channels.ts` screencast upgrade. Unit-tested (ws-auth.test.ts).


**What:** Verify the authenticated user owns (or is admin for) the session before
completing a `/ws/pty`, `/ws/status`, or `/ws/screencast` upgrade.

**Why:** The surface guard validates the cookie but **ignores `sessionId`** — any
logged-in user can attach to any session and **read + inject keystrokes** into
another user's agent, or watch their screencast. Full cross-user takeover in a
multi-user deploy.

**Where:** `apps/orchestrator/src/auth/surface-guard.ts` (~L144-159, sessionId ignored);
`apps/orchestrator/src/live-channels.ts` (~L187 pty, ~L284-294 status);
`apps/orchestrator/src/.../browser-channels.ts` (~L312-318);
`apps/orchestrator/src/db/schema.ts` (`agentSessions` — confirm/define an owner column).

**How:**
1. Ensure `agent_sessions` has an owner (`created_by` exists; if it's the owner,
   reuse it — else add `owner_user_id`). Migration if needed.
2. In each WS upgrade authenticator, after resolving the user, check ownership (or
   admin role) for the requested sessionId; reject the upgrade otherwise.

**Acceptance:** User B cannot open user A's `/ws/pty/<id>` (rejected at upgrade);
admin can; owner can.

## [x] T5 — WebSocket Origin checks (anti-CSWSH) 🟡 (Effort: S) — DONE
**Done:** `originAllowed(req, PUBLIC_BASE_URL)` in `ws-auth.ts`, enforced inside
`makeWsAuthorizer` for every WS upgrade (mismatched Origin rejected even with a valid
cookie; missing Origin allowed for non-browser clients; unset config = allow). Unit-tested.


**What:** Validate the `Origin` header against `PUBLIC_BASE_URL` on every WS upgrade.

**Why:** WS upgrades aren't protected by SameSite the way fetch is — a hostile page
in the user's browser could open `ws://…/ws/pty/<id>` with their cookie (cross-site
WebSocket hijacking). Combined with T4 absence, that reaches any session.

**Where:** `pty-ws-server.ts` (~L122), `live-channels.ts` (~L284), `browser-channels.ts` (~L312).

**How:** In each upgrade handler, reject if `Origin` ≠ the configured base URL
(allow same-origin; configurable allowlist for reverse-proxy setups).

**Acceptance:** A WS upgrade with a foreign Origin is rejected; the app's own
connections still work.

## [x] T6 — Login rate-limiting & lockout 🟠 (Effort: S) — DONE
**Done:** `auth/login-throttle.ts` `LoginThrottle` (8 failures / 5-min window →
15-min lockout, keyed by ip+username) wired into `POST /api/auth/login`
(429 + Retry-After when locked; failures/success recorded). Unit-tested (login-throttle.test.ts).


**What:** Throttle `/api/auth/login` (and `/api/auth/setup`, `/api/hooks/*`).

**Why:** Login is on the public allow-list with no attempt counter, lockout, or IP
throttle — an online brute-force/credential-stuffing target (argon2 slows, doesn't
stop).

**Where:** `apps/orchestrator/src/auth/routes.ts`, `service.ts` (~L202-237). Add
`@fastify/rate-limit`.

**How:** Per-IP + per-username rate limit / exponential backoff / temporary lockout on
login; a coarser per-session rate limit on the hook endpoint (ties to replay, T8).

**Acceptance:** N failed logins in a window → throttled/locked with a clear error;
normal login unaffected.

## [x] T7 — SSH host-key verification (pinning) 🟠/🔴 (Effort: M) — DONE
**Done:** Added `nodes.ssh_host_key` (migration `0003_ssh_host_key`), a `verifyHostKey`
hook on `SshConnectionConfig` wired to ssh2's `hostVerifier` with an OpenSSH-style
`SHA256:` fingerprint (`sshHostKeyFingerprint`), and TOFU pin logic in
`node-connection-manager` (first connect persists the key + accepts; reconnects must
match the closure-held pin or are rejected as possible MITM; operator clears
`nodes.ssh_host_key` to re-pin). Unit-tested (fingerprint format + TOFU verifier);
full suite green.


**What:** Pin each node's SSH host key (TOFU on add, verify thereafter).

**Why:** `ssh2` is given no `hostVerifier` → it accepts **any** host key → MITM on
every node link, which carries the decrypted private key + PTYs + the hook tunnel.
🔴 under model (B) / internet-exposed; 🟠 on a trusted LAN.

**Where:** `apps/orchestrator/src/nodes/transport/ssh-connection.ts` (~L172-184);
`nodes` table (store expected fingerprint).

**How:** Capture the host key fingerprint on first connect (store on the `nodes`
row), add a `hostVerifier` that checks subsequent connects against it, reject on
mismatch (surface a clear "host key changed" error to the operator).

**Acceptance:** First add pins the key; a changed key is rejected with a clear error.

## [x] T8 — node-fs browser confinement 🟡 (Effort: M) — DONE
**Done:** Gated the file-WRITE endpoint (`PUT /api/nodes/:id/fs/file`) behind
`requireAdmin` in `node-fs-route.ts` (arbitrary write on any node = code execution).
Browse/tree/read stay member-accessible (path picker + viewer); members still get a
real shell only on nodes where they own a session, not via this API. Typecheck +
suite green.


**What:** Jail the node file browser read/write to the session/project working dir
(or restrict writes to admins).

**Why:** Any authed user can currently read `~/.ssh/id_rsa` / `/etc/passwd` and
**overwrite arbitrary files** as the node user (= code execution on the node). Shell
injection is already prevented; path confinement is not.

**Where:** `apps/orchestrator/src/nodes/node-fs-service.ts` (`FS_READ_SCRIPT`,
`fsWriteArgv`), `node-fs-route.ts`.

**How:** Resolve realpath and reject any path escaping the project/session root; or
gate writes behind admin. Keep the existing shell-quoting.

**Acceptance:** Reads/writes outside the project root are rejected.

## [x] T9 — Constant-time agentd secret compare ⚪ (Effort: S) — DONE
**Done:** `hello` now uses `crypto/subtle.ConstantTimeCompare` for the shared secret,
and `unsubscribe/resize/close/list/getLayout/setLayout` are gated on `c.authed`
(unauth peers can't touch sessions). Top-level `recover()` in `HandleConn`.
Shipped in agentd 0.2.5-dev.

---

# Phase 3 — Production readiness
Blocks a real deployment; not needed for local dev.

## [x] T10 — Ship & run flock-agentd in the production image 🔴 (Effort: M) — DONE
**Done:** Added a Go build stage to `Dockerfile.orchestrator` (arch-matched via
`TARGETARCH`, stamped from `agentd/VERSION`), COPY the binary to
`/usr/local/bin/flock-agentd`, and a new `docker/orchestrator-entrypoint.sh` that
supervises the daemon (auto-restart, pairs with T2) on `FLOCK_AGENTD_SOCKET`, runs
migrations, then execs the orchestrator. Validated: Dockerfile lints, the agentd
stage builds in-container and reports the right version, deploy int-tests assert
the daemon ship + entrypoint boot order (25/25 green).


**What:** The orchestrator prod image must provide the local PTY transport.
**Why:** `docker/Dockerfile.orchestrator` installs `tmux` but **no flock-agentd**
binary/daemon/socket, while the code makes agentd the only transport → every
local-node session fails to attach in the documented single-box deploy.
**Where:** `docker/Dockerfile.orchestrator`, entrypoint, `apps/orchestrator/src/index.ts:136`,
`agentd-connections.ts` (`clientForLocal` socket path), `live-channels.ts:181` (throws, no fallback).
**How:** `COPY` the arch-matched `flock-agentd` into the image and start it from the
entrypoint (or a tiny supervisor) on a known `FLOCK_AGENTD_SOCKET` the orchestrator
also reads. (Pairs with T2's local supervisor.) Alternatively, document that local
sessions require an SSH node — but shipping the daemon is the right call.
**Acceptance:** A deploy integration test creates a local session and asserts the PTY
attaches.

## [x] T11 — Graceful shutdown 🟠 (Effort: S) — DONE
**Done:** SIGTERM/SIGINT handler in `index.ts` — `app.close()` (drains HTTP + WS),
`liveChannels.dispose()`, `browserChannels.dispose()`, `connections.disposeAll()`,
`closeDb()`, with a 10s hard-exit backstop and idempotency guard.


**What:** Handle SIGTERM/SIGINT in the orchestrator: `app.close()`, `closeDb()`, tear
down live/browser channels.
**Why:** Today there's no handler → every redeploy/restart SIGKILLs in-flight
requests, severs WS without close frames, leaves the pg pool undrained. (agentd
already handles signals.)
**Where:** `apps/orchestrator/src/index.ts` (add handlers); `closeDb()` exists in
`db/client.ts` but is unused.
**Acceptance:** `docker compose stop` drains cleanly; WS clients get close frames.

## [x] T12 — Structured + request logging 🟠 (Effort: S) — DONE
**Done:** Enabled Fastify's pino logger (`{ level: LOG_LEVEL ?? 'info' }`) so every
request logs method/path/status/latency/reqId as JSON; silenced under test
(NODE_ENV=test / VITEST). The dev `[pty]` web logs were already `import.meta.env.DEV`-gated.


**What:** Enable Fastify's pino logger; route the ~18 ad-hoc `console.*` calls through
`app.log`; remove the dev-only `[pty]` `console.debug` (gate to DEV only).
**Why:** `Fastify({ logger: false })` → no request logs, IDs, latency, or JSON for
aggregation → near-impossible incident debugging.
**Where:** `apps/orchestrator/src/server.ts:176`; `apps/web/src/features/terminal/usePtyWebSocket.ts` (`[pty]` logs).
**Acceptance:** Requests log as JSON with method/path/status/latency/requestId.

## [x] T13 — CI gate 🟠 (Effort: M) — DONE
**Done:** `.github/workflows/ci.yml` with two jobs — `verify` (pnpm install →
build → typecheck → lint → unit) and `agentd` (go vet → go test → make dist),
on PR + push-to-main, with concurrency cancellation. Made the lint gate actually
green: scoped out non-workspace sibling dirs (`orca`, `codex`), disabled
`no-control-regex` (this app parses VT sequences), removed a dead
`react-hooks/exhaustive-deps` disable directive, fixed `prefer-const` in the new
throttle test. `pnpm lint` now exits 0; all CI steps validated locally.


**What:** A CI workflow running `make verify` (typecheck + lint + unit) on PR, plus
`go vet`/`go test ./...` + `make dist` for agentd; ideally `make test-int`/`e2e`.
**Why:** Nothing currently stops shipping a build that doesn't typecheck/lint or has
failing tests — risky for an app that runs agents and mounts the Docker socket.
**Where:** new `.github/workflows/`; `Makefile`, package scripts already exist.
**Acceptance:** PRs are blocked on red typecheck/lint/tests.

## [x] T14 — Single source of truth for the agentd version 🟠 (Effort: S) — DONE
**Done:** New `agentd/VERSION` file is the single source. The Makefile reads it
(`VERSION ?= $(shell cat …/VERSION)`) to stamp `-X main.Version`; `main.go`
`go:embed`s it as a fallback for unstamped `go run` (Version stays empty so `-X`
still overrides — resolveVersion() picks stamped-else-embedded); the orchestrator
`resolveAgentdVersion()` reads `FLOCK_AGENTD_VERSION` → `agentd/VERSION` → constant
fallback (with a warning). Compose + image set the env from the file. Verified all
build paths report `0.2.5-dev`.


**What:** One version constant feeding `agentd/Makefile`, `agentd/main.go`, and the
orchestrator's `FLOCK_AGENTD_VERSION` default.
**Why:** Three files define three different defaults (`0.2.1-dev` / `0.2.3-dev` /
`0.1.0-dev`). A mismatch makes the bootstrap **re-ship + restart the daemon**, which
**kills running remote sessions**. A version typo silently nukes live work.
**Where:** `agentd/Makefile:11`, `agentd/main.go:24`, `apps/orchestrator/src/index.ts:155`.
**How:** Stamp the version from one place (Makefile var or a VERSION file); make a
mismatch loud; reconsider whether a patch bump should force-restart live daemons.
**Acceptance:** `make dist` and the orchestrator agree on the version with no manual override.

## [x] T15 — Readiness probe + DB pool config + resource limits 🟡 (Effort: M) — DONE
**Done:** (a) `GET /ready` runs a 1s-bounded `SELECT 1` → 200/503 (public like
/health; surface-guard allow-listed); `/health` stays liveness; (b) the pg `Pool`
now sets `max`/idle/connection timeouts + `statement_timeout` (all env-tunable) and
a pool 'error' listener; (c) each session Chrome gets `Memory`/`NanoCpus`/
`PidsLimit` caps (defaults 1 GiB / 1 vCPU / 512 PIDs, env-overridable, 0 = unset).
Unit-tested (/ready 200/503/throws; container caps applied + omitted-at-0).


**What:** (a) `/ready` that does `SELECT 1` (keep `/health` as pure liveness);
(b) configure pg `Pool` `max`/idle/connection timeouts + a `statement_timeout`;
(c) per-session Chrome `Memory`/`NanoCpus`/`PidsLimit` + compose service limits.
**Why:** `/health` returns ok even when Postgres is down (lying readiness gate); no
pool sizing/timeouts (silent 10-conn cap, stuck queries hold connections); each
Chrome is unbounded (one heavy page can OOM the VPS). `BROWSER_MAX_CONCURRENT` caps
count but not per-container size.
**Where:** `server.ts:187`, `db/client.ts:50`, `docker-compose.yml`, `browser/layerA/manager.ts:134`.
**Acceptance:** Readiness fails when DB is down; Chrome containers are memory/CPU/PID
capped; pool has explicit limits + statement timeout.

## [x] T16 — Config & docs hygiene ⚪ (Effort: S) — DONE
**Done:** Removed the dead `SESSION_SECRET` + `COOKIE_SECURE` knobs from
`.env.example` + `docker-compose.yml` (documented the real `FLOCK_INSECURE_COOKIES`
instead); pinned floating image tags to digests (caddy, postgres in compose; node
base + session-chrome base in the Dockerfiles); reconciled the README with compose
(now correctly: 4 services incl. the bundled Caddy TLS proxy on 80/443, accurate
ports, agentd shipped in the orchestrator image). Deploy int-tests green.


**What:** Honor or remove the dead `COOKIE_SECURE` knob (cookies are decided only by
`FLOCK_INSECURE_COOKIES`); remove the unused `SESSION_SECRET`; pin floating Docker
tags (`caddy:2-alpine`, `postgres:16-bookworm`, `zenika/alpine-chrome:latest`,
agent-CLI installers); reconcile README↔compose drift (README says 3 services/port
8081/bring-your-own-TLS; compose ships 4 incl. Caddy on 80/443).
**Where:** `auth/cookie.ts`, `docker-compose.yml`, `.env.example`, `README.md`,
`Dockerfile.orchestrator` (CLI installs), `Dockerfile.session-chrome`.
**Acceptance:** No no-op config knobs; reproducible image tags; README matches compose.

---

# Phase 4 — Agent capabilities (make it "elite")

## [x] T17 — Enforce sandboxing for autonomous mode 🟠 (Effort: L) — DONE
**Done:** Real **Landlock** FS confinement for `autonomous` sessions. New
`agentd/internal/sandbox` (raw landlock syscalls via x/sys; ABI-aware write-class
ruleset; `Available()`/`RestrictWrites()`) + a `flock-agentd sandbox-exec` re-exec
helper that restricts ITSELF (daemon stays unrestricted) then execs the agent
(landlock persists across execve), fail-closed if landlock errors. `session.Spec`
gained `Sandbox`/`SandboxAllow`; `startProcess` wraps the agent argv (allow =
cwd + /tmp + /dev + extras). Capability is reported via NodeInfo
`sandboxAvailable`; the orchestrator enables the sandbox for autonomous sessions
on capable nodes and **warns** loudly otherwise. **Proven by an isolation test**
(a confined child can write inside the allow-dir but is DENIED outside; reads
still work) on this 6.8 kernel. agentd bumped to 0.2.7-dev (redeployed).


**What:** Real OS-level isolation in agentd for autonomous/dangerous sessions, not
just the CLI flag.
**Why:** `autonomous` maps to `--dangerously-skip-permissions` /
`--dangerously-bypass-approvals-and-sandbox`, but agentd spawns with the node user's
full env and **no landlock/seccomp/namespaces/cgroup/rlimit**. The dangerous flag
without the isolation it implies.
**Where:** `apps/orchestrator/src/sessions/agent-launch.ts` (flag builders),
`agentd/internal/session/session.go:97-140` (spawn).
**How:** Add Linux landlock (FS scope to cwd/worktree) + seccomp (syscall filter) +
optionally a cgroup (CPU/mem) for autonomous sessions; gate `autonomous` behind a
per-node "is sandboxed" capability; at minimum surface a clear "this node is
unsandboxed" warning.
**Acceptance:** An autonomous session cannot write outside its worktree on a sandbox-
capable node; non-capable nodes warn or refuse autonomous.

## [x] T18 — Persist & display permission mode 🟡 (Effort: S) — DONE
**Done:** Added `agent_sessions.permission_mode` (migration `0004`, default 'default'),
to the shared `Session` type + mappers, persisted on create. Web shows a compact
tree badge (AUTO/PLAN/YOLO, autonomous highlighted in error color; interactive is
unbadged). Migrations applied; shared fixtures + suites green.


**What:** Store `permissionMode` on the session row; show it as a badge.
**Why:** It currently rides the launch request only — lost on restart, and a
supervisor can't see at a glance which agents are autonomous (a safety-relevant
attribute). Also blocks "restart this session as-is".
**Where:** `session-rest-service.ts:249-256`, `db/schema.ts`, shared `Session`,
sidebar/grid badges.
**Acceptance:** Mode persists across restart and shows in the UI.

## [x] T19 — Richer agent telemetry: model, cost, context-window % 🟡 (Effort: M) — DONE
**Done:** agentd now extracts `model` + `contextTokens` (current prompt occupancy)
from the Claude + Codex transcripts (`status.Update`/emitter + `claude.go`/`codex.go`),
carried via StatusEvent → `proto.Control` → orchestrator. New
`sessions/model-info.ts` (context-limit + price table, longest-prefix match)
computes context-% and an estimated $ cost; surfaced in `/api/agentd/status`
(`sessionHealth`) and shown in the **bottom bar** + **grid pane footer** (model ·
N% ctx · tokens · $cost). Unit-tested (Go parse for both agents; model-info pct/cost).
agentd bumped to 0.2.6-dev (built + dist + local daemon redeployed; orchestrator
healthy, /ready 200). Live full-agent-run telemetry pending manual confirmation.


**What:** Capture model name + compute cost ($) + context-window % (input tokens vs
model limit); optionally per-tool timing and surfaced error messages.
**Why:** These are the numbers a supervisor actually watches ("how close to
compaction / how much has this burned"); the data (tokens, model in the transcript)
is already on the node — just not extracted/surfaced. Table-stakes vs competitors.
**Where:** `agentd/internal/status/{status,claude,codex}.go` (`Update` = State/Tokens/
Tool only); `agentd/internal/proto/proto.go` (`Control`); orchestrator
`agentdSessionMeta` (`index.ts:139-340`); web grid footer + bottom bar + node/Activity.
**How:** Extend `Update`/`Control` with `model`, `contextPct` (and cost from
tokens×model price, computable in the orchestrator); parse model from transcript;
add a model-limit/price table.
**Acceptance:** Grid/bottom-bar show model + context-% + cost; values match a known run.

## [x] T20 — Gemini (and aider) support or de-list ⚪ (Effort: M or S) — DONE
**Done:** **Built Gemini** as a first-class launchable agent: added `gemini` to
`AgentTypeEnum` + schema + UI labels/mode selector; `agentLaunchCommand` maps
permission modes to Gemini flags (`--approval-mode auto_edit`, `--yolo`); starts
`running` (no transcript parser yet, so the PTY shows activity and the dot reflects
liveness). **De-listed aider** from the agentd probe (it was advertised as
installed but not integrated — implied breadth we don't deliver). Unit-tested
(launch flags + initial status). Note: Gemini transcript-derived status
granularity (thinking/idle) is a documented follow-up.


**What:** Either add a full Gemini path (enum + launch flags + transcript parser +
hook template) or drop gemini/aider from `knownAgents`.
**Why:** They're **detected** (node-info shows them "installed") but **not
launchable / not status-parsed** → implies breadth the product doesn't deliver.
**Where:** `agentd/internal/metrics/metrics.go:59` (probe list), `packages/shared/src/
domain.ts` (`AgentTypeEnum`), `agent-launch.ts`, `agentd/internal/status/`.
**Acceptance:** Either Gemini sessions start + report status, or it's not advertised.

## [x] T21 — OpenCode status fidelity ⚪ (Effort: M) — DONE
**Done:** Removed the flawed agentd node-global mtime heuristic (it clobbered
per-session status and couldn't express awaiting/error). OpenCode now reports
accurate **per-session** status via its hook plugin (T1) → the existing OpenCode
hook translator, which already maps permission.request/question.ask →
awaiting_input, tool failures → error, idle/complete, etc. — exactly like
claude/codex. `DetectAgent` returns "" for opencode (no transcript watcher);
deleted `opencode.go`. Two concurrent OpenCode sessions now get independent status.
Tests updated; agentd green.


**What:** Make OpenCode status per-session and able to express awaiting/error (today
it's a node-global mtime heuristic: recent write → running, else idle).
**Why:** OpenCode gets a degraded supervision experience; concurrent OpenCode
sessions on a node share one status.
**Where:** `agentd/internal/status/opencode.go:31-56`.
**How:** Pin the OpenCode store schema, key by session/cwd; or rely on the OpenCode
hook plugin once T1 lands.
**Acceptance:** Two concurrent OpenCode sessions report independent status incl.
awaiting_input.

---

# Phase 5 — Reliability & UX polish (⚪)

## [x] T22 — Reconnect backoff jitter (Effort: S) — DONE
**Done:** `usePtyWebSocket` backoff now applies ±20% jitter
(`base * (0.8 + Math.random()*0.4)`) so a fleet of grid terminals doesn't
reconnect in lockstep after an orchestrator restart.

## [x] T23 — Clean up half-open agentd connections on failed handshake (Effort: S) — DONE
**Done:** `clientForLocal`/`clientForRemote` now `dispose()` the client + `destroy()`
the socket/channel when `hello()` throws (no more leaked socket+decoder per failed
attempt). `NodeAgentdClient.send` guards `if (this.closed) return;` + try/catch
(no write-after-end throw on a dropped link).

## [x] T24 — WebGL slot leak on dispose throw (Effort: S) — DONE
**Done:** `Terminal.tsx` cleanup now calls `releaseWebgl()` in a `finally`, so the
global GPU slot is returned even if `webgl.dispose()` throws (no more silent
DOM-renderer fallback for later terminals).

## [x] T25 — TS frame-decoder size cap (Effort: S) — DONE
**Done:** `FrameDecoder.push` throws `FrameTooLargeError` when a length prefix
exceeds `MAX_FRAME_BYTES` (16 MiB, matching the Go side); `onChunk` catches it and
tears the link down (`onClose` + `sock.destroy()`) instead of buffering
unboundedly. Unit-tested (normal/split frames decode; over-cap throws).

## [x] T26 — agentd nohup-fallback reboot survival (Effort: S, doc) — DONE
**Done:** Documented the caveat in `agentd-bootstrap.ts launch()` and
`docs/flock-agentd-design.md §5`: the nohup fallback doesn't survive reboot;
recovery is LAZY (the health probe is connect-only and won't relaunch — the next
session create/open re-bootstraps via `ensureRunning`); prefer `systemd --user` +
linger for automatic reboot survival; a periodic orchestrator re-assert is noted as
future work.

---

## Suggested execution order
1. **T1, T2** (Phase 1) — highest leverage; not gated by the threat-model decision. Do these first.
2. **Decide A/B**, then the relevant **Phase 2** security tasks (T4–T9).
3. **Phase 3** prod-readiness (T10–T16) when preparing to deploy.
4. **Phase 4** capabilities (T17–T21) to reach "elite".
5. **Phase 5** polish opportunistically.

## Open questions for the reviewer
1. Threat model **A or B**? (gates Phase 2 urgency)
2. Is a real production deploy imminent (prioritize Phase 3), or is this staying
   local-dev for now?
3. For T17 sandboxing — is landlock/seccomp acceptable complexity, or do you prefer
   "autonomous only on explicitly-isolated nodes (e.g. throwaway VMs)" as the model?
4. T20 — keep Gemini on the roadmap (build it) or de-list for now?
