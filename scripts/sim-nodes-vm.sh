#!/usr/bin/env bash
# =============================================================================
# Flock — REALISTIC VM node harness (Vagrant + libvirt/KVM).
#
#   ./scripts/sim-nodes-vm.sh up      # gen key, boot VM(s), register in Flock
#   ./scripts/sim-nodes-vm.sh down    # destroy the VM(s)
#   ./scripts/sim-nodes-vm.sh status  # VM status + IPs + Flock's view
#
# The heavier, higher-fidelity sibling of sim-nodes.sh (Docker). Use it to
# validate agent permission/sandbox modes and credential persistence on a real
# kernel + persistent disk. Reuses the SAME SSH key as the Docker nodes
# (secrets/sim_nodes_key).
#
# NETWORKING: the libvirt provider does NOT honor `forwarded_port` to a host
# loopback port (that's a VirtualBox thing) — each VM gets an IP on libvirt's
# default NAT network (192.168.121.0/24), routable from the host. So we discover
# each VM's IP via `virsh domifaddr` and register THAT IP:22 in Flock.
#
# Requires: vagrant + the vagrant-libvirt plugin + libvirt/KVM. We invoke
# vagrant/virsh with sudo (libvirt system instance + the plugin installed as
# root); the alternative is adding your user to the `libvirt` group and dropping
# the sudo. Set FLOCK_ADMIN_USER / FLOCK_ADMIN_PASS to auto-register.
#   FLOCK_VM_NODES (default 1)
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

KEY=./secrets/sim_nodes_key
API="${FLOCK_API:-http://localhost:8080}"
COOKIES=/tmp/flock-sim-vm-cookies.txt
VAGRANT_CWD_ABS="$(pwd)/vagrant"
NODE_COUNT="${FLOCK_VM_NODES:-2}"
VAGRANT="sudo env VAGRANT_CWD=$VAGRANT_CWD_ABS"

log() { printf '\033[1;35m[sim-nodes-vm]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[sim-nodes-vm]\033[0m %s\n' "$*" >&2; }

require_vagrant() {
  command -v vagrant >/dev/null 2>&1 || {
    err "vagrant not found. Install Vagrant + the vagrant-libvirt plugin:"
    err "  (Ubuntu 24.04: vagrant is in HashiCorp's apt repo, not Ubuntu's)"
    err "  sudo apt-get install -y libvirt-daemon-system libvirt-dev qemu-system-x86 ruby-dev build-essential"
    err "  sudo vagrant plugin install vagrant-libvirt"
    exit 1
  }
}

ensure_key() {
  if [ ! -f "$KEY" ]; then
    mkdir -p secrets
    log "Generating SSH keypair ($KEY)…"
    ssh-keygen -t ed25519 -N '' -f "$KEY" -C flock-sim-nodes >/dev/null
    chmod 600 "$KEY"
  fi
}

# The libvirt domain name vagrant-libvirt assigns: <cwd-basename>_<machine>.
domain_for() { echo "vagrant_node-vm-$1"; }

# Discover a VM's NAT IP (empty until the guest has a DHCP lease).
node_ip() {
  sudo virsh -q domifaddr "$(domain_for "$1")" 2>/dev/null \
    | awk 'NR==1{print $4}' | cut -d/ -f1
}

api_login() {
  local user="${FLOCK_ADMIN_USER:-}" pass="${FLOCK_ADMIN_PASS:-}"
  if [ -z "$user" ] || [ -z "$pass" ]; then
    err "Set FLOCK_ADMIN_USER and FLOCK_ADMIN_PASS to register the VM(s)."
    err "(VM is up; skipping registration — register by its IP manually.)"
    return 1
  fi
  rm -f "$COOKIES"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIES" \
    -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$pass\"}")
  [ "$code" = "200" ] || { err "Login failed (HTTP $code)."; return 1; }
  log "Authenticated to Flock as $user."
}

register_nodes() {
  local key_json
  key_json=$(python3 -c 'import json,sys; print(json.dumps(open(sys.argv[1]).read()))' "$KEY")
  for i in $(seq 1 "$NODE_COUNT"); do
    local name="node-vm-$i" ip body code
    ip=$(node_ip "$i")
    if [ -z "$ip" ]; then err "  $name: no IP yet, skipping registration"; continue; fi
    log "Registering $name ($ip:22)…"
    body=$(curl -sS -b "$COOKIES" -X POST "$API/api/nodes" \
      -H 'content-type: application/json' \
      -d "{\"name\":\"$name\",\"kind\":\"ssh\",\"host\":\"$ip\",\"port\":22,\"sshUser\":\"flock-control\",\"sshPrivateKey\":$key_json}")
    code=$(echo "$body" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("ok" if d.get("node") else d.get("error",{}).get("message","?"))' 2>/dev/null || echo "parse-error")
    log "  → $code"
  done
}

cmd_up() {
  require_vagrant
  ensure_key
  log "Booting $NODE_COUNT VM node(s) via libvirt (slow the first time: box + provision)…"
  FLOCK_VM_NODES="$NODE_COUNT" $VAGRANT FLOCK_PUBKEY="$(cat "$KEY.pub")" FLOCK_VM_NODES="$NODE_COUNT" \
    vagrant up --provider=libvirt
  log "Waiting for sshd on each VM…"
  for i in $(seq 1 "$NODE_COUNT"); do
    for _ in $(seq 1 60); do
      local ip; ip=$(node_ip "$i")
      if [ -n "$ip" ] && ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o ConnectTimeout=2 -o BatchMode=yes "flock-control@$ip" 'echo ok' >/dev/null 2>&1; then
        log "  node-vm-$i: SSH ready ($ip)"; break
      fi
      sleep 2
    done
  done
  api_login && register_nodes || true
  log "Done. Watch the cockpit — VM node(s) should flip to 'connected'."
}

cmd_down() {
  require_vagrant
  log "Destroying VM node(s)…"
  $VAGRANT vagrant destroy -f
}

cmd_status() {
  require_vagrant
  $VAGRANT vagrant status
  for i in $(seq 1 "$NODE_COUNT"); do log "node-vm-$i IP: $(node_ip "$i" || echo '(none)')"; done
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
