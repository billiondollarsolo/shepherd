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
