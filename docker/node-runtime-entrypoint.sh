#!/bin/sh
# Shepherd local node runtime. This container, not the orchestrator, owns the
# local daemon and every agent/PTY it launches.
set -eu

CONTROL_GROUP=flock-control
RUNTIME_USER=flock-agent
RUNTIME_HOME=/home/flock-agent
STATE_DIR=/var/lib/flock-agentd
CONTROL_DIR=/run/flock-agentd
SOCKET="${FLOCK_AGENTD_SOCKET:-$CONTROL_DIR/control.sock}"
CREDENTIAL_FILE="${FLOCK_AGENTD_SECRET_FILE:-$CONTROL_DIR/control.key}"
NODE_ID_FILE="${FLOCK_AGENTD_NODE_ID_FILE:-$CONTROL_DIR/node-id}"

export FLOCK_AGENTD_SOCKET="$SOCKET"
export FLOCK_AGENTD_SECRET_FILE="$CREDENTIAL_FILE"
export FLOCK_AGENTD_NODE_ID_FILE="$NODE_ID_FILE"

install -d -o root -g "$CONTROL_GROUP" -m 0750 "$STATE_DIR" "$STATE_DIR/state" "$CONTROL_DIR"
# Keep the capability set minimal: without CAP_FOWNER, `install -o flock-agent`
# cannot chmod a directory after transferring it away from root. Establish the
# mode while root still owns each mount point, then transfer ownership. This is
# safe and idempotent for both fresh and existing named volumes.
mkdir -p "$RUNTIME_HOME" "$RUNTIME_HOME/workspace"
chown root:root "$RUNTIME_HOME" "$RUNTIME_HOME/workspace"
chmod 0750 "$RUNTIME_HOME" "$RUNTIME_HOME/workspace"
chown "$RUNTIME_USER:$RUNTIME_USER" "$RUNTIME_HOME" "$RUNTIME_HOME/workspace"

# One-time topology migration: prior releases stored identity and credential in
# flock_agentd_state. Copy (do not remove) so rollback metadata remains intact.
if [ ! -s "$CREDENTIAL_FILE" ] && [ -s "$STATE_DIR/control.key" ]; then
  echo "[node-runtime] migrating protected daemon credential to the control volume"
  install -o root -g "$CONTROL_GROUP" -m 0640 "$STATE_DIR/control.key" "$CREDENTIAL_FILE"
fi
if [ ! -s "$NODE_ID_FILE" ] && [ -s "$STATE_DIR/node-id" ]; then
  echo "[node-runtime] migrating stable daemon identity to the control volume"
  install -o root -g "$CONTROL_GROUP" -m 0640 "$STATE_DIR/node-id" "$NODE_ID_FILE"
fi

if [ ! -s "$CREDENTIAL_FILE" ]; then
  echo "[node-runtime] generating protected daemon credential"
  umask 0027
  node -e 'const fs=require("node:fs"),c=require("node:crypto");fs.writeFileSync(process.argv[1],c.randomBytes(32).toString("base64url")+"\n",{mode:0o640})' "$CREDENTIAL_FILE"
fi
if [ ! -s "$NODE_ID_FILE" ]; then
  echo "[node-runtime] generating stable daemon identity"
  umask 0027
  node -e 'const fs=require("node:fs"),c=require("node:crypto");fs.writeFileSync(process.argv[1],c.randomUUID()+"\n",{mode:0o640})' "$NODE_ID_FILE"
fi
chown root:"$CONTROL_GROUP" "$CREDENTIAL_FILE" "$NODE_ID_FILE"
chmod 0640 "$CREDENTIAL_FILE" "$NODE_ID_FILE"
rm -f "$SOCKET"

# Claude Code is commercially distributed. Keep the existing best-effort
# latest-at-runtime policy without making daemon availability depend on the
# installer network.
CLAUDE_BIN="$RUNTIME_HOME/.local/bin/claude"
CLAUDE_POLICY="${FLOCK_AGENTD_CLAUDE_POLICY:-best-effort-latest}"
if [ "${FLOCK_INSTALL_CLAUDE_CODE:-1}" != "0" ] && [ "$CLAUDE_POLICY" != disabled ]; then
  echo "[node-runtime] ensuring latest Claude Code"
  backup=''
  if [ -x "$CLAUDE_BIN" ]; then
    backup="$(mktemp /tmp/claude-backup.XXXXXX)"
    cp -p "$CLAUDE_BIN" "$backup"
  fi
  # $script expands in the deliberately isolated inner shell.
  # shellcheck disable=SC2016
  if ! timeout 120 gosu "$RUNTIME_USER" env HOME="$RUNTIME_HOME" sh -lc \
    'set -eu; script=$(mktemp); trap '\''rm -f "$script"'\'' EXIT; curl --fail --silent --show-error --location --connect-timeout 10 --max-time 45 -o "$script" https://claude.ai/install.sh; bash "$script" latest'; then
    if [ -n "$backup" ]; then
      install -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0755 "$backup" "$CLAUDE_BIN"
    fi
    if [ -x "$CLAUDE_BIN" ]; then
      echo "[node-runtime] WARN: Claude Code update failed; keeping the installed version" >&2
    else
      echo "[node-runtime] WARN: Claude Code installation failed; retry on runtime restart" >&2
    fi
  fi
  [ -z "$backup" ] || rm -f "$backup"
fi

echo "[node-runtime] starting flock-agentd $(flock-agentd version) on $SOCKET"
exec env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  HOME="$STATE_DIR" \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  flock-agentd serve \
    --socket "$SOCKET" \
    --state-dir "$STATE_DIR/state" \
    --secret-file "$CREDENTIAL_FILE" \
    --node-id "$(cat "$NODE_ID_FILE")" \
    --runtime-user "$RUNTIME_USER" \
    --control-group "$CONTROL_GROUP"
