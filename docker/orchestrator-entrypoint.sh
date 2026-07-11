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
# Agentd runs as root/control and drops every session to flock-agent. The
# orchestrator runs as flock-control. The protected credential and socket are
# group-readable only by flock-control; flock-agent receives neither.
# =============================================================================
set -eu

SOCKET="${FLOCK_AGENTD_SOCKET:-/tmp/flock-agentd.sock}"
export FLOCK_AGENTD_SOCKET="$SOCKET"
CONTROL_USER=flock-control
CONTROL_GROUP=flock-control
RUNTIME_USER=flock-agent
RUNTIME_HOME=/home/flock-agent
CONTROL_HOME=/home/flock-control
AGENTD_STATE_DIR=/var/lib/flock-agentd
CREDENTIAL_FILE="${FLOCK_AGENTD_SECRET_FILE:-$AGENTD_STATE_DIR/control.key}"
export FLOCK_AGENTD_SECRET_FILE="$CREDENTIAL_FILE"

install -d -o root -g "$CONTROL_GROUP" -m 0750 "$AGENTD_STATE_DIR" "$(dirname "$SOCKET")"
if [ ! -s "$CREDENTIAL_FILE" ]; then
  echo "[entrypoint] generating protected local agentd credential"
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    fs.writeFileSync(process.argv[1], crypto.randomBytes(32).toString("base64url") + "\n", { mode: 0o640 });
  ' "$CREDENTIAL_FILE"
fi
chown root:"$CONTROL_GROUP" "$CREDENTIAL_FILE"
chmod 0640 "$CREDENTIAL_FILE"

# Give only the control user access to the host Docker socket used by the
# constrained browser lifecycle. The runtime agent user is never added.
if [ -S /var/run/docker.sock ]; then
  DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
  DOCKER_GROUP="$(getent group "$DOCKER_GID" | cut -d: -f1 || true)"
  if [ -z "$DOCKER_GROUP" ]; then
    DOCKER_GROUP=flock-docker-host
    groupadd -g "$DOCKER_GID" "$DOCKER_GROUP"
  fi
  usermod -aG "$DOCKER_GROUP" "$CONTROL_USER"
fi

# Claude Code is commercially licensed rather than open source. Install its
# latest release from Anthropic on first container start instead of
# redistributing the binary inside Flock's public image. A transient installer
# outage must not prevent the orchestrator, terminal, Codex, or OpenCode from
# starting; a later container restart retries automatically.
CLAUDE_BIN="$RUNTIME_HOME/.local/bin/claude"
if [ "${FLOCK_INSTALL_CLAUDE_CODE:-1}" != "0" ] && [ ! -x "$CLAUDE_BIN" ]; then
  echo "[entrypoint] installing latest Claude Code for the local node"
  if ! gosu "$RUNTIME_USER" env HOME="$RUNTIME_HOME" sh -lc 'curl -fsSL https://claude.ai/install.sh | bash -s -- latest'; then
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
for var in FLOCK_MASTER_KEY DATABASE_URL; do
  eval "cur=\${$var:-}"; eval "file=\${${var}_FILE:-}"
  if [ -z "$cur" ] && [ -n "$file" ] && [ -f "$file" ]; then
    eval "export $var=\"\$(cat \"\$file\")\""
  fi
done

# The control client reads the same local key. It remains out of agentd's
# minimal environment and is stripped from every agent child as defense in depth.
export FLOCK_AGENTD_SECRET="$(cat "$CREDENTIAL_FILE")"

# Supervisor: restart the daemon if it ever exits (pairs with T2's crash-safety).
(
  while true; do
    echo "[entrypoint] starting privilege-separated flock-agentd on $SOCKET (version $(flock-agentd version))"
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$AGENTD_STATE_DIR" \
      flock-agentd serve \
        --socket "$SOCKET" \
        --state-dir "$AGENTD_STATE_DIR/state" \
        --secret-file "$CREDENTIAL_FILE" \
        --runtime-user "$RUNTIME_USER" \
        --control-group "$CONTROL_GROUP" || true
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
gosu "$CONTROL_USER" env HOME="$CONTROL_HOME" pnpm --filter @flock/orchestrator run migrate

# Hand off to the orchestrator (foreground). `exec` so signals reach Node.
exec gosu "$CONTROL_USER" env HOME="$CONTROL_HOME" pnpm --filter @flock/orchestrator run start
