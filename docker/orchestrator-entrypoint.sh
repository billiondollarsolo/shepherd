#!/bin/sh
# =============================================================================
# Flock orchestrator container entrypoint (T10).
#
# The orchestrator makes flock-agentd the ONLY transport for the LOCAL node (the
# raw-PTY replacement for tmux). In the single-box Docker deploy the "local node"
# IS this container, so the daemon must run here. This script:
#   1. starts flock-agentd under a supervisor loop (auto-restart on crash — T2),
#      bound to the unix socket the orchestrator reads (FLOCK_AGENTD_SOCKET);
#   2. runs idempotent DB migrations;
#   3. execs the orchestrator in the foreground (PID 1 semantics via the loop).
#
# The daemon + orchestrator share FLOCK_AGENTD_SECRET (optional: the socket is
# already 0600 + loopback-only, but if set both sides use it).
# =============================================================================
set -eu

SOCKET="${FLOCK_AGENTD_SOCKET:-/tmp/flock-agentd.sock}"
export FLOCK_AGENTD_SOCKET="$SOCKET"

# Claude Code is commercially licensed rather than open source. Install its
# latest release from Anthropic on first container start instead of
# redistributing the binary inside Flock's public image. A transient installer
# outage must not prevent the orchestrator, terminal, Codex, or OpenCode from
# starting; a later container restart retries automatically.
CLAUDE_BIN="${HOME:-/home/node}/.local/bin/claude"
if [ "${FLOCK_INSTALL_CLAUDE_CODE:-1}" != "0" ] && [ ! -x "$CLAUDE_BIN" ]; then
  echo "[entrypoint] installing latest Claude Code for the local node"
  if ! curl -fsSL https://claude.ai/install.sh | bash -s -- latest; then
    echo "[entrypoint] WARN: Claude Code installation failed; retry on restart or install it manually" >&2
  fi
fi

# Build the internal Postgres URL from the same password secret consumed by the
# official Postgres image. encodeURIComponent keeps arbitrary generated
# passwords safe inside a URI. An explicit DATABASE_URL still takes precedence.
if [ -z "${DATABASE_URL:-}" ] && [ -f "${POSTGRES_PASSWORD_FILE:-}" ]; then
  DB_PASSWORD_ENCODED="$(node -e '
    const fs = require("node:fs");
    process.stdout.write(encodeURIComponent(fs.readFileSync(process.argv[1], "utf8").trim()));
  ' "$POSTGRES_PASSWORD_FILE")"
  export DATABASE_URL="postgres://${POSTGRES_USER:-flock}:$DB_PASSWORD_ENCODED@${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-flock}"
fi

# Docker-secret bridge: the app reads plain env vars, but compose mounts secrets
# as files and points VAR_FILE at them (e.g. FLOCK_MASTER_KEY_FILE=/run/secrets/...).
# Load each *_FILE into its base VAR so the keyring (boot assertReady) + secret
# store find the value — otherwise the documented prod secret-file posture would
# crash at boot. Only fills a base VAR that isn't already set.
for var in FLOCK_MASTER_KEY FLOCK_AGENTD_SECRET DATABASE_URL; do
  eval "cur=\${$var:-}"; eval "file=\${${var}_FILE:-}"
  if [ -z "$cur" ] && [ -n "$file" ] && [ -f "$file" ]; then
    eval "export $var=\"\$(cat \"\$file\")\""
  fi
done

# Supervisor: restart the daemon if it ever exits (pairs with T2's crash-safety).
(
  while true; do
    echo "[entrypoint] starting flock-agentd on $SOCKET (version $(flock-agentd version))"
    flock-agentd serve --socket "$SOCKET" --secret "${FLOCK_AGENTD_SECRET:-}" || true
    echo "[entrypoint] flock-agentd exited — restarting in 1s"
    sleep 1
  done
) &
AGENTD_SUP_PID=$!

# Forward termination to the supervisor so `docker stop` tears the daemon down too.
trap 'kill "$AGENTD_SUP_PID" 2>/dev/null || true' TERM INT

# Wait briefly for the socket so the first local session doesn't race the daemon.
i=0
while [ ! -S "$SOCKET" ] && [ "$i" -lt 50 ]; do
  i=$((i + 1))
  sleep 0.1
done

# Migrations are idempotent (drizzle journal); safe to run every boot.
pnpm --filter @flock/orchestrator run migrate

# Hand off to the orchestrator (foreground). `exec` so signals reach Node.
exec pnpm --filter @flock/orchestrator run start
