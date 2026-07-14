# Deployment (Docker Compose)

Shepherd ships as a four-service Compose stack for an always-on Linux host. The host
needs Docker Engine with the Compose plugin and persistent storage; Node, Go,
PostgreSQL, Caddy, and the agent tools live in versioned containers. HTTPS is the
default, but the checked-in deployment overrides also support an external TLS proxy or
deliberate private-network HTTP without weakening the default stack.

```text
internet / Tailnet
       │ 80,443 only
       ▼
 shepherd-caddy ───────────────┐
       │                       │ isolated preview hosts
       ├── /api,/ws ──▶ orchestrator ── SSH/socket ──▶ flock-agentd on nodes
       └── / ─────────▶ web          │
                                       └──▶ postgres (internal-only network)
```

No Shepherd service mounts the Docker socket. The orchestrator and web services have no
published host port; PostgreSQL is on a Docker `internal` network. Compose applies
read-only root filesystems, no-new-privileges, PID limits, and bounded tmpfs mounts.
Caddy runs as its dedicated non-root user; web and Caddy health checks verify their
actual listeners/configuration rather than treating a merely running container as ready.

## Choose an edge mode

| Mode                      | Use it for                                                                                                                                | Start command                                                                            | Browser transport |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| **Bundled TLS** (default) | Public DNS, a VPS, localhost, or any installation where Shepherd should manage certificates                                               | `docker compose up -d --wait`                                                            | HTTPS/WSS         |
| **External TLS**          | An existing Caddy, nginx, Traefik, HAProxy, Cloudflare Tunnel, or ingress controller                                                      | `docker compose -f docker-compose.yml -f docker-compose.external-proxy.yml up -d --wait` | HTTPS/WSS         |
| **Private HTTP**          | A trusted LAN or encrypted overlay such as Tailscale when the operator deliberately wants direct IP/hostname access without a certificate | `docker compose -f docker-compose.yml -f docker-compose.private-http.yml up -d --wait`   | HTTP/WS           |

Bundled or external TLS is required for public-Internet exposure. Private HTTP is an
explicitly accepted confidentiality tradeoff, not a shortcut for a public VPS: startup
requires `FLOCK_ALLOW_INSECURE_HTTP=1`, the sign-in and application chrome display a
warning, and the diagnostics bundle records the mode. Exact WebSocket Origin checks,
authentication, authorization, CSP, framing protection, and request limits remain on.

## Published services and images

| Service        | Image                                                       | Role                                                                                                             |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `caddy`        | `ghcr.io/billiondollarsolo/shepherd-caddy:<version>`        | TLS, security headers, main routing, and guarded on-demand preview certificates.                                 |
| `web`          | `ghcr.io/billiondollarsolo/shepherd-web:<version>`          | Static React PWA.                                                                                                |
| `orchestrator` | `ghcr.io/billiondollarsolo/shepherd-orchestrator:<version>` | Auth, nodes, sessions, PTY/WebSocket fan-out, Git, Remote Preview, audit, diagnostics, and bundled local agentd. |
| `postgres`     | `ghcr.io/billiondollarsolo/shepherd-postgres:<version>`     | Durable system of record; never on the PTY/status hot path.                                                      |

Every release builds all four for Linux amd64 and arm64, creates SBOM/provenance
attestations, rejects every new High or Critical finding before promotion, and
forces time-bounded review of upstream-unfixed Debian findings through the expiring
`.trivyignore.yaml` risk register.

The orchestrator image includes the latest Codex and OpenCode available at build time.
At start, it asks Anthropic's official installer for the latest Claude Code in the
persistent local-agent home. Set `FLOCK_INSTALL_CLAUDE_CODE=0` when a custom image or
mounted home owns that version.

## Quick start

```bash
git clone https://github.com/billiondollarsolo/shepherd.git
cd shepherd
cp .env.example .env

mkdir -p secrets backups
openssl rand -base64 32 > secrets/flock_master_key
openssl rand -base64 32 > secrets/postgres_password
openssl rand -base64 48 > secrets/setup_token
chmod 600 secrets/*

docker compose pull
docker compose up -d --wait
docker compose ps
```

Open `https://localhost` for a private/local installation. Caddy uses its internal CA
for localhost, so the browser may require you to trust that CA.

A fresh database has no default credentials. The setup screen requires the exact
out-of-band value in `secrets/setup_token`, then creates the only administrator. The
token cannot log in and becomes inert once an owner exists. Keep the file mounted so
production startup can validate its configuration; rotate it if exposed.

Migrations run idempotently before the orchestrator starts. Do not use
`docker compose down --volumes` unless you intend to destroy the installation.

## Public domain and DNS

Set the exact public control-plane origin and a dedicated preview suffix:

```dotenv
FLOCK_DOMAIN=shepherd.example.com
PUBLIC_BASE_URL=https://shepherd.example.com
FLOCK_ALLOWED_ORIGINS=https://shepherd.example.com
FLOCK_PREVIEW_DOMAIN=preview.shepherd.example.com
```

Create DNS records pointing both names at the VPS:

```text
shepherd.example.com             A/AAAA  <VPS address>
*.preview.shepherd.example.com   A/AAAA  <VPS address>
```

Caddy obtains a normal certificate for the control plane. A dynamic-DNS hostname or an
IP-to-hostname DNS service works too when the chosen name resolves to the host and the
certificate authority can validate it. Preview uses on-demand TLS,
but Caddy's `ask` endpoint permits issuance only for a currently active random preview
hostname. The approval and gateway-health paths remain internal and return 404 through
public preview virtual hosts. Preview is disabled when its suffix is absent. In normal
TLS modes, plaintext Preview is rejected.

At the firewall, expose only `80/tcp` and `443/tcp`. Restrict host SSH to administrative
addresses or a Tailnet. Never publish `8080`, `8081`, `5432`, an agentd port/socket, or
the Docker API. Keep the host and Docker Engine patched; Shepherd's container controls
do not compensate for an untrusted host kernel.

## Private IP, LAN hostname, or Tailnet HTTP

Use the private HTTP override only when network access is already restricted. For a
direct Tailnet IP on port `11010`, set:

```dotenv
PUBLIC_BASE_URL=http://100.64.0.10:11010
FLOCK_ALLOWED_ORIGINS=http://100.64.0.10:11010
HTTP_HOST_PORT=11010
FLOCK_ALLOW_INSECURE_HTTP=1
FLOCK_PREVIEW_DOMAIN=
FLOCK_PREVIEW_BACKEND=port-pool
FLOCK_PREVIEW_PORT_RANGE=12000-12031
FLOCK_PREVIEW_FRAME_SOURCES=
```

Then start the explicit topology:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.private-http.yml \
  up -d --wait
```

The override publishes the selected HTTP control port plus exactly the bounded Preview
range. Every pool port is owned by the Preview gateway and cannot serve the control
plane. Postgres and the remaining application services stay behind Caddy. Session
cookies remain HttpOnly, SameSite=Strict,
host-only opaque identifiers, but they cannot use `Secure` or the browser-enforced
`__Host-` prefix over HTTP. Anyone able to observe or modify that network path can attack
the session; use firewall rules, Tailscale ACLs/grants, or an equivalently trusted LAN.
Browsers also reserve some capabilities for secure contexts, so Web Push, some PWA
installation behavior, and similar HTTPS-only APIs may be unavailable when the page is
opened through a plain IP address.

Direct IP access uses no-DNS port-pool Preview. Shepherd allocates an expiring public
port for each project service, routes it to the exact node loopback target, and rotates
a unique capability-cookie name whenever the slot is reused. Restrict the full range
with host firewall rules and Tailscale ACLs/grants. Apps on different ports share a
browser cookie host, so do not use this mode for mutually untrusted applications.

The main-page CSP must list the exact finite origins before **Open here** is enabled.
Settings → Deployment & Preview generates the `FLOCK_PREVIEW_FRAME_SOURCES` line. Copy it
to `.env` and redeploy. **Open in browser** remains available when the CSP is absent.

For stronger isolation on a private network, provide internal wildcard DNS instead:

```dotenv
PUBLIC_BASE_URL=http://shepherd.home.arpa:11010
FLOCK_ALLOWED_ORIGINS=http://shepherd.home.arpa:11010
FLOCK_PREVIEW_DOMAIN=preview.shepherd.home.arpa
FLOCK_PREVIEW_BACKEND=hostname
FLOCK_PREVIEW_FRAME_SOURCES=http://*.preview.shepherd.home.arpa:11010
```

Both `shepherd.home.arpa` and `*.preview.shepherd.home.arpa` must resolve to the Shepherd
host. Preview then uses isolated HTTP origins on port `11010`; it must stay inside the
same trusted network boundary.

## External TLS proxy

Set the exact public HTTPS origin, then start the external-proxy override:

```dotenv
PUBLIC_BASE_URL=https://shepherd.example.com
FLOCK_ALLOWED_ORIGINS=https://shepherd.example.com
FLOCK_PREVIEW_DOMAIN=preview.shepherd.example.com
FLOCK_TRUST_PROXY=1
```

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.external-proxy.yml \
  up -d --wait
```

The bundled Caddy service is disabled and these upstreams bind to loopback by default:

| Public route                             | Default upstream         |
| ---------------------------------------- | ------------------------ |
| Main origin `/api/*`, `/ws*`, `/health*` | `http://127.0.0.1:18080` |
| Main origin, everything else             | `http://127.0.0.1:18081` |
| Dedicated wildcard Preview suffix        | `http://127.0.0.1:18082` |

The proxy must terminate TLS, preserve the original `Host`, support WebSocket upgrades,
and forward the real client address. Reproduce the security headers in
`docker/Caddyfile`; do not add CORS wildcards. Set `FLOCK_PREVIEW_PUBLIC_PORT` only when
the public Preview URL uses a non-default HTTPS port. If the proxy is itself a container,
it may join the external `shepherd_edge` network and route to `orchestrator:8080`,
`web:80`, and `orchestrator:8081`; otherwise keep the default loopback bindings. Never
bind those upstream ports broadly unless a host firewall limits them to the proxy.

`FLOCK_TRUST_PROXY=1` means exactly one forwarding hop. Set a precise hop count or
trusted proxy address/CIDR for a different topology; a blanket `true` trusts caller-
supplied forwarding headers when the orchestrator is directly reachable.

## TLS and authentication boundary

- Production startup rejects a missing, wildcard, credential-bearing, or mode-mismatched
  `PUBLIC_BASE_URL`/allowed origin. TLS modes require HTTPS; private HTTP requires HTTP
  plus the explicit acknowledgement.
- Bundled Caddy redirects HTTP to HTTPS and emits HSTS, CSP, framing, referrer,
  permissions, opener, and resource-policy headers. The private edge intentionally
  omits HSTS and upgrade directives while retaining the applicable browser controls.
- TLS-mode login cookies are HttpOnly, SameSite=Strict, Secure, host-only, and named
  `__Host-shepherd_session`. Private HTTP uses an explicitly non-Secure host-only cookie
  and therefore must remain on its trusted network.
- All UI/API/WebSocket surfaces are default-deny. The only public data endpoint is the
  per-session hook callback, which requires its own high-entropy bearer capability.
- First-owner setup requires a server-side setup token. Login failures are durably
  throttled in PostgreSQL, so a restart does not clear a lockout.
- Changing the owner password revokes every other web login session.

The unencrypted container-network hops are an implementation boundary, not public
listeners. Public VPS traffic must terminate TLS before it crosses an untrusted path.

## Remote Preview

Remote Preview replaces the old server-side Chrome/screencast runtime. It does not
render a remote browser. It tunnels one explicit loopback TCP port from a session's
node into the user's native browser tab, preserving HTTP, WebSocket, and HMR behavior.

Security properties:

- The user must own an open session and enter a port from 1024–65535.
- Shepherd first proves something is listening on `127.0.0.1:<port>` on that exact node.
- Each preview gets a random hostname, a 256-bit capability, an HttpOnly host-only
  preview cookie, an expiry, and explicit revoke/replace lifecycle.
- The capability begins in a URL fragment (not an HTTP request or referrer), is
  exchanged on the preview origin, and is never stored in PostgreSQL or logs; only its
  SHA-256 digest exists in memory.
- Shepherd login and preview-capability cookies, Authorization, forwarded IP/host
  headers, and Referer are never forwarded across the tunnel. Development applications
  may use their own host-only cookies; reserved Shepherd cookie names are filtered in
  both directions.
- Service workers are denied; request/response bytes, connection count, headers, and
  connect/upstream time are bounded. Active HTTP/WebSocket tunnels close on revoke,
  expiry, session termination, shutdown, or orchestrator restart.
- Cross-Origin-Opener-Policy severs the untrusted preview tab from the Shepherd control
  window, including during capability bootstrap.

Treat preview content as untrusted application code. Its separate origin is the
browser security boundary; never point `FLOCK_PREVIEW_DOMAIN` at the main hostname.

## Secrets and storage

Docker secret files under `./secrets/` are mounted at runtime and never copied into an
image:

- `flock_master_key` encrypts stored SSH/node credentials.
- `postgres_password` authenticates the private database connection.
- `setup_token` authorizes only fresh-install owner creation.

`.env`, `secrets/`, and backup output are gitignored. Use generated values, keep file
mode `0600`, restrict deployment-directory ownership, and back them up separately from
the database. Losing the master key makes encrypted node credentials unrecoverable.

Persistent data lives in named volumes:

- `pgdata` — database
- `flock_agent_home` — bundled local-node tool credentials/workspaces
- `flock_agentd_state` — local daemon identity/control state
- `caddy_data`, `caddy_config` — ACME account, certificates, proxy state

Backups are written to `${FLOCK_BACKUP_DIR:-./backups}`. Follow
[backup-and-recovery.md](backup-and-recovery.md); a database dump without the matching
master key is not a complete recovery artifact.

## Operations and verification

```bash
docker compose config --quiet
docker compose up -d --wait
docker compose ps
docker compose logs --tail=200 orchestrator caddy
curl --fail https://shepherd.example.com/health
```

After first setup, verify sign-in, create a local session, reconnect its terminal,
inspect Git, create a small loopback dev server, open/revoke Remote Preview, and connect
one SSH node. Settings → Operations exposes readiness, daemon compatibility, exact
agent versions, and redacted diagnostics.

To validate the isolation model:

```bash
docker compose config | grep -F /var/run/docker.sock && exit 1 || true
docker compose port postgres 5432 && exit 1 || true
docker compose port orchestrator 8080 && exit 1 || true
```

## Upgrade

Use the backup-gated helper from the deployment checkout:

```bash
install -m 0600 /dev/null /tmp/shepherd-vault-password
$EDITOR /tmp/shepherd-vault-password
FLOCK_VAULT_PASSWORD_FILE=/tmp/shepherd-vault-password \
  ./scripts/flock-upgrade.sh <target-version>
```

The helper verifies the target compatibility policy, creates and verifies an encrypted
pre-upgrade vault, pulls exact versioned images, applies migrations, and checks
readiness. A stricter daemon floor requires explicit acknowledgement. Shepherd does not
pretend a contracted database schema can be rolled back by merely starting an older
image; restore the verified vault according to the recovery guide.

Node daemon activation is conservative: compatible daemons continue, recommended
upgrades may wait, and mandatory upgrades fail closed if Shepherd cannot safely prove
that active sessions are drained. See
[agentd-compatibility-and-upgrade-plan.md](agentd-compatibility-and-upgrade-plan.md).

## Local development variants

- `./run-dev.sh` — native source/hot-reload path.
- `docker-compose.dev.yml` — source-mounted builder and test dependencies.
- `docker-compose.local.yml` — prebuilt local UI on `48080` plus preview on `48081`.
- `docker-compose.nodes.yml` and `vagrant/` — remote-node simulations.

These are development topologies. Public exposure must use bundled TLS or the external
TLS mode above; private HTTP is only for an intentionally restricted network.
