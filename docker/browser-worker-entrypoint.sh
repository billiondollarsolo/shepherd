#!/bin/sh
set -eu

WORKER_USER=flock-browser
SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"

if [ ! -S "$SOCKET" ]; then
  echo "[browser-worker] Docker socket is unavailable: $SOCKET" >&2
  exit 1
fi
if [ ! -s "${BROWSER_WORKER_TOKEN_FILE:-}" ]; then
  echo "[browser-worker] BROWSER_WORKER_TOKEN_FILE is required" >&2
  exit 1
fi

# Only this narrowly scoped worker joins the host socket group. The control
# process and every coding-agent process remain outside it.
DOCKER_GID="$(stat -c '%g' "$SOCKET")"
DOCKER_GROUP="$(getent group "$DOCKER_GID" | cut -d: -f1 || true)"
if [ -z "$DOCKER_GROUP" ]; then
  DOCKER_GROUP=flock-docker-host
  groupadd -g "$DOCKER_GID" "$DOCKER_GROUP"
fi
usermod -aG "$DOCKER_GROUP" "$WORKER_USER"

exec gosu "$WORKER_USER" node /app/apps/orchestrator/dist/browser/worker.js
