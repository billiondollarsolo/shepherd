#!/bin/sh
# =============================================================================
# Shepherd orchestrator container entrypoint (T10).
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
NODE_ID_FILE="${FLOCK_AGENTD_NODE_ID_FILE:-$AGENTD_STATE_DIR/node-id}"
export FLOCK_AGENTD_NODE_ID_FILE="$NODE_ID_FILE"

# File-backed Compose secrets retain their host ownership and mode; Compose
# cannot apply the uid/gid/mode fields for bind-mounted files. Stage the worker
# capability into an ephemeral control-only path while still root, then pass the
# readable copy to the non-root orchestrator.
if [ -n "${BROWSER_WORKER_TOKEN_FILE:-}" ]; then
  BROWSER_WORKER_TOKEN_FILE="$(
    flock-stage-secret \
      "$BROWSER_WORKER_TOKEN_FILE" \
      /run/flock-control-secrets/browser_worker_token \
      root "$CONTROL_GROUP" 0440 browser_worker_token
  )"
  export BROWSER_WORKER_TOKEN_FILE
fi

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
if [ ! -s "$NODE_ID_FILE" ]; then
  echo "[entrypoint] generating stable local agentd identity"
  node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    fs.writeFileSync(process.argv[1], crypto.randomUUID() + "\n", { mode: 0o640 });
  ' "$NODE_ID_FILE"
fi
chown root:"$CONTROL_GROUP" "$NODE_ID_FILE"
chmod 0640 "$NODE_ID_FILE"

# Claude Code is commercially licensed rather than open source. Ask the official
# installer for the latest release on every container start: the runtime home is
# persistent, so an "install only when missing" check would silently pin an old
# release across Shepherd upgrades. A transient outage never blocks Shepherd; an
# existing binary remains usable and the next restart retries.
CLAUDE_BIN="$RUNTIME_HOME/.local/bin/claude"
if [ "${FLOCK_INSTALL_CLAUDE_CODE:-1}" != "0" ]; then
  echo "[entrypoint] ensuring latest Claude Code for the local node"
  if ! gosu "$RUNTIME_USER" env HOME="$RUNTIME_HOME" sh -lc 'curl -fsSL https://claude.ai/install.sh | bash -s -- latest'; then
    if [ -x "$CLAUDE_BIN" ]; then
      echo "[entrypoint] WARN: Claude Code update failed; keeping the installed version" >&2
    else
      echo "[entrypoint] WARN: Claude Code installation failed; retry on restart or install it manually" >&2
    fi
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

# Supervisor: restart the daemon if it ever exits (pairs with T2's crash-safety).
(
  while true; do
    echo "[entrypoint] starting privilege-separated flock-agentd on $SOCKET (version $(flock-agentd version))"
    env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$AGENTD_STATE_DIR" \
      flock-agentd serve \
        --socket "$SOCKET" \
        --state-dir "$AGENTD_STATE_DIR/state" \
        --secret-file "$CREDENTIAL_FILE" \
        --node-id "$(cat "$NODE_ID_FILE")" \
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
