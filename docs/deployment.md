# Deployment (Docker Compose)

Flock deploys as a Docker Compose stack on an always-on host (a VPS). **The host needs
only Docker** with the Compose plugin — Node, pnpm, Postgres, and the Go toolchain all
run inside containers or are built there; nothing is installed on the host itself.

```
                       host ports 80 / 443
                              │
                ┌─────────────▼─────────────┐
                │   caddy (TLS terminator)  │  ships with the stack;
                │  HTTPS → /  /api  /ws      │  certs persist in caddy_data.
                └──────┬──────────────┬──────┘
                  /    │              │ /api  /ws
                       ▼              ▼
        ┌──────────────┐      ┌─────────────────┐
        │   web (nginx)│      │  orchestrator   │──┐ dockerode
        │  static PWA  │      │   Node + TS     │  │ (Docker socket)
        └──────────────┘      └────────┬────────┘  ▼
                                       │     per-session Chrome
                              ┌────────▼──────┐    containers
                              │   postgres    │   (launched at runtime,
                              │  (registry)   │    NOT a compose service)
                              └───────────────┘
```

## Services

`docker compose up` brings up four services:

| Service | Image | Role |
|---|---|---|
| `caddy` | `caddy:2-alpine` (digest-pinned) | TLS-terminating reverse proxy on host `80`/`443`; routes `/` → `web`, `/api` + `/ws` → `orchestrator`. ACME certs persist in the `caddy_data` volume. |
| `postgres` | `postgres:16-bookworm` (digest-pinned) | Durable system of record. **Never** on the live status path. |
| `orchestrator` | built from `docker/Dockerfile.orchestrator` | The brain: status model, hooks, SSH/agentd, browser lifecycle, auth. Also runs the bundled **flock-agentd** for the local node. |
| `web` | built from `docker/Dockerfile.web` | The static React/Vite PWA, served by nginx. |

**Per-session browser containers are not Compose services.** One isolated Chrome
container is launched **per session at runtime** by the orchestrator (via `dockerode`
against the mounted Docker socket) and destroyed on teardown. This keeps isolation at the
container boundary while keeping the static topology minimal.

> **Prerequisite:** browser panes need the **`flock/session-chrome`** image (a custom
> Chrome that bridges CDP to a published port; stock Chrome images bind the debugger to
> loopback only). Build it before using browser panes — it is NOT pulled automatically:
> ```
> docker build -f docker/Dockerfile.session-chrome -t flock/session-chrome:latest .
> ```
> Override the name with `BROWSER_IMAGE`. Without it, sessions still work but the
> Browser pane fails to start.

## Quick start

```bash
# 1. Configure runtime secrets/config (nothing is baked into images)
cp .env.example .env
$EDITOR .env

# 2. (Recommended) populate Docker secret files
mkdir -p secrets
openssl rand -base64 32 > secrets/flock_master_key      # secret-store master key
printf '%s' 'a-strong-db-password' > secrets/postgres_password
chmod 600 secrets/*

# 3. Bring it up
docker compose up -d

# 4. Watch it boot
docker compose logs -f orchestrator
docker compose ps
```

The orchestrator runs **idempotent Drizzle migrations on boot** before starting, so a
fresh database provisions itself automatically.

Open `https://<host>` (Caddy serves `443`; `80` redirects to HTTPS), complete first-run
admin setup, then log in. Override host ports with `HTTP_HOST_PORT` / `HTTPS_HOST_PORT`.

## Secrets — runtime only, never in images

No secret value is ever copied into an image layer. Secrets reach the containers two
ways, in order of preference:

1. **Docker secret files** (`./secrets/*`, mounted at `/run/secrets/<name>`):
   - `flock_master_key` → secret-store master key for encryption at rest.
   - `postgres_password` → Postgres password.
2. **Environment** via `.env` (read automatically by Compose) for everything else
   (`DATABASE_URL`, VAPID keys, browser config, `FLOCK_DOMAIN`, …). The agentd
   version is single-sourced from the shipped `agentd/VERSION` file — leave
   `FLOCK_AGENTD_VERSION` unset unless you are intentionally pinning an override
   (a stale value forces the daemon to re-ship/relaunch on every connect).

`.env` and `./secrets/` are gitignored. [`.env.example`](../.env.example) documents the
variables it covers.

## TLS / auth

The bundled `caddy` service terminates TLS on `443` and proxies to `web` and
`orchestrator` (which speak plain HTTP/WS on the internal network). Set your domain via
the `FLOCK_DOMAIN` env var (Caddy reads it) and it provisions certificates automatically.
To use your
own external proxy instead, drop the `caddy` service and route the same paths
(`/` → web, `/api` + `/ws` → orchestrator).

All UI / API / WS traffic requires authentication; the per-session hook endpoint is the
sole exception (authorized by a per-session token).

## Dev vs prod stacks

- **Production:** `docker-compose.yml` + `docker/Dockerfile.orchestrator` +
  `docker/Dockerfile.web` (multi-stage, pruned, non-root).
- **Local iteration in Docker:** `docker-compose.dev.yml` + `docker/Dockerfile.dev`
  (source-mounted, hot reload) — `docker compose -f docker-compose.dev.yml up`.
- **Native local dev (fastest):** `./run-dev.sh` — see the root [README](../README.md).
- **Multi-node simulation:** `docker-compose.nodes.yml` / the `vagrant/` profile bring up
  SSH node targets so you can exercise real remote nodes.

## Verifying a deploy

An integration test asserts the deploy artifacts (orchestrator + Postgres come up, no
static browser service, Docker socket mounted, secrets external, multi-stage builds), and
runs `docker compose config` as a smoke when the Docker CLI is present:

```bash
pnpm --filter @flock/orchestrator test:int   # includes deploy.int.test.ts
docker compose config >/dev/null && echo "compose OK"
```

## Upgrading the node daemon

`flock-agentd` is versioned (`agentd/VERSION` — the single source of truth). The
orchestrator ships the expected version to each node and, on a version mismatch,
re-ships + restarts the daemon automatically. To roll out a new daemon: bump
`agentd/VERSION`, rebuild the dist binary (`cd agentd && make dist`), and redeploy —
the rollout happens on next connect. (Keep `FLOCK_AGENTD_VERSION` unset so it
resolves from the shipped `agentd/VERSION`; only set it to pin an explicit override.)
