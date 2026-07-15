<div align="center">

<img src="apps/web/public/icons/icon.svg" alt="Shepherd" width="96" height="96" />

# Shepherd

### Guide Your Flock Of Agents

**Run, organize, and supervise coding agents across all your machines from one browser.**

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) ·
[Codex](https://openai.com/codex/) ·
[OpenCode](https://opencode.ai/) ·
[Gemini](https://geminicli.com/) ·
[Grok](https://x.ai/cli) ·
[Aider](https://aider.chat/) ·
[Cursor Agent](https://docs.cursor.com/en/cli) ·
[Amp](https://ampcode.com/)

[![CI](https://github.com/billiondollarsolo/shepherd/actions/workflows/ci.yml/badge.svg)](https://github.com/billiondollarsolo/shepherd/actions/workflows/ci.yml)
[![CodeQL](https://github.com/billiondollarsolo/shepherd/actions/workflows/codeql.yml/badge.svg)](https://github.com/billiondollarsolo/shepherd/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/billiondollarsolo/shepherd?display_name=tag)](https://github.com/billiondollarsolo/shepherd/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

## What is Shepherd?

Shepherd keeps CLI coding-agent sessions alive on local or remote machines and gives
you one responsive Paddock for operating them. Start agents, follow live terminals,
see what needs attention, review Git changes, and move between desktop and mobile
without losing the session.

## What Shepherd gives you

| Capability                         | What it gives you                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Durable agent sessions**         | Agents run on their node, not in the browser. Reload, close your laptop, or lose Wi-Fi without terminating their work.               |
| **Nodes → Projects → Agents**      | See local and remote machines, the projects on each one, and every active agent through one clear hierarchy.                         |
| **Multi-agent Pens**               | Arrange one to four agents in each Pen, drag agents between Pens, choose a layout, or focus one agent full-screen.                   |
| **Live status and attention**      | See **Idle**, **Working**, **Needs you**, **Done**, **Error**, and connectivity state without opening every terminal.                |
| **Real terminals everywhere**      | Drive the actual PTY from desktop or mobile, with reconnect, scrollback, touch controls, keyboard shortcuts, and responsive sizing.  |
| **Full mobile Paddock**            | Select nodes and projects, create agents, inspect Git, open settings, and operate terminals without preparing everything on desktop. |
| **Git visibility without churn**   | Inspect project status, diffs, and agent activity while leaving branch and worktree strategy to you and your agents.                 |
| **Project Ports & Preview**        | Discover project web servers, remember labels, and open authenticated HTTP/WebSocket forwards in-app or in a native browser tab.     |
| **Node health and compatibility**  | See CPU, memory, storage, agent availability, daemon health, and whether a node upgrade is optional or required.                     |
| **Backup and operational insight** | Create verified encrypted vaults and inspect readiness, audit history, bounded failures, versions, and redacted diagnostics.         |
| **Flexible self-hosting**          | Use bundled TLS, your existing reverse proxy, private HTTP on a trusted network, or a custom topology you own.                       |

## Quick start

You need [Docker Engine](https://docs.docker.com/engine/install/) with a current Compose
plugin, Git, and OpenSSL. Shepherd publishes Linux `amd64` and `arm64` images on GHCR.
The Compose overrides use modern `!override` merging, so update the Compose plugin if it
does not recognize that tag.

### 1. Prepare the installation once

Every deployment scenario starts with the same checkout and secrets:

```bash
git clone https://github.com/billiondollarsolo/shepherd.git
cd shepherd

cp .env.example .env
mkdir -p secrets backups
openssl rand -base64 32 > secrets/flock_master_key
openssl rand -base64 32 > secrets/postgres_password
openssl rand -base64 48 > secrets/setup_token
chmod 600 secrets/*
```

Keep `.env`, `secrets/`, the database volume, and the master key private and backed up.
Do not run `docker compose down --volumes` unless you intend to erase the installation.

### 2. Choose how users will reach it

| Scenario                                       | Recommendation      | Encryption                           | Remote Preview                                   |
| ---------------------------------------------- | ------------------- | ------------------------------------ | ------------------------------------------------ |
| Public VPS or normal DNS name                  | **Bundled TLS**     | Automatic HTTPS                      | Yes, with wildcard DNS                           |
| Existing Caddy/nginx/Traefik/HAProxy/ingress   | **External TLS**    | Your proxy owns HTTPS                | Yes, with wildcard DNS                           |
| Tailscale IP, Tailnet hostname, or trusted LAN | **Private HTTP**    | Network-dependent; browser sees HTTP | No-DNS bounded port pool or private wildcard DNS |
| Local evaluation on the Docker host            | **Private HTTP**    | Loopback-only HTTP                   | Bounded local port pool                          |
| Anything else                                  | **Custom topology** | Your decision and responsibility     | Only with isolated preview hostnames             |

#### Recommended: public domain with automatic TLS

Point the main name and optional wildcard Preview suffix at the server, then edit `.env`:

```dotenv
FLOCK_DOMAIN=shepherd.example.com
PUBLIC_BASE_URL=https://shepherd.example.com
FLOCK_ALLOWED_ORIGINS=https://shepherd.example.com
FLOCK_PREVIEW_DOMAIN=preview.shepherd.example.com
ACME_EMAIL=admin@example.com
```

```bash
docker compose -f docker-compose.yml -f docker-compose.dns-cloudflare.yml pull
docker compose -f docker-compose.yml -f docker-compose.dns-cloudflare.yml up -d --wait
```

The official Traefik image obtains and renews the control-plane and wildcard Preview
certificates. Expose `80/tcp` and `443/tcp`; keep the
orchestrator, web, PostgreSQL, agentd, and Docker API off the public interface. Wildcard
DNS for `*.preview.shepherd.example.com` is optional: without it, omit the DNS override
and Preview domain, run base Compose, and Remote Preview stays disabled.

#### Optional DNS-01 with Cloudflare or Route53

The official Traefik image includes ACME DNS support through lego. A DNS profile is
required for wildcard Remote Preview certificates and is also useful when inbound
HTTP-01 validation is unavailable. DNS-01 manages only temporary ACME TXT records—it
does **not** create the control-plane or wildcard Preview A/AAAA records shown above.

For Cloudflare, create a zone-scoped API token with `Zone:Read` and `DNS:Edit`, store it
in a file, then add the override:

```bash
install -d -m 0700 secrets
install -m 0600 /dev/null secrets/cloudflare_api_token
$EDITOR secrets/cloudflare_api_token

docker compose \
  -f docker-compose.yml \
  -f docker-compose.dns-cloudflare.yml \
  pull
docker compose \
  -f docker-compose.yml \
  -f docker-compose.dns-cloudflare.yml \
  up -d --wait
```

For Route53, use an IAM principal restricted to the hosted zone and ACME TXT-record
changes. Put it in the standard AWS shared-credentials format at
`secrets/route53_credentials`, set `AWS_REGION`, then use
`docker-compose.dns-route53.yml` in the same commands. On AWS, an instance/task role is
preferred: provide the normal AWS credential chain in an operator override and omit the
static-key mount. Never put provider keys directly in `.env`.

#### Existing reverse proxy or ingress

Set the public HTTPS origin and optional Preview suffix in `.env`:

```dotenv
PUBLIC_BASE_URL=https://shepherd.example.com
FLOCK_ALLOWED_ORIGINS=https://shepherd.example.com
FLOCK_PREVIEW_DOMAIN=preview.shepherd.example.com
FLOCK_TRUST_PROXY=1
```

Start the external-proxy topology:

```bash
docker compose -f docker-compose.yml -f docker-compose.external-proxy.yml pull
docker compose -f docker-compose.yml -f docker-compose.external-proxy.yml up -d --wait
```

The bundled Traefik service is disabled. Your proxy routes:

- `/api/*`, `/ws*`, and `/health*` to `http://127.0.0.1:18080`;
- everything else on the main hostname to `http://127.0.0.1:18081`;
- the optional wildcard Preview hostname to `http://127.0.0.1:18082`.

Preserve the original `Host`, support WebSocket upgrades, and reproduce the security
headers from `docker/traefik/dynamic-tls.yml`. The upstream ports bind to loopback by
default.

#### Direct Tailscale/LAN IP or hostname over HTTP

This is convenient and valid when you accept the transport tradeoff. Edit `.env` with
the exact address the browser will open:

```dotenv
PUBLIC_BASE_URL=http://100.64.0.10:11010
FLOCK_ALLOWED_ORIGINS=http://100.64.0.10:11010
HTTP_HOST_PORT=11010
FLOCK_ALLOW_INSECURE_HTTP=1
FLOCK_PREVIEW_DOMAIN=
FLOCK_PREVIEW_BACKEND=port-pool
FLOCK_PREVIEW_PORT_RANGE=12000-12031
# Generate the exact finite value in Settings → Deployment & Preview.
FLOCK_PREVIEW_FRAME_SOURCES=
```

```bash
docker compose -f docker-compose.yml -f docker-compose.private-http.yml pull
docker compose -f docker-compose.yml -f docker-compose.private-http.yml up -d --wait
```

Open `http://100.64.0.10:11010`. Shepherd keeps authentication, exact Origin checks,
request limits, CSP, and host-only HttpOnly cookies enabled, but HTTP cannot protect the
login or session from someone who can observe or modify that network path. The UI keeps
an explicit warning visible. Some browser features, including Web Push and parts of PWA
installation, may be unavailable because the page is not a secure context. Shepherd
deliberately omits COOP on non-loopback HTTP because browsers cannot honor it there;
HTTPS and localhost deployments retain opener isolation.

IP-only Preview uses the explicitly published `12000-12031` pool. Each project service
receives one expiring port and the listener serves Preview traffic only—never login,
API, health, hooks, or PTYs. Restrict both `11010/tcp` and the selected pool to your
Tailnet/LAN. Port-pool apps share a browser cookie host, so use it only for trusted
development apps; hostname mode remains the stronger isolation boundary.

After sign-in, open **Settings → Deployment & Preview**, copy the generated finite
`FLOCK_PREVIEW_FRAME_SOURCES` value into `.env`, and redeploy if you want **Open here**.
Without that CSP value, **Open in browser** works and embedded Preview fails closed.

#### Private DNS with HTTP and Remote Preview

Private HTTP can still support Preview when internal DNS provides isolated wildcard
hostnames:

```dotenv
PUBLIC_BASE_URL=http://shepherd.home.arpa:11010
FLOCK_ALLOWED_ORIGINS=http://shepherd.home.arpa:11010
HTTP_HOST_PORT=11010
FLOCK_ALLOW_INSECURE_HTTP=1
FLOCK_PREVIEW_DOMAIN=preview.shepherd.home.arpa
FLOCK_PREVIEW_BACKEND=hostname
FLOCK_PREVIEW_FRAME_SOURCES=http://*.preview.shepherd.home.arpa:11010
```

Resolve both `shepherd.home.arpa` and `*.preview.shepherd.home.arpa` to the Shepherd host,
then use the same `docker-compose.private-http.yml` commands above.

#### Local evaluation

For a loopback-only evaluation, set the exact local origin in `.env`:

```dotenv
FLOCK_DOMAIN=unused.invalid
PUBLIC_BASE_URL=http://localhost:11010
FLOCK_ALLOWED_ORIGINS=http://localhost:11010
HTTP_HOST_PORT=11010
FLOCK_ALLOW_INSECURE_HTTP=1
FLOCK_PREVIEW_BACKEND=port-pool
```

```bash
docker compose -f docker-compose.yml -f docker-compose.private-http.yml pull
docker compose -f docker-compose.yml -f docker-compose.private-http.yml up -d --wait
```

Open `http://localhost:11010`. Loopback is a browser-trustworthy development origin and
does not require a locally generated certificate.

### You own the deployment

These scenarios are recommendations, not a hosted-service requirement. Shepherd is MIT
licensed, does not require a Shepherd cloud account, and does not phone home for
authorization. You may change bindings, ports, DNS, proxies, certificates, firewall
rules, or Compose files to match your environment—including exposing private HTTP to
the Internet if you consciously accept that credentials and sessions can be intercepted.
It will function in that mode, but Shepherd does not present that topology as secure or
recommended.

The application refuses only internally inconsistent security configuration: TLS modes
require exact `https://` origins, `private-http` requires exact `http://` origins plus
`FLOCK_ALLOW_INSECURE_HTTP=1`, and Preview requires either a separate DNS suffix or the
explicit private port-pool profile. Those
checks prevent accidental half-secure configurations; they do not choose your network
architecture for you.

A fully custom edge must preserve this routing contract:

```text
main hostname /api/*, /ws*, /health*  -> orchestrator:8080
main hostname everything else        -> web:80
optional wildcard Preview hostname   -> orchestrator:8081
private no-DNS Preview port range     -> orchestrator:same bounded range
PostgreSQL and agentd                 -> never browser-facing
```

Use `FLOCK_DEPLOYMENT_MODE=builtin-tls`, `external-tls`, or `private-http` in a custom
production definition so the backend applies the matching URL, cookie, warning, and
diagnostic policy. See the [complete deployment guide](docs/deployment.md) for proxy
headers, firewalls, Preview DNS, backups, upgrades, and verification.

### 3. Complete first-run setup

A fresh database has no default username or password. Open the chosen URL, select **Set
up Shepherd**, and enter the exact value from `secrets/setup_token`. Only someone with
server access can create the sole administrator. The token cannot log in and becomes
inert after the owner exists; keep the file mounted so startup can validate the
installation configuration.

Useful checks and lifecycle commands:

```bash
docker compose ps
docker compose logs -f orchestrator
curl --fail https://your-shepherd-host/health
docker compose down                 # stop services; preserve data
docker compose down --volumes       # destructive: erase installation data
```

## Your first Paddock

1. Complete first-run administrator setup with the generated server setup token.
2. Open the bundled **local** node or add a remote Linux node over SSH.
3. Create a project with its working directory.
4. Launch an agent. The first four project agents enter **Pen 1** automatically.
5. Drag agents between Pens, choose each Pen's layout, or focus one full-screen.
6. Press **⌘K** or **Ctrl+K** to jump to any node, project, agent, setting, or action.

The Paddock is the cross-node overview. Node pages show health and projects, project
pages expose agents and Git information, and Pens control which terminals share the
workspace. On mobile, the same hierarchy, creation flows, settings, and live terminal
controls remain available.

## Supported coding agents

Shepherd uses the lifecycle data each tool already produces and normalizes it into a
single status and telemetry model. Unknown CLI tools still work as terminal sessions;
first-class integrations add richer status and metadata.

| Agent            | Status source      | Attention | Tokens / model / context | Plan |
| ---------------- | ------------------ | :-------: | :----------------------: | :--: |
| **Claude Code**  | Hooks + transcript |    ✅     |            ✅            |  ✅  |
| **Codex**        | Transcript         |    ⚠️     |            ✅            |  ✅  |
| **OpenCode**     | Plugin             |    ✅     |            ✅            |  ✅  |
| **Gemini**       | ACP                |    ✅     |            ⚠️            |  ⚠️  |
| **Grok**         | Hooks              |     —     |            —             |  —   |
| **Aider**        | PTY / process      |     —     |            —             |  —   |
| **Cursor Agent** | PTY / process      |     —     |            —             |  —   |
| **Amp**          | PTY / process      |     —     |            —             |  —   |

Integration details and limitations are documented in the
[agent integration matrix](docs/agent-integration-matrix.md).

The first five are first-class integrations with structured lifecycle signals where the
tool exposes them. Aider, Cursor Agent, and Amp are supported terminal integrations:
Shepherd launches and supervises the real CLI, but does not claim structured chat,
token, plan, or attention telemetry that the tool does not provide.

The bundled local runtime owns its image-provided tools. Remote nodes detect all eight
without installing anything; Node details offers an explicit **Install latest** or
**Upgrade** action for each tool. You may instead install and pin versions yourself.

## Connect a remote node

Prepare a Linux node with the public half of the SSH key Shepherd will use:

```bash
sudo ./scripts/flock-node-prepare.sh \
  --public-key-file /path/to/flock-control.pub \
  --workspace /srv/flock/workspaces
```

Then add the node in Shepherd. The node page validates SSH access, runtime identities,
workspace permissions, daemon compatibility, metrics, all eight supported agent CLIs,
and Docker. Install only the tools you want from Node details; provider authentication
still happens inside that tool. Docker installation and root-equivalent agent access are
separate, explicitly confirmed actions. The daemon upgrade policy distinguishes
**compatible**, **upgrade recommended**, and **upgrade required** without silently
killing active sessions. See [Node tooling and Docker](docs/node-tooling.md).

## Backups, upgrades, and diagnostics

Shepherd is designed to be operated, not merely started:

- **Settings → Operations** shows database, migration, node, daemon, Preview, push,
  version, deployment-mode, and trusted-proxy state, with a downloadable redacted
  diagnostics bundle.
- Encrypted `.flockvault` backups contain the PostgreSQL system of record and a strict,
  checksummed manifest. Creation and verification are atomic; restore creates a rollback
  vault before cutover.
- `scripts/flock-upgrade.sh` verifies the signed/checksummed deployment bundle, creates
  and verifies a pre-upgrade vault, and replaces only the services that need changing.
  Compatible local runtimes remain pinned so active agents survive control-plane updates.
- Daemon upgrades distinguish compatible, recommended, and required versions and avoid
  pretending an unsafe or session-destructive transition succeeded.

Back up `secrets/flock_master_key` separately—the database cannot recover encrypted node
credentials without it. See [backup and recovery](docs/backup-and-recovery.md) and the
[upgrade procedure](docs/deployment.md#upgrade) before a destructive change.

## How it works

```text
Browser / installed PWA
        │ HTTPS/WSS or explicit private HTTP/WS
        ▼
┌──────────────────────────────┐
│ Shepherd orchestrator       │
│ auth · projects · status    │
│ Git · Ports & Preview      │
└──────────┬───────────────────┘
           │ authenticated agentd protocol
     ┌─────┴──────────────┐
     ▼                    ▼
isolated local runtime remote nodes
flock-agentd           flock-agentd
PTYs · status         PTYs · status
metrics · transcripts metrics · transcripts
```

- **`flock-agentd`** is the small Go daemon on each node. It owns PTYs, keeps sessions
  alive, reports metrics, and observes supported agent lifecycle data.
- **The orchestrator** is the Fastify/Postgres control plane. It owns authentication,
  durable configuration, node connections, status, Git views, and secure preview
  capabilities.
- **`node-runtime`** is the separately pinned bundled local node. It owns local agent
  tools, workspaces, PTYs, bounded commands, and loopback Preview tunnels; replacing the
  orchestrator does not replace it.
- **The web app** is the React PWA. It provides the Paddock, node/project hierarchy,
  Pens, terminals, diffs, activity, settings, and mobile experience.

The orchestrator is not in the PTY ownership path: disconnecting a browser does not
stop an agent.

## Published images

Each release publishes provenance-attested, SBOM-enabled multi-platform images:

- `ghcr.io/billiondollarsolo/shepherd-orchestrator`
- `ghcr.io/billiondollarsolo/shepherd-node-runtime`
- `ghcr.io/billiondollarsolo/shepherd-web`

Production Compose pins control-plane `FLOCK_VERSION` separately from
`FLOCK_NODE_RUNTIME_VERSION`; avoid mutable `latest` tags. Public image names use the
canonical `shepherd-*` product namespace. The database and edge use digest-pinned
official PostgreSQL and Traefik images directly; release CI scans those exact upstream
manifests rather than republishing wrappers.

## Local development

Prerequisites: Node 22+, pnpm 9+, Go 1.25+, and Docker.

```bash
git clone https://github.com/billiondollarsolo/shepherd.git
cd shepherd
pnpm install
cp .env.dev.example .env.dev.local
./run-dev.sh --reset-db
```

Open **http://localhost:5173** and complete fresh administrator setup. Subsequent runs
can use `./run-dev.sh` without `--reset-db`.

Common checks:

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:int
pnpm test:e2e
(cd agentd && go test -race ./...)
```

## Documentation

Start with the [documentation index](docs/README.md):

- [Deployment and production configuration](docs/deployment.md)
- [Architecture](docs/architecture.md)
- [Node daemon design](docs/flock-agentd-design.md)
- [Agent integrations](docs/agent-integration-matrix.md)
- [Backup and recovery](docs/backup-and-recovery.md)
- [Release and GHCR verification](docs/releasing.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Security

Shepherd uses authenticated UI/API/WebSocket surfaces, SSH node transport, an
additional per-node daemon credential, encrypted secret storage, exact Origin
validation, durable login throttling, isolated Remote Preview origins, read-only
container filesystems, and no Docker-socket access in any Shepherd service. TLS modes
use browser-enforced `__Host-` control-plane cookies. Deliberate private HTTP uses a
host-only HttpOnly cookie and keeps the unencrypted-transport warning visible.

Review the [security model](docs/decisions/security-threat-model.md) before exposing an
installation publicly. Report vulnerabilities through
[private vulnerability reporting](SECURITY.md), not public issues.

## Version and compatibility

**Current release: v0.5.3.** Shepherd is actively developed pre-1.0 software. Review
the [changelog](CHANGELOG.md) before upgrading. The application, edge proxy, database
pins, web app, and preferred node daemon are validated together; the UI reports when a
node daemon is compatible, recommended to upgrade, or required to upgrade.

Shepherd was previously named Flock. The repository and public container images now use
the `shepherd` name, while compatibility-sensitive services, commands, environment
variables, storage, and the published Go module path retain their `flock` identifiers.

Shepherd is available under the [MIT License](LICENSE). Bundled font attribution is in
[Third-party notices](THIRD_PARTY_NOTICES.md).

Built by [@mjtechguy](https://x.com/mjtechguy) ·
[@blndollarsolo](https://x.com/blndollarsolo).
