#!/bin/sh
# Shepherd control-plane entrypoint. Local agents and flock-agentd belong to the
# independent node-runtime service; this process owns only secret staging,
# database configuration/migrations, and the orchestrator server.
set -eu

CONTROL_USER=flock-control
CONTROL_GROUP=flock-control
CONTROL_HOME=/home/flock-control

# Docker file-backed secrets are root-owned. Stage only the setup token needed by
# the non-root control process rather than weakening the host secret permissions.
if [ -n "${FLOCK_SETUP_TOKEN_FILE:-}" ]; then
  FLOCK_SETUP_TOKEN_FILE="$(
    flock-stage-secret \
      "$FLOCK_SETUP_TOKEN_FILE" \
      /run/flock-control-secrets/setup_token \
      root "$CONTROL_GROUP" 0440 setup_token
  )"
  export FLOCK_SETUP_TOKEN_FILE
fi

# Build the internal PostgreSQL URL from the same password file consumed by the
# database image. An explicit DATABASE_URL still takes precedence.
if [ -z "${DATABASE_URL:-}" ] && [ -f "${POSTGRES_PASSWORD_FILE:-}" ]; then
  DB_PASSWORD_ENCODED="$(node -e '
    const fs = require("node:fs");
    process.stdout.write(encodeURIComponent(fs.readFileSync(process.argv[1], "utf8").trim()));
  ' "$POSTGRES_PASSWORD_FILE")"
  export DATABASE_URL="postgres://${POSTGRES_USER:-flock}:$DB_PASSWORD_ENCODED@${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432}/${POSTGRES_DB:-flock}"
fi

# Bridge file-backed application secrets without printing their contents.
for var in FLOCK_MASTER_KEY DATABASE_URL; do
  eval "cur=\${$var:-}"; eval "file=\${${var}_FILE:-}"
  if [ -z "$cur" ] && [ -n "$file" ] && [ -f "$file" ]; then
    eval "export $var=\"\$(cat \"\$file\")\""
  fi
done

gosu "$CONTROL_USER" env HOME="$CONTROL_HOME" pnpm --filter @flock/orchestrator run migrate
exec gosu "$CONTROL_USER" env HOME="$CONTROL_HOME" pnpm --filter @flock/orchestrator run start
