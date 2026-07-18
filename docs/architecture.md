# Architecture

How Shepherd is put together, end to end. After this you should understand where any given
piece of behavior lives and how a session's data flows.

## The one-paragraph model

Shepherd runs agents on **nodes** (machines reached over SSH plus a bundled isolated
local runtime). Each node runs **`flock-agentd`**, a daemon
that owns the agents' terminals and watches what they're doing. The **orchestrator** —
the always-on brain — talks to every node's daemon, normalizes everything into one
status + telemetry model, and serves a REST + WebSocket API. The **web** app is a thin
viewer of that model: it renders the live terminals and status, and sends your keystrokes
back. Your browser is never in the data path — disconnect it and the agents keep running.

```
 Browser ──HTTPS/WS──▶ orchestrator ──SSH/socket──▶ flock-agentd (per node) ──PTY──▶ agent
   (viewer)              (brain + API)                (terminals + status)         (claude/…)
                            ├──▶ Postgres  (durable record — NOT on the live path)
                            └──▶ project Ports gateway ── SSH/socket ──▶ node loopback port
                                  (isolated hostname or private pool + expiring capability)
```

## The three components

### 1. `flock-agentd` — the node daemon (`agentd/`, Go)

One per node. It is the reason sessions survive disconnects: the agent's process and its
PTY live **inside the daemon**, not inside any client connection.

- **Raw PTYs.** Each session is a real pseudo-terminal the daemon spawns and owns. It
  keeps scrollback so a reconnecting client gets a clean replay (including alt-screen
  apps like `vim`/`htop`).
- **Framed binary protocol.** The orchestrator multiplexes all sessions for a node over
  a **single** connection — a unix socket for the local node, or an SSH `direct-tcpip`
  channel to `127.0.0.1` for remote nodes. Control frames (open/resize/close/status) and
  PTY data frames share the link.
- **Status + telemetry.** The daemon tails each agent's **transcript files** and/or
  receives its **lifecycle hooks**, deriving a per-session status (starting / running /
  awaiting_input / idle / error / done) plus telemetry (tokens, model, context %, cost,
  plan) — and streams changes to the orchestrator.
- **Metrics.** Node CPU / memory / disk / load, detected agent CLIs, and **per-session
  RSS + CPU%** (so you can see which agent is eating a box).
- **Port discovery.** The optional `listening_ports_v1` capability reports a bounded,
  read-only snapshot of loopback/wildcard HTTP candidates with short process, cwd, and
  known-session association. Older compatible daemons remain usable through manual
  project Port entry.
- **Node operations.** Local Git/filesystem/workspace calls use bounded `exec_v1`;
  Preview uses a separate, numeric-loopback-only `tcp_tunnel_v1`. Bulk traffic never
  competes with the PTY/status control link.

Why a purpose-built daemon instead of tmux: see [flock-agentd-design.md](flock-agentd-design.md).

### 2. `orchestrator` — the brain (`apps/orchestrator/`, TypeScript)

Always-on. Stateless on the hot path; durable state in Postgres.

- **API.** Fastify REST + a WebSocket for live status/telemetry and PTY streams.
- **Status model.** Merges each node's daemon status frames + agent hook callbacks into
  the single shared `Status` enum and telemetry shape (`packages/shared`). This is what
  the dots and bars render from. The merge layer slows DB-backed polls to backstops —
  the live path is in-memory.
- **Agent hook endpoint.** `POST /api/hooks/:sessionId` (the only unauthenticated route,
  gated by a per-session bearer token) receives agent lifecycle events. Per-agent
  _translators_ map each agent's payload to the unified status (`status/translators/`).
- **Transport.** An agentd client (with SSH bootstrap for remote nodes, a reverse tunnel
  so node-side agents can reach the hook endpoint, and reconnect-with-backoff).
- **Project Ports & Preview** merge daemon listener observations, durable project labels,
  and ephemeral forwards. Each forward dials only one explicit loopback port on the
  project's node. HTTP, HTTPS upstreams, WebSocket, and HMR are preserved through either
  an isolated hostname or a bounded private no-DNS port pool—without a Docker socket or
  server-side browser.
- **Auth, web push, secret store** (encryption at rest), verified vault recovery, and
  owner-only redacted diagnostics.
- **Postgres** (via Drizzle) is the **system of record** — users, nodes, projects,
  sessions, audit — and is _never_ on the live status path (PRD §6.6). Migrations run
  idempotently on boot.

### 3. `web` — the dashboard (`apps/web/`, React)

A PWA that renders the orchestrator's model. Internally the shell is the **paddock**.

- `node → project → session` tree (sidebar, collapsible to an icon rail).
- Live terminals via **xterm.js on desktop** and **Ghostty Web on mobile** — a focused
  view or project Pens that watch several agents at once; sessions persist across
  view switches and network reconnects.
- Status dots + a telemetry bottom bar (model · tool · context % · tokens · cost).
- A **source-control** panel (live git diff + stage/commit/push), a **plan** artifact,
  an **activity** timeline, a node **file browser**, and secure **Remote Preview**.
- State: **Zustand** store as the render driver; **TanStack Router/Query** for routing +
  server cache; live updates arrive over the status WebSocket.

### Shared contracts (`packages/shared/`)

The single source of truth for cross-process types: the `Status` enum, telemetry,
node/session/agent contracts, and the per-agent hook payload **Zod schemas**. Both the
orchestrator and web import these, so the wire shape is never duplicated.

## Nodes

A **node** is a machine Shepherd can run agents on:

- **local** — the separate `node-runtime` container. It owns the daemon, workspaces,
  tools, and live processes and is reached over a mutually authenticated Unix socket.
- **SSH nodes** — any host you have SSH access to. The orchestrator bootstraps
  `flock-agentd` onto it, then reaches it over an SSH loopback channel. Credentials
  (key/passphrase/password) are stored encrypted.

You add, edit, and inspect nodes from the UI; the bottom status bar and a node-info
dialog surface each node's live metrics.

## How a status dot lights up (the live path)

1. An agent does something — finishes a turn, hits a permission prompt, runs a tool.
2. The agent emits a **hook** (Claude/Grok/OpenCode) and/or writes to its
   **transcript** (Claude/Codex). Hooks `curl` the orchestrator's hook endpoint over the
   node's reverse tunnel; transcripts are tailed by `flock-agentd`.
3. The orchestrator's per-agent **translator** maps that into the unified `Status` (+
   telemetry), updates the in-memory status map, and pushes it over the **status
   WebSocket**.
4. The web app's live-data layer applies the update — the dot, the bottom bar, and the
   sidebar all reflect it within a tick. If the new state is `awaiting_input` / `error` /
   `done`, a **web push** also fires so you're notified away from keyboard.

Postgres is not involved in steps 2–4 — it only records the durable history.

## How a terminal works (the data path)

1. The web app opens a PTY stream over the WebSocket for a session.
2. The orchestrator subscribes to that session on the node's `flock-agentd` over the
   single multiplexed link; the daemon replays scrollback, then streams live output.
3. Your keystrokes travel the reverse direction (input frames → daemon → PTY).
4. Close the browser and the PTY keeps running in the daemon. Reopen anywhere and you get
   a clean replay — the session never died.

## Persistence & failure model

- **Sessions** live in `flock-agentd` on always-on nodes → survive client disconnects
  and orchestrator replacement. Runtime/daemon or host loss terminates live processes;
  recovering PTYs across daemon death is separate work.
- **Management state** (who/what/where) lives in Postgres.
- Remote nodes' daemons run under a process supervisor; the orchestrator reconnects with
  backoff and re-establishes the hook tunnel (with retry) on reconnect.

## Security boundaries

- Every UI / API / WS request requires authentication (session cookie). The hook
  endpoint is the sole exception — authorized by a per-session token only.
- Node transport is SSH; the agentd control channel adds a shared secret (defense in
  depth), kept in a `0600` file and stripped from spawned agents' environments. A daemon
  refuses to open a TCP control port without a secret.
- Secrets (master key, DB password, SSH keys) are runtime-only — never in images, never
  in the repo.
- No Shepherd service has Docker-socket access. Preview content is isolated onto a
  dedicated wildcard origin or an explicitly acknowledged private port pool. The
  gateway strips control-plane credentials and dials only the selected node's numeric
  loopback port through its existing transport. Exact Origin enforcement protects every
  unsafe browser mutation, including same-host/different-port Preview deployments.

See [deployment.md](deployment.md) for how this maps onto the production stack, and the
[agent integration matrix](agent-integration-matrix.md) for the per-agent specifics.
