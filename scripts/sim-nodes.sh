#!/usr/bin/env bash
# =============================================================================
# Flock — simulated multi-node test harness.
#
#   ./scripts/sim-nodes.sh up     # gen key, build image, start 3 nodes, register
#   ./scripts/sim-nodes.sh down   # stop + remove the node containers
#   ./scripts/sim-nodes.sh status # show node containers + Flock's view
#
# Brings up 3 containers (node-alpha/bravo/charlie) running sshd + tmux + the
# agent CLIs, then registers each as an SSH node in the RUNNING Flock orchestrator
# (native, :8080) so you can watch them connect in the cockpit and create real
# agent sessions on them. The orchestrator reaches them on 127.0.0.1:2231-2233.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

KEY=./secrets/sim_nodes_key
API="${FLOCK_API:-http://localhost:8080}"
COOKIES=/tmp/flock-sim-cookies.txt
COMPOSE="docker compose -f docker-compose.nodes.yml"

# host.docker.internal works from a container; from the NATIVE orchestrator the
# nodes are on the host loopback at their published ports.
declare -A NODE_PORTS=( [node-alpha]=2231 [node-bravo]=2232 [node-charlie]=2233 )

log() { printf '\033[1;36m[sim-nodes]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[sim-nodes]\033[0m %s\n' "$*" >&2; }

ensure_key() {
  if [ ! -f "$KEY" ]; then
    mkdir -p secrets
    log "Generating SSH keypair ($KEY)…"
    ssh-keygen -t ed25519 -N '' -f "$KEY" -C flock-sim-nodes >/dev/null
    chmod 600 "$KEY"
  fi
}

# Resolve the host address the orchestrator should dial. Native orchestrator →
# 127.0.0.1. If FLOCK_NODE_HOST is set (e.g. host.docker.internal) use that.
node_host() { echo "${FLOCK_NODE_HOST:-127.0.0.1}"; }

api_login() {
  local user="${FLOCK_ADMIN_USER:-}" pass="${FLOCK_ADMIN_PASS:-}"
  if [ -z "$user" ] || [ -z "$pass" ]; then
    err "Set FLOCK_ADMIN_USER and FLOCK_ADMIN_PASS to your Flock admin creds."
    err "  e.g. FLOCK_ADMIN_USER=you FLOCK_ADMIN_PASS=secret ./scripts/sim-nodes.sh up"
    exit 1
  fi
  rm -f "$COOKIES"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIES" \
    -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$pass\"}")
  [ "$code" = "200" ] || { err "Login failed (HTTP $code)."; exit 1; }
  log "Authenticated to Flock as $user."
}

register_nodes() {
  local pubkey privkey host
  pubkey=$(cat "$KEY.pub")
  privkey=$(cat "$KEY")
  host=$(node_host)
  # Build a JSON-safe private key (escape newlines).
  local key_json
  key_json=$(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "$KEY")

  for name in node-alpha node-bravo node-charlie; do
    local port=${NODE_PORTS[$name]}
    log "Registering $name ($host:$port)…"
    local body code
    body=$(curl -sS -b "$COOKIES" -X POST "$API/api/nodes" \
      -H 'content-type: application/json' \
      -d "{\"name\":\"$name\",\"kind\":\"ssh\",\"host\":\"$host\",\"port\":$port,\"sshUser\":\"flock\",\"sshPrivateKey\":$key_json}")
    code=$(echo "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("ok" if d.get("node") else d.get("error",{}).get("message","?"))' 2>/dev/null || echo "parse-error")
    log "  → $code"
  done
}

cmd_up() {
  ensure_key
  export FLOCK_PUBKEY="$(cat "$KEY.pub")"
  log "Building node image + starting 3 nodes…"
  $COMPOSE up -d --build
  log "Waiting for sshd on each node…"
  for name in node-alpha node-bravo node-charlie; do
    local port=${NODE_PORTS[$name]}
    for _ in $(seq 1 30); do
      if ssh -i "$KEY" -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o ConnectTimeout=2 -o BatchMode=yes flock@127.0.0.1 'echo ok' >/dev/null 2>&1; then
        log "  $name: SSH ready"; break
      fi
      sleep 1
    done
  done
  api_login
  register_nodes
  log "Done. Watch the cockpit — nodes should flip to 'connected'."
}

cmd_down() {
  log "Stopping + removing node containers…"
  $COMPOSE down
}

cmd_status() {
  $COMPOSE ps
  echo
  if [ -f "$COOKIES" ]; then
    log "Flock's view of nodes:"
    curl -sS -b "$COOKIES" "$API/api/nodes" | python3 -m json.tool 2>/dev/null || true
  fi
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) err "usage: $0 {up|down|status}"; exit 1 ;;
esac
