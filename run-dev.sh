#!/usr/bin/env bash
# =============================================================================
# Flock — native dev runner with live reload.
#
#   ./run-dev.sh            # start Postgres (Docker) + orchestrator + web, watch
#   ./run-dev.sh --reset-db # also wipe the dev database first (fresh admin)
#
# Everything runs NATIVELY on the host (fast HMR, no container rebuilds); only
# Postgres stays in Docker. The orchestrator runs under `tsx watch` (restarts on
# .ts changes) and the web app under Vite (instant HMR). Vite proxies /api + /ws
# to the orchestrator, so the browser talks to a single origin at :5173.
#
#   Web (open this):  http://localhost:5173
#   API (direct):     http://localhost:8080
#
# Ctrl-C stops the orchestrator + web. Postgres keeps running (start once, reuse).
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE=".env.dev.local"
PG_CONTAINER="flock-dev-postgres-1"
# Load host/port defaults from the env file when present (remote-test ranges, etc.).
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi
API_PORT="${PORT:-8080}"
WEB_PORT="${WEB_PORT:-5173}"

log()  { printf '\033[1;36m[flock]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[flock]\033[0m %s\n' "$*"; }

# --- preflight ---------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  warn "Missing $ENV_FILE. Copy it from the repo or see README. Aborting."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  log "Installing dependencies (first run)…"
  pnpm install --store-dir "$HOME/.pnpm-store"
fi

# --- Postgres (Docker; the only containerized piece) -------------------------
if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  log "Postgres already running ($PG_CONTAINER)."
elif docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  log "Starting existing Postgres container…"
  docker start "$PG_CONTAINER" >/dev/null
else
  log "Creating Postgres (docker compose)…"
  docker compose -f docker-compose.dev.yml up -d postgres
fi

# Wait for Postgres to accept connections.
log "Waiting for Postgres on :5432…"
for _ in $(seq 1 30); do
  if docker exec "$PG_CONTAINER" pg_isready -U flock -d flock >/dev/null 2>&1; then break; fi
  sleep 1
done

# --- optional DB reset -------------------------------------------------------
if [[ "${1:-}" == "--reset-db" ]]; then
  warn "Resetting dev database (all data + users wiped)…"
  docker exec "$PG_CONTAINER" psql -U flock -d flock -c \
    "truncate users, nodes, projects, agent_sessions, sessions_auth, secrets, events, audit_log, push_subscriptions cascade;" >/dev/null
  log "Dev database reset. You'll create a fresh admin on first load."
fi

# --- migrations --------------------------------------------------------------
log "Applying migrations…"
pnpm exec tsx --env-file="$ENV_FILE" apps/orchestrator/src/db/migrate.ts

# --- run orchestrator + web with live reload ---------------------------------
# Per-service logs persist to /tmp so a crash (e.g. a tsx-watch restart that
# throws) is always inspectable — `tail -f` them or read after the fact.
API_LOG="/tmp/flock-api.log"
WEB_LOG="/tmp/flock-web.log"
: > "$API_LOG"; : > "$WEB_LOG"

log "Starting orchestrator (tsx watch) + web (vite HMR)…"
log "→ Open  http://0.0.0.0:${WEB_PORT}   (API on 0.0.0.0:${API_PORT})"
log "  logs: $API_LOG  ·  $WEB_LOG"

# Track children so we can stop them cleanly on Ctrl-C.
pids=()
cleanup() {
  echo
  log "Shutting down (Postgres stays up)…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # tsx watch / vite spawn grandchildren; sweep the process group.
  pkill -P $$ 2>/dev/null || true
  wait 2>/dev/null || true
  log "Stopped."
}
trap cleanup INT TERM EXIT

# flock-agentd — the local node's raw-PTY daemon (the tmux replacement). Built +
# started here like Postgres so the local node uses the SAME agentd transport as
# the SSH nodes (no tmux anywhere). Default unix socket; secret matches the
# orchestrator's FLOCK_AGENTD_SECRET (read from the env file).
AGENTD_SECRET="$(grep -E '^FLOCK_AGENTD_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)"
log "Building + starting flock-agentd (local node)…"
AGENTD_BIN=""
if command -v go >/dev/null 2>&1; then
  # Prefer a modern toolchain if the system go is older than go.mod (1.25).
  if [[ -d "$HOME/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.0.linux-amd64/bin" ]]; then
    export PATH="$HOME/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.0.linux-amd64/bin:$PATH"
  fi
  if (cd agentd && go build -o /tmp/flock-agentd . 2>/tmp/flock-agentd-build.log); then
    AGENTD_BIN=/tmp/flock-agentd
  fi
fi
if [[ -z "$AGENTD_BIN" && -x agentd/dist/flock-agentd-linux-amd64 ]]; then
  warn "go build failed or unavailable; using prebuilt agentd/dist/flock-agentd-linux-amd64"
  AGENTD_BIN=agentd/dist/flock-agentd-linux-amd64
fi
if [[ -n "$AGENTD_BIN" ]]; then
  # Supervise the local daemon: if it ever exits (crash/OOM), restart it so local
  # sessions aren't permanently lost (T2 — the local-node equivalent of the SSH
  # nodes' systemd unit). 1s backoff avoids a tight crash loop.
  ( while true; do
      FLOCK_AGENTD_SECRET="$AGENTD_SECRET" stdbuf -oL -eL "$AGENTD_BIN" serve
      echo "[agentd] exited — restarting in 1s"
      sleep 1
    done ) > >(tee -a /tmp/flock-agentd.log | sed $'s/^/\033[32m[agentd]\033[0m /') 2>&1 &
  pids+=($!)
else
  warn "flock-agentd unavailable (see /tmp/flock-agentd-build.log); local node will have no transport."
fi

# Orchestrator: tsx watch restarts on any .ts change under apps/orchestrator.
# `stdbuf -oL -eL` keeps output line-buffered so it isn't swallowed on a crash;
# tee mirrors it to the log file AND the console with an [api] prefix.
stdbuf -oL -eL pnpm exec tsx watch --env-file="$ENV_FILE" --clear-screen=false \
  apps/orchestrator/src/index.ts > >(tee -a "$API_LOG" | sed $'s/^/\033[34m[api]\033[0m /') 2>&1 &
pids+=($!)

# Web: Vite dev server with HMR (proxies /api + /ws to the orchestrator).
# WEB_PORT / PORT / VITE_API_PROXY flow into vite.config.ts for remote-test binds.
stdbuf -oL -eL env WEB_PORT="$WEB_PORT" PORT="$API_PORT" \
  VITE_API_PROXY="${VITE_API_PROXY:-http://127.0.0.1:${API_PORT}}" \
  pnpm --filter @flock/web dev -- --host 0.0.0.0 --port "$WEB_PORT" \
  > >(tee -a "$WEB_LOG" | sed $'s/^/\033[35m[web]\033[0m /') 2>&1 &
pids+=($!)

wait
