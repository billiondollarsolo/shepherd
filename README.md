<div align="center">

<img src="apps/web/public/icons/icon.svg" alt="Shepherd" width="96" height="96" />

# Shepherd

### Shepherd Your Agents

**Run, organize, and supervise coding agents across all your machines from one browser.**

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) ·
[Codex](https://openai.com/codex/) ·
[OpenCode](https://opencode.ai/) ·
[Gemini](https://geminicli.com/) ·
[Grok](https://x.ai/cli)

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

## Why Shepherd?

| Feature                          | What it gives you                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Durable agent sessions**       | Agents run on their node, not in the browser. Reload, close your laptop, or lose Wi-Fi without terminating their work.     |
| **Nodes → Projects → Agents**    | See local and remote machines, the projects on each one, and every active agent through one clear hierarchy.               |
| **Multi-agent Pens**             | Arrange one to four agents in each Pen, drag agents between Pens, choose a layout, or focus one agent full-screen.         |
| **Live status and attention**    | See **Idle**, **Working**, **Needs you**, **Done**, **Error**, and connectivity state without opening every terminal.      |
| **Real terminals everywhere**    | Drive the actual PTY from desktop or mobile, with reconnect, scrollback, keyboard controls, and responsive layouts.        |
| **Git visibility without churn** | Inspect project status, diffs, and agent activity while leaving branch and worktree strategy to you and your agents.       |
| **A browser per session**        | Let an agent use an isolated Chrome session, watch it work, and take over when needed.                                     |
| **Self-hosted and observable**   | Keep control of your machines and data, with node metrics, audit history, diagnostics, backups, and explicit health state. |

## Quick start

You need [Docker Engine](https://docs.docker.com/engine/install/) with the Compose
plugin, Git, and OpenSSL. Shepherd's application images are published on GHCR for
Linux `amd64` and `arm64`.

```bash
git clone https://github.com/billiondollarsolo/shepherd.git
cd shepherd

cp .env.example .env
mkdir -p secrets backups
openssl rand -base64 32 > secrets/flock_master_key
openssl rand -base64 32 > secrets/postgres_password
openssl rand -base64 48 > secrets/browser_worker_token
chmod 600 secrets/*

docker compose pull
docker pull ghcr.io/billiondollarsolo/flock-session-chrome:0.3.0
docker compose up -d --wait
```

Open **https://localhost**. Caddy uses a local certificate for localhost, so your
browser may ask you to trust it. A completely fresh installation shows **Set up
Shepherd**: there is no default username or password. The first person completing
setup creates the sole administrator account.

For a real domain, set these values in `.env` before starting the stack:

```dotenv
PUBLIC_BASE_URL=https://shepherd.example.com
FLOCK_ALLOWED_ORIGINS=https://shepherd.example.com
FLOCK_DOMAIN=shepherd.example.com
ACME_EMAIL=you@example.com
```

Useful operations:

```bash
docker compose ps
docker compose logs -f orchestrator
docker compose down                 # stop services but keep persistent volumes
docker compose down --volumes       # destructive: remove installation data
```

See the complete [deployment guide](docs/deployment.md) for TLS, backups, upgrades,
remote nodes, and production hardening.

## Your first Paddock

1. Complete the first-run administrator setup.
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

| Agent           | Status source      | Attention | Tokens / model / context | Plan |
| --------------- | ------------------ | :-------: | :----------------------: | :--: |
| **Claude Code** | Hooks + transcript |    ✅     |            ✅            |  ✅  |
| **Codex**       | Transcript         |    ⚠️     |            ✅            |  ✅  |
| **OpenCode**    | Plugin             |    ✅     |            ✅            |  ✅  |
| **Gemini**      | ACP                |    ✅     |            ⚠️            |  ⚠️  |
| **Grok**        | Hooks              |     —     |            —             |  —   |

Integration details and limitations are documented in the
[agent integration matrix](docs/agent-integration-matrix.md).

## Connect a remote node

Prepare a Linux node with the public half of the SSH key Shepherd will use:

```bash
sudo ./scripts/flock-node-prepare.sh \
  --public-key-file /path/to/flock-control.pub \
  --workspace /srv/flock/workspaces \
  --install-agents
```

Then add the node in Shepherd. The node page validates SSH access, runtime identities,
workspace permissions, daemon compatibility, metrics, and available agent CLIs before
you launch work. The daemon upgrade policy distinguishes **compatible**, **upgrade
recommended**, and **upgrade required** without silently killing active sessions.

## How it works

```text
Browser / installed PWA
        │ HTTPS + WebSocket
        ▼
┌──────────────────────────────┐
│ Shepherd orchestrator       │
│ auth · projects · status    │
│ Git · browser control       │
└──────────┬───────────────────┘
           │ authenticated agentd protocol
     ┌─────┴──────────────┐
     ▼                    ▼
local node            remote nodes
flock-agentd          flock-agentd
PTYs · status         PTYs · status
metrics · transcripts metrics · transcripts
```

- **`flock-agentd`** is the small Go daemon on each node. It owns PTYs, keeps sessions
  alive, reports metrics, and observes supported agent lifecycle data.
- **The orchestrator** is the Fastify/Postgres control plane. It owns authentication,
  durable configuration, node connections, status, Git views, and browser lifecycle.
- **The web app** is the React PWA. It provides the Paddock, node/project hierarchy,
  Pens, terminals, diffs, activity, settings, and mobile experience.

The orchestrator is not in the PTY ownership path: disconnecting a browser does not
stop an agent.

## Published images

Each release publishes provenance-attested, SBOM-enabled multi-platform images:

- `ghcr.io/billiondollarsolo/flock-orchestrator`
- `ghcr.io/billiondollarsolo/flock-web`
- `ghcr.io/billiondollarsolo/flock-session-chrome`

Production Compose pins `FLOCK_VERSION`; avoid mutable `latest` tags. Image names keep
the `flock-*` prefix for deployment compatibility during the Shepherd name transition.

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
additional per-node daemon credential, encrypted secret storage, origin validation,
login throttling, and a constrained browser worker that isolates Docker-socket access
from the orchestrator and coding agents.

Review the [security model](docs/decisions/security-threat-model.md) before exposing an
installation publicly. Report vulnerabilities through
[private vulnerability reporting](SECURITY.md), not public issues.

## Version and compatibility

**Current release: v0.3.0.** Shepherd is actively developed pre-1.0 software. Review
the [changelog](CHANGELOG.md) before upgrading. The application, browser worker, web
app, and preferred node daemon are released together; the UI reports when a node daemon
is compatible, recommended to upgrade, or required to upgrade.

Shepherd was previously named Flock. The repository is now `shepherd`, while existing
technical identifiers—including `flock-*` images, services, commands, environment
variables, storage, and the published Go module path—remain stable for compatibility.

Shepherd is available under the [MIT License](LICENSE). Bundled font attribution is in
[Third-party notices](THIRD_PARTY_NOTICES.md).

Built by [@mjtechguy](https://x.com/mjtechguy) ·
[@blndollarsolo](https://x.com/blndollarsolo).
