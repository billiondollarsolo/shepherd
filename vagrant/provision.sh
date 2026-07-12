#!/usr/bin/env bash
# =============================================================================
# Flock — provision a REALISTIC VM node (Vagrant + libvirt/KVM).
#
# Mirrors docker/Dockerfile.node + node-entrypoint.sh, but in a real VM (real
# kernel, systemd, persistent disk). The persistent disk is the whole point:
#   - agent logins (~/.claude, ~/.codex) survive `vagrant halt`/`up` for real;
#   - kernel sandboxing the agents actually use — Codex landlock/seccomp,
#     `--sandbox`/`--full-auto`/yolo — behaves as it would on a customer box
#     (unprivileged Docker containers can silently no-op those).
#
# Installs sshd + tmux + the three agent CLIs ("install all, run none authed",
# same as the Docker node) and authorizes the `flock-control` user with the
# orchestrator pubkey passed in as $1 (or $FLOCK_PUBKEY).
# =============================================================================
set -euo pipefail

PUBKEY="${1:-${FLOCK_PUBKEY:-}}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y --no-install-recommends \
  openssh-server tmux curl ca-certificates git build-essential locales sudo

# Separate the SSH control identity from the account that runs coding agents.
# `flock-control` is trusted infrastructure: Flock uses its passwordless sudo to
# install/upgrade the root-owned daemon service. Agent PTYs are always dropped to
# `flock-agent`, which has no sudo and cannot read the control credential.
id flock-control >/dev/null 2>&1 || useradd -m -s /bin/bash flock-control
id flock-agent >/dev/null 2>&1 || useradd -m -s /bin/bash flock-agent
printf '%s\n' 'flock-control ALL=(root) NOPASSWD: ALL' > /etc/sudoers.d/flock-control
chown root:root /etc/sudoers.d/flock-control
chmod 0440 /etc/sudoers.d/flock-control

# UTF-8 locale (the Docker nodes' POSIX-locale tmux glyph bug — keep VMs clean).
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true

# Node.js 22 (codex is an npm global; claude has an npm fallback).
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Agent CLIs — same install path as docker/Dockerfile.node.
npm install -g @openai/codex || echo "WARN: codex install skipped"
npm install -g @google/gemini-cli || echo "WARN: gemini install skipped"
# Claude Code via the OFFICIAL installer, run as `flock-agent` so it lands
# USER-LOCAL (~/.local/bin, agent-owned) and can self-update. A root/npm-global install (/usr)
# is unwritable by the agent user, so claude's auto-updater fails on every launch
# ("no write permission to npm prefix"). NO npm fallback — keep it user-owned.
su - flock-agent -c 'curl -fsSL https://claude.ai/install.sh | bash' || echo "WARN: claude install skipped"
# opencode via npm (the `opencode-ai` package) — the curl|bash installer drops a
# per-user binary that did not reliably land on the agent user's PATH, so use the
# npm global like codex/gemini (system prefix → on PATH for everyone).
npm install -g opencode-ai || echo "WARN: opencode install skipped"
# xAI Grok Build CLI (official installer, https://x.ai/cli). Best-effort: it
# installs into the invoking user's home, so run it as `flock-agent` to land on their
# PATH (the daemon resolves userland bins via resolveExecutable). Auth is NATIVE
# (browser OAuth / GROK_CODE_XAI_API_KEY) — the operator does it on the node.
su - flock-agent -c 'curl -fsSL https://x.ai/cli/install.sh | bash' || echo "WARN: grok install skipped"

# The agent user's home lives on the VM's persistent disk, so an in-session
# `claude login` STAYS logged in across reboots (the whole realism win).
install -d -m 700 -o flock-control -g flock-control /home/flock-control/.ssh
install -d -m 0750 -o flock-agent -g flock-agent /home/flock-agent/scratch
if [ -n "$PUBKEY" ]; then
  echo "$PUBKEY" > /home/flock-control/.ssh/authorized_keys
  chown flock-control:flock-control /home/flock-control/.ssh/authorized_keys
  chmod 600 /home/flock-control/.ssh/authorized_keys
else
  echo "WARN: no FLOCK_PUBKEY provided — flock-control has no authorized_keys" >&2
fi

# Key-only sshd (matches the Docker node).
sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -ri 's/^#?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
systemctl enable ssh >/dev/null 2>&1 || true
systemctl restart ssh 2>/dev/null || service ssh restart || true

echo "[flock-vm] $(hostname) provisioned — agents: $(command -v claude codex opencode 2>/dev/null | tr '\n' ' ')"
