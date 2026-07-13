#!/usr/bin/env bash
# Prepare a Linux host for secure Shepherd remote-node enrollment.
# Run once as root, then register the host in Shepherd as `flock-control`.
set -euo pipefail

CONTROL_USER="${FLOCK_CONTROL_USER:-flock-control}"
RUNTIME_USER="flock-agent"
WORKSPACE="${FLOCK_WORKSPACE_ROOT:-/srv/flock/workspaces}"
PUBLIC_KEY="${FLOCK_SSH_PUBLIC_KEY:-}"
PUBLIC_KEY_FILE=""
INSTALL_AGENTS="${FLOCK_INSTALL_NODE_AGENTS:-0}"

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/flock-node-prepare.sh [options]

Options:
  --public-key-file PATH  Install this SSH public key for flock-control.
  --public-key KEY        Install the provided SSH public key.
  --workspace PATH        Runtime-owned workspace root (default /srv/flock/workspaces).
  --control-user NAME     SSH/control identity (default flock-control).
  --runtime-user NAME     Coding-agent identity (default flock-agent).
  --install-agents        Install latest Claude Code, Codex, and OpenCode for the runtime user.
  --check                 Validate an existing preparation without changing it.
  -h, --help              Show this help.

The script is idempotent. It creates no human/provider account and never handles
Claude/OpenAI credentials; authenticate coding tools separately as flock-agent.
EOF
}

CHECK_ONLY=0
while (($#)); do
  case "$1" in
    --public-key-file) PUBLIC_KEY_FILE="${2:?missing path}"; shift 2 ;;
    --public-key) PUBLIC_KEY="${2:?missing key}"; shift 2 ;;
    --workspace) WORKSPACE="${2:?missing path}"; shift 2 ;;
    --control-user) CONTROL_USER="${2:?missing name}"; shift 2 ;;
    --runtime-user) RUNTIME_USER="${2:?missing name}"; shift 2 ;;
    --install-agents) INSTALL_AGENTS=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" == 0 ]] || { echo "Run this script as root." >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || { echo "Only Linux nodes are supported." >&2; exit 1; }
[[ "$CONTROL_USER" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || { echo "Invalid control user." >&2; exit 2; }
[[ "$RUNTIME_USER" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || { echo "Invalid runtime user." >&2; exit 2; }
[[ "$WORKSPACE" == /* ]] || { echo "Workspace must be an absolute path." >&2; exit 2; }
[[ ! "$WORKSPACE" =~ [[:space:]] ]] || { echo "Workspace paths containing whitespace are unsupported." >&2; exit 2; }

for command in systemctl useradd groupadd install runuser sha256sum base64 stat visudo getent passwd awk sync mv cp timeout; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done
[[ -d /run/systemd/system ]] || { echo "A systemd-based host is required." >&2; exit 1; }

if [[ -n "$PUBLIC_KEY_FILE" ]]; then
  [[ -f "$PUBLIC_KEY_FILE" ]] || { echo "Public key file does not exist." >&2; exit 2; }
  PUBLIC_KEY="$(<"$PUBLIC_KEY_FILE")"
fi
if [[ -n "$PUBLIC_KEY" && ! "$PUBLIC_KEY" =~ ^(ssh-|ecdsa-|sk-) ]]; then
  echo "The supplied value does not look like an SSH public key." >&2
  exit 2
fi

ADMIN_HELPER=/usr/local/sbin/flock-node-admin
SUDOERS_FILE=/etc/sudoers.d/flock-control

validate() {
  local failed=0
  id "$CONTROL_USER" >/dev/null 2>&1 || { echo "FAIL control user $CONTROL_USER is missing"; failed=1; }
  id "$RUNTIME_USER" >/dev/null 2>&1 || { echo "FAIL runtime user $RUNTIME_USER is missing"; failed=1; }
  [[ -x "$ADMIN_HELPER" ]] || { echo "FAIL $ADMIN_HELPER is missing"; failed=1; }
  [[ -f "$SUDOERS_FILE" ]] || { echo "FAIL $SUDOERS_FILE is missing"; failed=1; }
  [[ -d "$WORKSPACE" ]] || { echo "FAIL workspace $WORKSPACE is missing"; failed=1; }
  if [[ -d "$WORKSPACE" ]]; then
    runuser -u "$RUNTIME_USER" -- test -r "$WORKSPACE" -a -w "$WORKSPACE" -a -x "$WORKSPACE" || {
      echo "FAIL runtime user cannot read/write $WORKSPACE"
      failed=1
    }
  fi
  ((failed == 0)) || return 1
  echo "READY control=$CONTROL_USER runtime=$RUNTIME_USER workspace=$WORKSPACE"
}

if ((CHECK_ONLY)); then
  validate
  exit
fi

if ! id "$CONTROL_USER" >/dev/null 2>&1; then
  getent group "$CONTROL_USER" >/dev/null || groupadd --system "$CONTROL_USER"
  useradd --create-home --gid "$CONTROL_USER" --shell /bin/bash "$CONTROL_USER"
fi
if ! id "$RUNTIME_USER" >/dev/null 2>&1; then
  getent group "$RUNTIME_USER" >/dev/null || groupadd --system "$RUNTIME_USER"
  useradd --system --create-home --gid "$RUNTIME_USER" --shell /bin/bash "$RUNTIME_USER"
fi
passwd -l "$RUNTIME_USER" >/dev/null 2>&1 || true

CONTROL_HOME="$(getent passwd "$CONTROL_USER" | cut -d: -f6)"
RUNTIME_HOME="$(getent passwd "$RUNTIME_USER" | cut -d: -f6)"
CONTROL_GROUP="$(id -gn "$CONTROL_USER")"
RUNTIME_GROUP="$(id -gn "$RUNTIME_USER")"
[[ -n "$CONTROL_HOME" && -n "$RUNTIME_HOME" ]] || { echo "Could not resolve account homes." >&2; exit 1; }

# These are dedicated Shepherd identities. Repair ownership left by prior manual
# root installs so user-local tools can update configuration and credentials.
chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$RUNTIME_HOME"
install -d -o "$RUNTIME_USER" -g "$RUNTIME_GROUP" -m 0755 \
  "$RUNTIME_HOME/.local" "$RUNTIME_HOME/.local/share" "$RUNTIME_HOME/.config" "$RUNTIME_HOME/.cache"

install -d -o "$CONTROL_USER" -g "$CONTROL_GROUP" -m 0700 "$CONTROL_HOME/.ssh"
if [[ -n "$PUBLIC_KEY" ]]; then
  printf '%s\n' "$PUBLIC_KEY" > "$CONTROL_HOME/.ssh/authorized_keys"
  chown "$CONTROL_USER:$CONTROL_GROUP" "$CONTROL_HOME/.ssh/authorized_keys"
  chmod 0600 "$CONTROL_HOME/.ssh/authorized_keys"
fi
install -d -o "$RUNTIME_USER" -g "$RUNTIME_GROUP" -m 0750 "$WORKSPACE"
install -d -o root -g root -m 0700 /etc/flock-agentd
printf '%s\n' "$WORKSPACE" > /etc/flock-agentd/workspace-roots
chown root:root /etc/flock-agentd/workspace-roots
chmod 0644 /etc/flock-agentd/workspace-roots

# This is the only root command the control account may invoke. Every subcommand
# validates its inputs and all uploaded files must be regular files owned by the
# calling control account inside that account's home.
cat > "$ADMIN_HELPER" <<'FLOCK_ADMIN'
#!/usr/bin/env bash
set -euo pipefail

SYSTEM_BIN=/usr/local/lib/flock-agentd/flock-agentd
PREVIOUS_BIN=/usr/local/lib/flock-agentd/flock-agentd.previous
STATE_DIR=/var/lib/flock-agentd
CREDENTIAL_FILE=/etc/flock-agentd/control.key
SERVICE_FILE=/etc/systemd/system/flock-agentd.service
WORKSPACE_ROOTS=/etc/flock-agentd/workspace-roots
RUNTIME_USER="${FLOCK_RUNTIME_USER:-flock-agent}"
CALLER="${SUDO_USER:-}"

die() { echo "flock-node-admin: $*" >&2; exit 1; }
valid_upload() {
  local source="$1" home owner
  [[ -n "$CALLER" ]] || die "must be invoked through sudo"
  home="$(getent passwd "$CALLER" | cut -d: -f6)"
  [[ "$source" == "$home"/* && -f "$source" && ! -L "$source" ]] || die "invalid upload path"
  owner="$(stat -c %U -- "$source")"
  [[ "$owner" == "$CALLER" ]] || die "upload is not owned by the control user"
}
valid_node_id() { [[ "$1" =~ ^[A-Za-z0-9._:-]{8,128}$ ]] || die "invalid node id"; }
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && ((1 <= 10#$1 && 10#$1 <= 65535)) || die "invalid port"; }
runtime_home() { getent passwd "$RUNTIME_USER" | cut -d: -f6; }
runtime_path() {
  local home
  home="$(runtime_home)"
  printf '%s' "$home/.local/bin:$home/.local/share/npm/bin:$home/.npm-global/bin:$home/.opencode/bin:/usr/local/bin:/usr/bin:/bin"
}
activate_previous() {
  [[ -x "$PREVIOUS_BIN" ]] || return 1
  install -o root -g root -m 0755 "$PREVIOUS_BIN" "$SYSTEM_BIN.candidate"
  sync "$SYSTEM_BIN.candidate"
  mv -f "$SYSTEM_BIN.candidate" "$SYSTEM_BIN"
}

case "${1:-}" in
  runtime-exec-supported)
    # Capability probe used by the SSH transport. Keeping this separate from
    # runtime-exec means a legacy/direct-user node can fall back safely without
    # ever running the requested command twice.
    echo "runtime-exec-v1"
    ;;
  runtime-exec)
    # Shepherd connects as the low-privilege control identity for enrollment,
    # but project files and Git state belong to the coding-agent identity. Run
    # data-plane commands as that runtime user so the control account never
    # needs access to the agent home, provider credentials, or workspace files.
    payload="${2:-}"
    [[ -n "$payload" && ${#payload} -le 131072 && "$payload" =~ ^[A-Za-z0-9+/=]+$ ]] ||
      die "invalid runtime command"
    command="$(printf '%s' "$payload" | base64 -d 2>/dev/null)" || die "invalid runtime command"
    [[ -n "$command" ]] || die "invalid runtime command"
    home="$(runtime_home)"
    exec runuser -u "$RUNTIME_USER" -- env -i \
      HOME="$home" USER="$RUNTIME_USER" LOGNAME="$RUNTIME_USER" SHELL=/bin/bash \
      PATH="$(runtime_path)" \
      /bin/sh -c 'umask 0002; exec /bin/sh -c "$1"' flock-runtime "$command"
    ;;
  preflight)
    id "$RUNTIME_USER" >/dev/null
    [[ "$(id -u "$RUNTIME_USER")" != 0 ]]
    home="$(runtime_home)"
    runuser -u "$RUNTIME_USER" -- test -r "$home" -a -w "$home" -a -x "$home"
    [[ -d /run/systemd/system ]]
    if [[ -f "$SERVICE_FILE" ]]; then
      grep -q '^X-Shepherd-Prepared=1$' "$SERVICE_FILE" || die "daemon service needs managed-unit migration"
    fi
    echo "prepared-v1 runtime=$RUNTIME_USER"
    ;;
  install-binary)
    source="${2:-}"; checksum="${3:-}"; manifest="${4:-}"
    valid_upload "$source"
    [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || die "invalid checksum"
    [[ "$(sha256sum "$source" | awk '{print $1}')" == "$checksum" ]] || die "checksum mismatch"
    install -d -o root -g root -m 0755 "$(dirname "$SYSTEM_BIN")"
    install -d -o root -g root -m 0750 "$STATE_DIR" "$STATE_DIR/state"
    if [[ -x "$SYSTEM_BIN" ]]; then
      install -o root -g root -m 0755 "$SYSTEM_BIN" "$PREVIOUS_BIN.candidate"
      mv -f "$PREVIOUS_BIN.candidate" "$PREVIOUS_BIN"
    fi
    install -o root -g root -m 0755 "$source" "$SYSTEM_BIN.candidate"
    sync "$SYSTEM_BIN.candidate"
    mv -f "$SYSTEM_BIN.candidate" "$SYSTEM_BIN"
    printf '%s' "$manifest" | base64 -d > "$STATE_DIR/install.json.candidate"
    chmod 0644 "$STATE_DIR/install.json.candidate"
    mv -f "$STATE_DIR/install.json.candidate" "$STATE_DIR/install.json"
    rm -f "$source"
    ;;
  install-credential)
    source="${2:-}"
    valid_upload "$source"
    install -d -o root -g root -m 0700 /etc/flock-agentd
    install -o root -g root -m 0400 "$source" "$CREDENTIAL_FILE.candidate"
    mv -f "$CREDENTIAL_FILE.candidate" "$CREDENTIAL_FILE"
    rm -f "$source"
    ;;
  install-service)
    node_id="${2:-}"; port="${3:-}"
    valid_node_id "$node_id"; valid_port "$port"
    id "$RUNTIME_USER" >/dev/null || die "runtime user is missing; run flock-node-prepare.sh"
    install -d -o root -g root -m 0750 "$STATE_DIR" "$STATE_DIR/state"
    writable_roots="/var/lib/flock-agentd /tmp /home"
    if [[ -f "$WORKSPACE_ROOTS" ]]; then
      while IFS= read -r root; do
        [[ "$root" == /* && ! "$root" =~ [[:space:]] ]] || die "invalid workspace root"
        writable_roots="$writable_roots $root"
      done < "$WORKSPACE_ROOTS"
    fi
    cat > "$SERVICE_FILE.candidate" <<EOF
[Unit]
Description=Shepherd privilege-separated agent daemon
After=network.target
X-Shepherd-Prepared=1

[Service]
Type=simple
User=root
Group=root
UMask=0002
ExecStart=$SYSTEM_BIN serve --socket '' --addr 127.0.0.1:$port --state-dir $STATE_DIR/state --secret-file $CREDENTIAL_FILE --node-id $node_id --runtime-user $RUNTIME_USER
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateDevices=false
PrivateTmp=false
ProtectClock=true
ProtectControlGroups=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectSystem=strict
ReadWritePaths=$writable_roots
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_KILL CAP_SETGID CAP_SETUID
LimitNOFILE=8192
TasksMax=4096

[Install]
WantedBy=multi-user.target
EOF
    chown root:root "$SERVICE_FILE.candidate"
    chmod 0644 "$SERVICE_FILE.candidate"
    mv -f "$SERVICE_FILE.candidate" "$SERVICE_FILE"
    systemctl daemon-reload
    systemctl enable flock-agentd.service >/dev/null
    ;;
  service-status)
    node_id="${2:-}"; port="${3:-}"
    valid_node_id "$node_id"; valid_port "$port"
    [[ -f "$SERVICE_FILE" ]]
    grep -q '^X-Shepherd-Prepared=1$' "$SERVICE_FILE"
    grep -Fq -- "--addr 127.0.0.1:$port" "$SERVICE_FILE"
    grep -Fq -- "--node-id $node_id" "$SERVICE_FILE"
    grep -Fq -- "--runtime-user $RUNTIME_USER" "$SERVICE_FILE"
    systemctl is-enabled --quiet flock-agentd.service
    echo "managed-service-v1"
    ;;
  restart)
    rollback_mode="${2:-service}"
    case "$rollback_mode" in candidate|service) ;; *) die "invalid restart mode" ;; esac
    if ! systemctl restart flock-agentd.service; then
      if [[ "$rollback_mode" == candidate ]]; then
        activate_previous && systemctl restart flock-agentd.service || true
      fi
      exit 1
    fi
    for _ in {1..20}; do
      systemctl is-active --quiet flock-agentd.service && exit 0
      sleep 0.25
    done
    if [[ "$rollback_mode" == candidate ]]; then
      activate_previous && systemctl restart flock-agentd.service || true
    fi
    exit 1
    ;;
  rollback)
    activate_previous || die "no previous daemon binary"
    systemctl restart flock-agentd.service
    systemctl is-active --quiet flock-agentd.service
    ;;
  check-workspace)
    target="${2:-}"
    [[ "$target" == /* && -d "$target" ]] || die "workspace is missing"
    runuser -u "$RUNTIME_USER" -- test -r "$target" -a -w "$target" -a -x "$target"
    echo "writable"
    ;;
  agent-version)
    agent="${2:-}"
    case "$agent" in claude|codex|opencode|gemini|grok) ;; *) die "unsupported agent name" ;; esac
    home="$(runtime_home)"
    bin="$(runuser -u "$RUNTIME_USER" -- env HOME="$home" PATH="$(runtime_path)" sh -c 'command -v "$1"' sh "$agent")"
    [[ -n "$bin" ]] || die "$agent is not installed"
    set +e
    version="$(timeout 5s runuser -u "$RUNTIME_USER" -- env HOME="$home" PATH="$(runtime_path)" "$bin" --version 2>&1 | head -n 1)"
    status=$?
    set -e
    ((status == 0)) || die "$agent exists at $bin but is not launchable: ${version:-version check failed}"
    [[ -n "$version" ]] || version="version unavailable"
    printf '%s\t%s\n' "$bin" "$version"
    ;;
  *) die "unsupported operation" ;;
esac
FLOCK_ADMIN
sed -i "s/^RUNTIME_USER=.*/RUNTIME_USER=\"$RUNTIME_USER\"/" "$ADMIN_HELPER"
chown root:root "$ADMIN_HELPER"
chmod 0755 "$ADMIN_HELPER"

printf '%s ALL=(root) NOPASSWD: %s\n' "$CONTROL_USER" "$ADMIN_HELPER" > "$SUDOERS_FILE"
chown root:root "$SUDOERS_FILE"
chmod 0440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE" >/dev/null

if [[ "$INSTALL_AGENTS" == 1 ]]; then
  command -v curl >/dev/null || { echo "--install-agents requires curl" >&2; exit 1; }
  echo "Installing latest coding agents as $RUNTIME_USER..."
  runuser -u "$RUNTIME_USER" -- env HOME="$RUNTIME_HOME" sh -lc \
    'curl -fsSL https://claude.ai/install.sh | bash -s -- latest'
  command -v npm >/dev/null || { echo "Codex installation requires Node.js/npm." >&2; exit 1; }
  install -d -o "$RUNTIME_USER" -g "$RUNTIME_GROUP" -m 0755 "$RUNTIME_HOME/.local/share/npm"
  runuser -u "$RUNTIME_USER" -- env HOME="$RUNTIME_HOME" \
    npm install -g --prefix "$RUNTIME_HOME/.local/share/npm" @openai/codex@latest
  runuser -u "$RUNTIME_USER" -- env HOME="$RUNTIME_HOME" sh -lc \
    'curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path'
fi

validate
echo "Register this node with SSH user '$CONTROL_USER'. Authenticate provider CLIs separately as '$RUNTIME_USER'."
