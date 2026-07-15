# Deployment

Shepherd supports four explicit edge topologies. The standard public deployment uses
the official Traefik image, the database uses the official PostgreSQL image, and
Shepherd publishes only its three application images. Neither Traefik nor any Shepherd
service receives the Docker socket.

```text
browser ──▶ traefik ───────▶ shepherd-web
                 ├────────▶ shepherd-orchestrator ──▶ postgres (internal network)
                 └────────▶ Preview gateway :8081
                                      │
                                      └── authenticated SSH/agentd tunnel ──▶ node loopback

shepherd-orchestrator ── authenticated Unix socket ──▶ shepherd-node-runtime
```

Only Traefik publishes `80` and `443` in bundled TLS mode. PostgreSQL is attached to an
internal Docker network. The node runtime has no database or edge-network access.

## Supported modes

| Mode                     | Use it for                                                     | Command                                     | Browser transport |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------- | ----------------- |
| **Bundled TLS**          | Public DNS/VPS; HTTP-01 for the control plane                  | `docker compose up -d --wait`               | HTTPS/WSS         |
| **Bundled TLS + DNS-01** | Public DNS with wildcard Preview through Cloudflare or Route53 | Add one `docker-compose.dns-*.yml` override | HTTPS/WSS         |
| **External TLS**         | Existing Caddy, nginx, Traefik, HAProxy, tunnel, or ingress    | Add `docker-compose.external-proxy.yml`     | HTTPS/WSS         |
| **Private HTTP**         | Restricted LAN or encrypted overlay such as Tailscale          | Add `docker-compose.private-http.yml`       | HTTP/WS           |

Public Internet exposure requires bundled or external TLS. Private HTTP is a deliberate
confidentiality tradeoff and requires `FLOCK_ALLOW_INSECURE_HTTP=1`; authentication,
authorization, exact Origin checks, CSP, request limits, and framing protection remain
enabled.

## Images

Shepherd releases and publishes:

| Service        | Image                                                       | Role                                                                               |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `orchestrator` | `ghcr.io/billiondollarsolo/shepherd-orchestrator:<version>` | Authentication, API, node transport, PTY fan-out, Git, Preview, audit, diagnostics |
| `node-runtime` | `ghcr.io/billiondollarsolo/shepherd-node-runtime:<version>` | Bundled local daemon, agent CLIs, PTYs, workspaces, loopback tunnels               |
| `web`          | `ghcr.io/billiondollarsolo/shepherd-web:<version>`          | Static React PWA                                                                   |

Compose consumes these upstream images directly:

| Service    | Pinning policy                                    | Role                                                       |
| ---------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `traefik`  | Official `traefik:v3.7` multi-arch digest         | TLS, routing, WebSockets, security headers, DNS-01         |
| `postgres` | Official `postgres:16-bookworm` multi-arch digest | Durable system of record; never on the PTY/status hot path |

Release CI scans the exact amd64 and arm64 upstream manifests. It does not rebuild,
wrap, or republish them. Patch/digest changes are reviewed normally. A PostgreSQL major
upgrade is a separate backup-gated migration and must never arrive through a floating
`postgres:latest` tag.

## Prepare an installation

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

A fresh database has no default credentials. The setup screen requires the exact
out-of-band `setup_token`, then creates the sole administrator. The token is not a login
credential and becomes inert once the owner exists.

Never run `docker compose down --volumes` unless the database and runtime state should
be erased.

## Public control plane without Preview

Point a real hostname at the host and set:

```dotenv
FLOCK_DOMAIN=shepherd.example.com
PUBLIC_BASE_URL=https://shepherd.example.com
FLOCK_ALLOWED_ORIGINS=https://shepherd.example.com
FLOCK_PREVIEW_DOMAIN=
FLOCK_PREVIEW_BACKEND=disabled
ACME_EMAIL=admin@example.com
```

```bash
docker compose pull
docker compose up -d --wait
```

Traefik uses HTTP-01 and redirects HTTP to HTTPS. Expose only `80/tcp` and `443/tcp`.
Do not publish `8080`, `8081`, `5432`, the agentd socket, or the Docker API.

## Public control plane with wildcard Preview

Preview needs an isolated wildcard DNS suffix and a wildcard certificate. Create:

```text
shepherd.example.com             A/AAAA  <server address>
*.preview.shepherd.example.com   A/AAAA  <server address>
```

Set:

```dotenv
FLOCK_DOMAIN=shepherd.example.com
PUBLIC_BASE_URL=https://shepherd.example.com
FLOCK_ALLOWED_ORIGINS=https://shepherd.example.com
FLOCK_PREVIEW_DOMAIN=preview.shepherd.example.com
ACME_EMAIL=admin@example.com
```

The DNS override enables hostname Preview and asks Traefik for one DNS-01 wildcard
certificate. It creates only temporary ACME TXT records; it does not create the A/AAAA
records above.

### Cloudflare

Create a zone-scoped token with `Zone:Read` and `DNS:Edit`:

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

Traefik/lego reads `CF_DNS_API_TOKEN_FILE`; the token value is absent from `.env`, the
rendered Compose model, process arguments, and logs.

### Route53

Restrict an IAM principal to hosted-zone discovery plus `_acme-challenge` TXT record
inspection/change. Store it in the AWS shared-credentials format:

```ini
# secrets/route53_credentials
[default]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

Set `AWS_REGION`, then start with `docker-compose.dns-route53.yml` in place of the
Cloudflare override. Traefik/lego reads the mounted file through
`AWS_SHARED_CREDENTIALS_FILE`; its AWS SDK explicitly does not support `_FILE` on the
individual access-key variables. On AWS, prefer an instance/task role and a small
operator override that enables the Route53 DNS resolver without mounting credentials.

Verify without printing secrets:

```bash
docker compose ps
docker compose logs --tail=100 traefik
curl --fail https://shepherd.example.com/health
```

ACME account and certificate state persists in `traefik_acme`. The dashboard and
anonymous telemetry are disabled.

## Private IP, LAN hostname, or Tailnet HTTP

For a direct Tailnet IP on `11010`:

```dotenv
FLOCK_DOMAIN=unused.invalid
PUBLIC_BASE_URL=http://100.64.0.10:11010
FLOCK_ALLOWED_ORIGINS=http://100.64.0.10:11010
HTTP_HOST_PORT=11010
FLOCK_ALLOW_INSECURE_HTTP=1
FLOCK_PREVIEW_BACKEND=port-pool
FLOCK_PREVIEW_PORT_RANGE=12000-12031
FLOCK_PREVIEW_FRAME_SOURCES=
```

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.private-http.yml \
  pull
docker compose \
  -f docker-compose.yml \
  -f docker-compose.private-http.yml \
  up -d --wait
```

The override publishes the selected control port plus exactly the bounded Preview port
range. Restrict both through host firewall rules and Tailnet ACLs/grants. Settings →
Deployment & Preview generates the exact finite `FLOCK_PREVIEW_FRAME_SOURCES` value
required for embedded Preview; **Open in browser** remains available when it is absent.

Private HTTP intentionally omits HSTS, secure-only upgrade directives, and COOP on
non-loopback origins because browsers cannot honor them there. Session cookies remain
HttpOnly, SameSite=Strict, opaque, and host-only, but cannot use `Secure` or the
`__Host-` prefix. Anyone able to observe or modify the network can attack the session.

Private wildcard DNS provides stronger browser-origin isolation than a shared IP port
pool. Set `FLOCK_PREVIEW_BACKEND=hostname`, `FLOCK_PREVIEW_EDGE_ENABLED=1`, a real
`FLOCK_PREVIEW_DOMAIN`, and its exact HTTP frame source. Both the main and wildcard
names must resolve to the Shepherd host.

## External TLS proxy

Set the exact HTTPS origin, then start:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.external-proxy.yml \
  up -d --wait
```

The bundled Traefik service is disabled. Loopback upstreams are:

| Public route                      | Upstream                 |
| --------------------------------- | ------------------------ |
| Main `/api/*`, `/ws*`, `/health*` | `http://127.0.0.1:18080` |
| Main origin, everything else      | `http://127.0.0.1:18081` |
| Wildcard Preview suffix           | `http://127.0.0.1:18082` |

The proxy must preserve `Host`, support WebSocket upgrades, forward the real client
address, terminate TLS, and reproduce the policies in
`docker/traefik/dynamic-tls.yml`. `FLOCK_TRUST_PROXY=1` means exactly one forwarding
hop; configure a precise hop count or trusted address/CIDR for a different topology.

## Security boundary

- TLS modes require exact `https://` public/allowed origins. Private HTTP requires exact
  `http://` origins and its explicit acknowledgement.
- Bundled TLS emits HSTS, CSP, framing, referrer, permissions, opener, and resource
  policies. Private HTTP retains applicable controls and omits misleading TLS-only ones.
- TLS cookies are HttpOnly, SameSite=Strict, Secure, host-only
  `__Host-shepherd_session` identifiers.
- All UI/API/WebSocket surfaces are default-deny. Session hooks require separate
  high-entropy bearer capabilities.
- The Traefik file provider contains only static Shepherd topology. The Docker provider,
  dashboard, admin API, and Docker socket are absent.
- Preview content is untrusted and must use a separate hostname or explicit private
  port-pool origin.

## Persistent state

- `pgdata` — PostgreSQL data
- `flock_agent_home` — bundled runtime credentials and workspaces
- `flock_agentd_state` — daemon state
- `flock_agentd_control` — node ID, control credential, and live Unix socket
- `traefik_acme` — ACME account and certificate state

Backups are written to `${FLOCK_BACKUP_DIR:-./backups}`. Follow
[Backup and recovery](backup-and-recovery.md); a database dump without the matching
master key is incomplete.

## Verification

```bash
docker compose config --quiet
docker compose up -d --wait
docker compose ps
docker compose logs --tail=200 orchestrator traefik
docker compose config | grep -F /var/run/docker.sock && exit 1 || true
docker compose port postgres 5432 && exit 1 || true
docker compose port orchestrator 8080 && exit 1 || true
```

After setup, verify sign-in, a local session/reconnect, Git status, a loopback project
server through Preview, and one SSH node. Settings → Operations exposes readiness,
daemon compatibility, exact agent versions, and redacted diagnostics.

## Upgrade

Use the backup-gated helper:

```bash
FLOCK_VAULT_PASSWORD_FILE=/path/to/0600-password-file \
  ./scripts/flock-upgrade.sh <target-version>
```

The helper verifies the deployment bundle, preserves `.env`, secrets, volumes, and
custom overrides, verifies an encrypted pre-upgrade vault, and checks readiness. A
routine control-plane update keeps compatible runtime sessions alive. PostgreSQL major
upgrades require a separately documented restore/migration path; changing the upstream
tag is not an upgrade plan.
