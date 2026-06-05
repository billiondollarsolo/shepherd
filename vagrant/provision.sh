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
# same as the Docker node) and authorizes the `flock` user with the orchestrator
# pubkey passed in as $1 (or $FLOCK_PUBKEY).
# =============================================================================
set -euo pipefail

PUBKEY="${1:-${FLOCK_PUBKEY:-}}"
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y --no-install-recommends \
  openssh-server tmux curl ca-certificates git build-essential locales

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
curl -fsSL https://claude.ai/install.sh | bash -s -- --bin-dir /usr/local/bin \
  || npm install -g @anthropic-ai/claude-code \
  || echo "WARN: claude install skipped"
# opencode via npm (the `opencode-ai` package) — the curl|bash installer drops a
# per-user binary that didn't reliably land on the `flock` user's PATH, so use the
# npm global like codex/gemini (system prefix → on PATH for everyone).
npm install -g opencode-ai || echo "WARN: opencode install skipped"
# xAI Grok Build CLI (official installer, https://x.ai/cli). Best-effort: it
# installs into the invoking user's home, so run it as `flock` to land on their
# PATH (the daemon resolves userland bins via resolveExecutable). Auth is NATIVE
# (browser OAuth / GROK_CODE_XAI_API_KEY) — the operator does it on the node.
id flock >/dev/null 2>&1 || useradd -m -s /bin/bash flock
su - flock -c 'curl -fsSL https://x.ai/cli/install.sh | bash' || echo "WARN: grok install skipped"

# The `flock` user — its home lives on the VM's persistent disk, so an in-session
# `claude login` STAYS logged in across reboots (the whole realism win).
id flock >/dev/null 2>&1 || useradd -m -s /bin/bash flock
install -d -m 700 -o flock -g flock /home/flock/.ssh
if [ -n "$PUBKEY" ]; then
  echo "$PUBKEY" > /home/flock/.ssh/authorized_keys
  chown flock:flock /home/flock/.ssh/authorized_keys
  chmod 600 /home/flock/.ssh/authorized_keys
else
  echo "WARN: no FLOCK_PUBKEY provided — flock user has no authorized_keys" >&2
fi

# Key-only sshd (matches the Docker node).
sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -ri 's/^#?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
systemctl enable ssh >/dev/null 2>&1 || true
systemctl restart ssh 2>/dev/null || service ssh restart || true

echo "[flock-vm] $(hostname) provisioned — agents: $(command -v claude codex opencode 2>/dev/null | tr '\n' ' ')"
