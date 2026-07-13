# Deployment (Docker Compose)

Shepherd deploys as a Docker Compose stack on an always-on host (a VPS). **The host needs
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
        │   web (nginx)│      │  orchestrator   │
        │  static PWA  │      │   Node + TS     │
        └──────────────┘      └──────┬─────┬────┘
                                     │     │ fixed authenticated API
                            ┌────────▼───┐ ┌▼────────────────┐── Docker socket
                            │ postgres   │ │ browser-worker  │── per-session Chrome
                            │ (registry) │ │ (least privilege)│   containers
                            └────────────┘ └─────────────────┘
```

## Services

`docker compose up` brings up five services:

| Service          | Image                                                       | Role                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caddy`          | `caddy:2-alpine` (digest-pinned)                            | TLS-terminating reverse proxy on host `80`/`443`; routes `/` → `web`, `/api` + `/ws` → `orchestrator`. ACME certs persist in the `caddy_data` volume. |
| `postgres`       | `postgres:16-bookworm` (digest-pinned)                      | Durable system of record. **Never** on the live status path.                                                                                          |
| `orchestrator`   | `ghcr.io/billiondollarsolo/shepherd-orchestrator:<version>` | The brain: status model, hooks, SSH/agentd, browser lifecycle, auth. Also runs the bundled **flock-agentd** for the local node.                       |
| `browser-worker` | orchestrator image, restricted entrypoint                   | The only Docker-socket holder; exposes a token-authenticated create/stop/reap API with fixed browser policy.                                          |
| `web`            | `ghcr.io/billiondollarsolo/shepherd-web:<version>`          | The static React/Vite PWA, served by nginx.                                                                                                           |

The orchestrator image includes the latest available Codex and OpenCode releases when
the image is built. On first container start, the entrypoint installs the latest Claude
Code directly from Anthropic for the bundled local node; Shepherd does not redistribute
Anthropic's commercially licensed binary. Agent tools on SSH nodes remain user-managed,
including any deliberate version pins. Set `FLOCK_INSTALL_CLAUDE_CODE=0` when a custom
image or mounted home directory supplies a user-managed Claude Code version.

**Per-session browser containers are not Compose services.** One isolated Chrome
container is launched **per session at runtime** by `browser-worker` and destroyed on
teardown. The orchestrator calls only its narrow lifecycle API and has no Docker socket.

> **Prerequisite:** browser panes need the **`shepherd-session-chrome`** image (a custom
> Chrome that bridges CDP to a published port; stock Chrome images bind the debugger to
> loopback only). Pull the version matching the Shepherd stack before using browser panes:
>
> ```
> docker pull ghcr.io/billiondollarsolo/shepherd-session-chrome:0.3.0
> ```
>
> Override the name with `BROWSER_IMAGE`. Without it, sessions still work but the
> Browser pane fails to start.

## Quick start

```bash
# 1. Configure runtime secrets/config (nothing is baked into images)
cp .env.example .env
$EDITOR .env

# 2. (Recommended) populate Docker secret files
mkdir -p secrets backups
openssl rand -base64 32 > secrets/flock_master_key      # secret-store master key
openssl rand -base64 48 > secrets/browser_worker_token # browser-worker API capability
printf '%s' 'a-strong-db-password' > secrets/postgres_password
chmod 600 secrets/*

# 3. Pull the pinned release images (FLOCK_VERSION in .env), then bring it up
docker compose pull
docker pull "${BROWSER_IMAGE:-ghcr.io/billiondollarsolo/shepherd-session-chrome:0.3.0}"
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
   - `browser_worker_token` → authenticates the narrow browser lifecycle API. It is
     mounted to the control and worker identities only, never to coding agents.
2. **Environment** via `.env` (read automatically by Compose) for everything else
   (optional `DATABASE_URL` override, VAPID keys, browser config, `FLOCK_DOMAIN`, …).
   By default the orchestrator constructs its internal database URL from the same
   mounted Postgres password secret. The agentd
   version is single-sourced from the shipped `agentd/VERSION` file — leave
   `FLOCK_AGENTD_VERSION` unset unless you are intentionally pinning an override
   (a stale value forces the daemon to re-ship/relaunch on every connect).

`.env` and `./secrets/` are gitignored. [`.env.example`](../.env.example) documents the
variables it covers.

The raw Docker socket is mounted only into `browser-worker`. Its authenticated API
accepts UUID-scoped launch, stop, and reap operations; image, network, loopback/internal
CDP access, memory, CPU, PID limits, labels, and commands are server policy. The
orchestrator cannot request host mounts, privileged mode, host networking, or unrelated
container operations.

## TLS / auth

The bundled `caddy` service terminates TLS on `443` and proxies to `web` and
`orchestrator` (which speak plain HTTP/WS on the internal network). Set your domain via
the `FLOCK_DOMAIN` env var (Caddy reads it) and it provisions certificates automatically.
To use your
own external proxy instead, drop the `caddy` service and route the same paths
(`/` → web, `/api` + `/ws` → orchestrator).

All UI / API / WS traffic requires authentication; the per-session hook endpoint is the
sole exception (authorized by a per-session token).

## Supported network modes

### Production HTTPS

Use the bundled Caddy path above or an equivalent trusted reverse proxy. Set
`PUBLIC_BASE_URL` and every entry in `FLOCK_ALLOWED_ORIGINS` to exact `https://`
origins. Keep the orchestrator/web/Postgres/browser-worker services on the internal
Compose network and publish only the proxy. Production startup rejects missing,
wildcard, credential-bearing, or non-HTTPS browser origins.

### Tailnet HTTPS

Prefer a MagicDNS hostname with a valid certificate over a raw Tailscale IP. Restrict
the Shepherd host to the operator's devices with Tailscale grants/ACLs, require device
approval, review key expiry, and consider Tailnet Lock for installations that need
stronger control-plane protection. Tailnet membership is an outer network boundary,
not authentication: keep Shepherd login, exact Origin validation, and HTTPS enabled.

### Localhost development

`./run-dev.sh` and the development Compose stack may use loopback HTTP with
`FLOCK_INSECURE_COOKIES=1`. That exception is for the same machine only. Diagnostics
show development/insecure warnings, and the production image does not infer this mode.

Direct public/LAN HTTP is unsupported. Tailnet-IP HTTP is only a temporary development
mode and must not carry reusable credentials over an untrusted path. Never expose the
orchestrator port, browser-worker port, agentd port/socket, PostgreSQL, or Docker socket
directly.

## SSH node posture

Use a dedicated SSH account whose privilege is limited to installing/supervising
`flock-agentd` and accessing intended workspaces. Verify the displayed host fingerprint
before accepting first use; a changed host key fails closed and must be investigated,
not silently re-pinned. Agentd separates the control and agent identities, drops session
processes to `flock-agent`, and never exposes the node-control credential to an agent.

Back up the Shepherd master key separately from encrypted
[vault backups](backup-and-recovery.md). Losing it makes encrypted node credentials
unrecoverable; exposing it makes those envelopes decryptable.

### Prepare a remote node

Run the production preparation script once as root on each Linux amd64/arm64 host,
using the public half of the SSH key that Shepherd will use:

```bash
sudo ./scripts/flock-node-prepare.sh \
  --public-key-file /path/to/flock-control.pub \
  --workspace /srv/flock/workspaces \
  --install-agents

sudo ./scripts/flock-node-prepare.sh --check --workspace /srv/flock/workspaces
```

The script is idempotent. It creates `flock-control` for SSH/control operations,
creates the locked `flock-agent` runtime identity, installs a single validating root
helper with a narrow sudo rule, and makes the workspace runtime-owned. The optional
agent installation uses the official latest Claude/OpenCode installers and a
runtime-user-local Codex npm prefix. Provider login remains manual and belongs to
`flock-agent`; Shepherd never creates or captures provider accounts.

Register the node with SSH user `flock-control`. Its detail page runs the same
read-only preflight and reports platform support, SSH forwarding, installation disk
space, preparation, daemon version, workspace access, and detected agent versions. A
missing preparation or unwritable project directory blocks readiness instead of
failing later as a blank terminal.

## Dev vs prod stacks

- **Production:** `docker-compose.yml` pulls versioned GHCR images. Pin
  `FLOCK_VERSION`; do not deploy the mutable `latest` tag.
- **Build release images locally:** use `docker compose build` for orchestrator/web
  and `docker build -f docker/Dockerfile.session-chrome -t shepherd-session-chrome:local .`
  for the on-demand browser image.
- **Local iteration in Docker:** `docker-compose.dev.yml` + `docker/Dockerfile.dev`
  (source-mounted, hot reload) — `docker compose -f docker-compose.dev.yml up`.
- **Native local dev (fastest):** `./run-dev.sh` — see the root [README](../README.md).
- **Multi-node simulation:** `docker-compose.nodes.yml` / the `vagrant/` profile bring up
  SSH node targets so you can exercise real remote nodes.

## Verifying a deploy

An integration test asserts the deploy artifacts (orchestrator + Postgres come up,
Docker socket mounted only on the constrained worker, secrets external, multi-stage builds), and
runs `docker compose config` as a smoke when the Docker CLI is present:

```bash
pnpm --filter @flock/orchestrator test:int   # includes deploy.int.test.ts
docker compose config >/dev/null && echo "compose OK"
```

## Upgrading the node daemon

`flock-agentd` is versioned (`agentd/VERSION` is the preferred binary) and governed
by `agentd/COMPATIBILITY.json` (minimum daemon, supported protocols, and required
authenticated capabilities). Release orchestrator images include Linux amd64 and
arm64 daemon binaries.

Shepherd reports one of three states:

- **Compatible:** keep the daemon. A newer compatible daemon is never downgraded.
- **Upgrade recommended:** the daemon is supported but older than preferred, or its
  managed service needs migration.
- **Upgrade required:** the daemon is below the supported floor, speaks no supported
  protocol, has invalid version metadata, or lacks a required capability.

A node with live sessions keeps its authenticated existing daemon and reports the
rollout as deferred. Once sessions drain, the next node operation activates the
candidate. If Shepherd cannot authenticate the old protocol and count sessions, it fails
closed instead of assuming the node is idle. Candidates are installed by atomic
rename, must pass the real authenticated protocol handshake, and restore the retained
previous binary if validation fails.

To roll out a new daemon, update the synchronized release and compatibility manifest,
rebuild the image (or pull the new release), and redeploy. Keep
`FLOCK_AGENTD_VERSION` unset so it resolves from the shipped `agentd/VERSION`; only
set it to pin an explicit development override. The complete lifecycle policy is in
[agentd-compatibility-and-upgrade-plan.md](agentd-compatibility-and-upgrade-plan.md).

## Upgrade an installation

Use the backup-gated helper from the deployment directory:

```bash
install -m 0600 /dev/null /tmp/flock-vault-password
$EDITOR /tmp/flock-vault-password
FLOCK_VAULT_PASSWORD_FILE=/tmp/flock-vault-password \
  ./scripts/flock-upgrade.sh 0.3.1
```

The helper fetches the target release's HTTPS-published compatibility asset and
compares it with the running image before changing anything. If the target raises the
minimum daemon, removes a protocol, or requires a new capability, the command stops
and explains that some nodes may require mandatory upgrades. After reviewing the
release notes, rerun with `--acknowledge-node-policy-change`. Exact per-node state is
shown on each node page from its authenticated daemon handshake.

It then verifies Compose, creates and verifies an encrypted pre-upgrade vault, pulls
exact versioned images, updates `FLOCK_VERSION`, clears any stale browser-image
override so session Chrome follows the same release, starts the stack, applies the
normal idempotent migrations, and verifies readiness. `--skip-backup` and
`--skip-compatibility-check` exist only as explicit operator escape hatches.

Shepherd does not pretend forward database migrations are automatically reversible. On
failure the helper retains the prior `.env` and reports the verified vault; use the
documented restore procedure rather than blindly starting an older image against a
newer schema.

Schema changes use expand/migrate/contract sequencing for the documented support
window. Do not contract data needed by a still-supported rollback release. Shepherd's
orchestrator, web, and browser images remain on one immutable release version; remote
daemon compatibility is the deliberate exception governed by the manifest above.
