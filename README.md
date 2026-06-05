# Flock

A self-hosted **web cockpit for supervising a flock of CLI coding agents**
(Claude Code, Codex, OpenCode) across one or more machines over SSH. Runs as a
Docker deployment on an always-on VPS; you interact entirely through a browser
(PWA).

See [`PRD.md`](./PRD.md) for product intent and
[`docs/specs/`](./docs/specs/) for the implementation spec.

---

## Production deploy (Docker Compose) — US-38

The host needs **only Docker** (with the Compose plugin). All building and
running happens inside containers; nothing — Node, pnpm, Postgres, tmux — needs
to be installed on the host.

```
                       host ports 80 / 443
                              │
                ┌─────────────▼─────────────┐
                │   caddy (TLS terminator)  │  US-39 — ships with the stack;
                │  HTTPS → /  /api  /ws      │  certs persist in caddy_data.
                └──────┬──────────────┬──────┘
                  /    │              │ /api  /ws
                       ▼              ▼
        ┌──────────────┐      ┌─────────────────┐
        │   web (nginx)│      │  orchestrator   │──┐ dockerode
        │  static PWA  │      │  Node 22 + TS   │  │ (Docker socket)
        └──────────────┘      └────────┬────────┘  ▼
                                       │     per-session Chrome
                              ┌────────▼──────┐    containers
                              │   postgres    │   (launched at
                              │  (registry)   │    runtime, NOT a
                              └───────────────┘    compose service)
```

### What Compose brings up

`docker compose up` starts four services (NFR-DEP1):

| Service        | Image                              | Role |
|----------------|------------------------------------|------|
| `caddy`        | `caddy:2-alpine` (digest-pinned)   | TLS-terminating reverse proxy on host `80`/`443`; routes `/` → `web`, `/api`+`/ws` → `orchestrator`. Certs/ACME keys persist in `caddy_data` (NFR-DEP2). |
| `postgres`     | `postgres:16-bookworm` (digest-pinned) | Durable system of record. **Never** on the live status path (PRD §6.6). |
| `orchestrator` | built from `docker/Dockerfile.orchestrator` | The brain: status model, hooks, SSH, browser lifecycle, auth. Also runs the bundled **flock-agentd** (local-node PTY transport). |
| `web`          | built from `docker/Dockerfile.web` | Static React/Vite PWA bundle served by nginx. |

**Per-session browser containers are not Compose services.** One isolated Chrome
container is launched **per session at runtime** by the orchestrator via
`dockerode` against the mounted Docker socket, and destroyed on session
teardown (PRD §6.5 Layer A, US-25, NFR-DEP1/SEC5). This keeps isolation at the
container boundary while keeping the static topology minimal.

### Quick start

```bash
# 1. Configure runtime secrets/config (nothing is baked into images — NFR-DEP2)
cp .env.example .env
$EDITOR .env

# 2. (Recommended in prod) populate Docker secret files
mkdir -p secrets
openssl rand -base64 32 > secrets/flock_master_key      # secret-store master key
printf '%s' 'a-strong-db-password' > secrets/postgres_password
chmod 600 secrets/*

# 3. Bring it up
docker compose up -d

# 4. Tail logs / check health
docker compose logs -f orchestrator
docker compose ps
```

The orchestrator container runs **idempotent Drizzle migrations** on boot before
starting the server, so a fresh database is provisioned automatically.

Open the web app at `https://<host>` (Caddy serves it on `443`; `80` redirects to
HTTPS). Override the host ports with `HTTP_HOST_PORT` / `HTTPS_HOST_PORT` if needed.
Complete first-run admin setup, then log in.

### Secrets — runtime only, never in images (NFR-DEP2)

No secret value is ever copied into an image layer. Secrets reach the running
containers two ways, in order of preference:

1. **Docker secret files** (`./secrets/*`, mounted at `/run/secrets/<name>`):
   - `flock_master_key` → secret-store master key for encryption at rest
     (PRD §6, NFR-SEC2).
   - `postgres_password` → Postgres superuser password.
2. **Environment** via `.env` (read automatically by Compose) for everything
   else (`DATABASE_URL`, VAPID keys, browser config, `FLOCK_AGENTD_VERSION`, …).

`.env` and `./secrets/` are gitignored. See [`.env.example`](./.env.example) for
the full, documented list of variables.

### TLS / auth

The bundled **caddy** service terminates TLS on `443` and proxies `/` → `web`,
`/api` + `/ws` → `orchestrator` (which speak plain HTTP/WS on the internal
network). Point Caddy at your domain in `docker/Caddyfile` and it provisions
certificates automatically; to use your own external proxy instead, drop the
`caddy` service and route the same paths. All UI/API/WS require auth; the
per-session hook endpoint is the sole exception (per-session token only) — see
US-39.

### Dev vs prod

- **Production:** `docker-compose.yml` + `docker/Dockerfile.orchestrator` +
  `docker/Dockerfile.web` (multi-stage, pruned, non-root).
- **Local iteration:** `docker-compose.dev.yml` + `docker/Dockerfile.dev`
  (source-mounted, hot reload). Use:
  `docker compose -f docker-compose.dev.yml up`.

### Verifying the deploy

A TDD acceptance test asserts the deploy artifacts against the US-38 criteria
(orchestrator + Postgres come up, no static browser service, Docker socket
mounted, secrets external, multi-stage builds). It also runs
`docker compose config` as a smoke when the Docker CLI is available:

```bash
pnpm --filter @flock/orchestrator test:int   # includes deploy.int.test.ts
# or, with Docker present, a direct smoke:
docker compose config >/dev/null && echo "compose OK"
```
