#!/usr/bin/env bash
# =============================================================================
# Shepherd — provision a REALISTIC VM node (Vagrant + libvirt/KVM).
#
# Mirrors docker/Dockerfile.node + node-entrypoint.sh, but in a real VM (real
# kernel, systemd, persistent disk). The persistent disk is the whole point:
#   - agent logins (~/.claude, ~/.codex) survive `vagrant halt`/`up` for real;
#   - kernel sandboxing the agents actually use — Codex landlock/seccomp,
#     `--sandbox`/`--full-auto`/yolo — behaves as it would on a customer box
#     (unprivileged Docker containers can silently no-op those).
#
# Installs SSH/runtime prerequisites and exercises the same allowlisted all-agent
# preparation path as a remote node. This file is an internal release-validation
# fixture; customers do not need Vagrant.
# =============================================================================
set -euo pipefail

PUBKEY="${1:-${FLOCK_PUBKEY:-}}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y --no-install-recommends \
  openssh-server tmux curl ca-certificates git build-essential locales sudo

# Node.js 22 is required by Codex's official npm distribution. Install it before
# invoking the shared node-preparation path so all supported installers are tested.
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Use the same production preparation path operators run on real nodes. This
# creates the separated identities, constrained root helper, SSH authorization,
# runtime-owned workspace, and all eight supported coding tools without the old
# NOPASSWD:ALL test shortcut.
prepare_args=(--workspace /home/flock-agent/scratch --install-agents)
if [ -n "$PUBKEY" ]; then prepare_args+=(--public-key "$PUBKEY"); fi
bash /tmp/flock-node-prepare.sh "${prepare_args[@]}"

# UTF-8 locale (the Docker nodes' POSIX-locale tmux glyph bug — keep VMs clean).
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true

# The agent user's home lives on the VM's persistent disk, so an in-session
# `claude login` stays logged in across reboots.

# Key-only sshd (matches the Docker node). OpenSSH uses the first value it sees,
# and Ubuntu cloud images put `PasswordAuthentication yes` in an included
# `50-cloud-init.conf` before the main file's setting. Install an earlier drop-in
# so the effective configuration is key-only instead of merely looking that way
# in /etc/ssh/sshd_config.
install -d -m 0755 /etc/ssh/sshd_config.d
install -m 0644 /dev/null /etc/ssh/sshd_config.d/00-flock-key-only.conf
printf '%s\n' \
  'PubkeyAuthentication yes' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'ChallengeResponseAuthentication no' \
  'AuthenticationMethods publickey' \
  > /etc/ssh/sshd_config.d/00-flock-key-only.conf
# Retain explicit main-file values for distributions without Include support.
sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -ri 's/^#?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
/usr/sbin/sshd -t
systemctl enable ssh >/dev/null 2>&1 || true
systemctl restart ssh 2>/dev/null || service ssh restart || true

echo "[flock-vm] $(hostname) provisioned — all supported agent installers verified"
