<div align="center">

<img src="apps/web/public/icons/icon.svg" alt="Flock" width="96" height="96" />

# Flock

**A self-hosted web platform for running and supervising a flock of CLI coding agents — across as many machines as you have, all from your browser.**

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) ·
[Codex](https://openai.com/codex/) ·
[OpenCode](https://opencode.ai/) ·
[Gemini](https://geminicli.com/) ·
[Grok](https://x.ai/cli)

</div>

---

## What is Flock?

You probably run coding agents in a terminal today — one at a time, on one machine,
and the work dies the moment you close the lid. Flock turns that into a **fleet**.

Point Flock at one or more machines ("**nodes**") over SSH. On each node it runs a
tiny daemon that owns your agents' terminals. From any browser you get a live
dashboard of every agent across every machine — what each one is doing right now
(**Idle** / **Working** / **Needs you**), what it's spending, and a real terminal you
can type into. Run several agents side-by-side on one project stage (or focus one).
Walk away, close your laptop, come back on your phone: the agents kept working and
the session is exactly where you left it.

### Why it's different

| | |
|---|---|
| 🔌 **Sessions never die when you leave** | Agents run inside `flock-agentd` on always-on nodes. Your machine is just a viewer — never in the data path. Reload, switch devices, lose Wi-Fi: the work continues. |
| 🔔 **Status you can trust at a glance** | Affirmative labels on every agent: **Idle**, **Working**, **Needs you** (plus Starting / Done / Error / Disconnected). Hooks + transcripts feed the model; away-from-keyboard **web push** when someone is blocked. |
| 📐 **One paddock, many agents** | Project stage with side-by-side, stacked, or **2×2** arrange; drag pane sizes; layout persists per project. Focus one agent full-stage, or **All agents** on one screen. |
| 🖥️ **Every session gets its own browser** | A per-session Chrome lets the agent drive a real browser **and** lets you watch / take over — streamed into the UI. |
| 🤖 **Works with any agent** | Five first-class integrations (status, tokens, model, context %, cost, plan) plus a graceful fallback for anything else. |

---

## Supported agents

Flock leverages **what each agent already produces on the node** — its lifecycle hooks
and/or its transcript files — and normalizes everything into one status + telemetry model.

| Agent | Status | `awaiting_input` | Tokens / Model / Context % | Plan |
|---|:---:|:---:|:---:|:---:|
| **Claude Code** | ✅ hooks + transcript | ✅ | ✅ | ✅ |
| **Codex** | ✅ transcript | ⚠️¹ | ✅ (exact ctx window) | ✅ |
| **OpenCode** | ✅ plugin | ✅ | ✅ (exact USD cost) | ✅ |
| **Gemini** | ✅ ACP | ✅ | ⚠️² | ⚠️² |
| **Grok** | ✅ hooks | — | — | — |

<sub>¹ Codex hooks (incl. the approval signal) are wired and ready; seeding is deferred until validated on a live node (transcript still drives status/tokens/plan). ² Gemini status + chat ride ACP; tokens/model/plan fill only when the ACP stream emits usage/plan. Full detail: [`docs/agent-integration-matrix.md`](docs/agent-integration-matrix.md).</sub>

---

## How it fits together

```
   Your browser (PWA — phone / laptop / desktop)
            │  HTTPS + WebSocket
            ▼
   ┌─────────────────────────────────────────────┐
   │  orchestrator  (Node · Fastify · Postgres)   │   the brain:
   │  auth · status model · hook endpoint · web    │   management state,
   │  push · per-session browsers · agentd client  │   never in the hot path
   └───────┬──────────────────────────┬───────────┘
           │ SSH (direct-tcpip)        │ unix socket
           ▼                           ▼
   ┌───────────────┐           ┌───────────────┐
   │  remote node  │   …N…     │  local node   │     each node runs:
   │  flock-agentd │           │  flock-agentd │
   │  ── raw PTYs  │           │  ── raw PTYs  │   • your agents' terminals
   │  ── status    │           │  ── status    │   • transcript/hook tailing
   │  ── metrics   │           │  ── metrics   │   • CPU/mem per session
   └───────────────┘           └───────────────┘
```

Three components, one monorepo:

- **`flock-agentd`** (Go) — the node daemon. Owns raw PTYs, speaks a framed binary
  protocol over an SSH loopback channel, tails agent transcripts/hooks for live status
  + telemetry, and reports node + per-session resource metrics. This is what makes
  sessions survive disconnects. See [`docs/flock-agentd-design.md`](docs/flock-agentd-design.md).
- **`apps/orchestrator`** (TypeScript · Fastify · Drizzle/Postgres) — the always-on
  brain. Authentication, the unified status model, the agent hook endpoint, SSH/agentd
  transport, per-session browser lifecycle, web push, and the REST + WebSocket API.
  Postgres is the durable record — **never** on the live status path.
- **`apps/web`** (React · Vite · xterm.js · TanStack · Zustand) — the dashboard. A
  `node → project → session` tree, multi-agent project stage (focus / All agents /
  row · col · 2×2), status dots + **Idle / Working / Needs you**, telemetry,
  source control, per-session browser screencast, and plan/activity.

---

## Quick start

> **Prerequisites:** [Node ≥ 22](https://nodejs.org), [pnpm ≥ 9](https://pnpm.io)
> (`npm i -g pnpm`), [Go ≥ 1.25](https://go.dev) (for the daemon), and **Docker** (the
> dev database + per-session browsers run in containers). The agent CLIs themselves
> (`claude`, `codex`, …) are installed on the **nodes**, not here.

### Option A — Run it locally (fastest way to see it)

Everything runs natively on your host with hot reload; only Postgres stays in Docker.

```bash
git clone git@github.com:billiondollarsolo/flock.git
cd flock
pnpm install

# Create your dev env from the template, then generate the throwaway secrets it needs:
cp .env.dev.example .env.dev.local
# (the template explains each value and the one-liners to generate the keys)

./run-dev.sh            # starts Postgres + flock-agentd + orchestrator + web
#   └─ add --reset-db on the first run for a clean database + fresh admin setup
```

Open **http://localhost:5173**, complete first-run admin setup, and you're in. The web
app proxies the API/WebSocket, so it's a single origin. (Direct API: `http://localhost:8080`.)

**Then:** use the bundled **local** node (or add an SSH node) → create a **project** →
**launch an agent**. To supervise several at once: open **All agents**, pick row / col /
**2×2**, drag pane sizes — the layout is saved per project and survives refresh.

### Option B — Deploy it (Docker Compose)

The host needs **only Docker** (with the Compose plugin) — nothing else is installed on
it. See [`docs/deployment.md`](docs/deployment.md) for the full guide; the short version:

```bash
cp .env.example .env && $EDITOR .env          # set PUBLIC_BASE_URL + FLOCK_DOMAIN

# Required: Compose mounts these as Docker secrets (up fails if they are missing)
mkdir -p secrets
openssl rand -base64 32 > secrets/flock_master_key
printf '%s' 'a-strong-db-password' > secrets/postgres_password
chmod 600 secrets/*

# Optional but required for the in-app Browser pane (agents still work without it)
docker build -f docker/Dockerfile.session-chrome -t flock/session-chrome:latest .

docker compose up -d                          # caddy + web + orchestrator + postgres
docker compose logs -f orchestrator
```

Caddy terminates TLS on `443` (`80` redirects), migrations run automatically on boot,
and per-session browser containers are launched on demand (when
`flock/session-chrome` is present). Open `https://<host>` (or `https://localhost`) and
complete admin setup.

> **Must set in `.env`:** `PUBLIC_BASE_URL` to the URL users open in the browser
> (e.g. `https://flock.example.com`) — used for hooks, cookies, and push. Match
> `FLOCK_DOMAIN` to that hostname so Caddy’s TLS cert is correct.

---

## Repository layout

```
flock/
├── agentd/              # flock-agentd — the Go node daemon (raw PTYs, status, metrics)
├── apps/
│   ├── orchestrator/    # the brain — Fastify API/WS, status model, SSH/agentd, auth, push
│   └── web/             # the dashboard — React + Vite + xterm.js PWA
├── packages/
│   └── shared/          # shared TypeScript contracts (Zod schemas, the Status enum, …)
├── docker/              # Dockerfiles + Caddyfile for the production stack
├── docs/                # architecture, agent integrations, deployment, decisions  ← start at docs/README.md
├── vagrant/             # libvirt VMs that simulate real remote SSH nodes (for testing)
├── run-dev.sh           # native dev runner (Postgres in Docker; everything else hot-reloaded)
└── docker-compose*.yml  # prod / dev / multi-node-sim stacks
```

---

## Development

```bash
pnpm dev              # orchestrator + web (or use ./run-dev.sh for the full stack incl. agentd)
pnpm build            # build every workspace
pnpm typecheck        # tsc across the monorepo
pnpm lint             # eslint
pnpm format           # prettier --write

# Tests
pnpm test:unit        # vitest unit suites (shared + orchestrator + web)
pnpm test:int         # integration suites (spins up Postgres + sshd in Docker)
pnpm test:e2e         # Playwright end-to-end
cd agentd && go test -race ./...   # the daemon
```

The orchestrator runs idempotent Drizzle migrations on boot, so a fresh database
provisions itself. To exercise **real remote nodes**, the `vagrant/` profile brings up
libvirt VMs you can add as SSH nodes.

---

## Configuration

Nothing sensitive is baked into any image — config and secrets are supplied at runtime.

- **Local dev:** [`.env.dev.example`](.env.dev.example) → copy to `.env.dev.local`.
- **Production:** [`.env.example`](.env.example) → copy to `.env`; prefer the
  `./secrets/*` Docker secret files for the master key + DB password.

Both templates document every variable inline. `.env*` (except the examples) and
`secrets/` are gitignored — **never commit real secrets or SSH keys.**

---

## Documentation

Start at **[`docs/README.md`](docs/README.md)** — the index. Highlights:

| Doc | What it covers |
|---|---|
| [`docs/roadmap.md`](docs/roadmap.md) | **The forward plan** — phased vision + tasks (success criteria + tests baked in) to the elite web platform |
| [`docs/architecture.md`](docs/architecture.md) | How the three components fit together, end to end |
| [`docs/agent-integration-matrix.md`](docs/agent-integration-matrix.md) | Exactly what Flock captures from each agent, and how |
| [`docs/flock-agentd-design.md`](docs/flock-agentd-design.md) | The node daemon — why it exists and how it works |
| [`docs/deployment.md`](docs/deployment.md) | The production Docker Compose stack, in depth |
| [`PRD.md`](PRD.md) | Product intent and the original requirements |

---

## Security model (at a glance)

- All UI / API / WebSocket traffic requires authentication. The only unauthenticated
  endpoint is the per-session hook callback — gated by a per-session bearer token.
- Node transport is SSH; the agentd control channel adds a shared secret on top, stored
  in a `0600` file and stripped from spawned agents' environments.
- Secrets and SSH keys live outside the repo and outside image layers (runtime only).

---

## Status

Active development. The full suite is green (build · ~1,000 unit · integration · `go -race`)
and the platform runs live across simulated multi-node SSH deployments.

Built by [@mjtechguy](https://x.com/mjtechguy) · [@blndollarsolo](https://x.com/blndollarsolo).
