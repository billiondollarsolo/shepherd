#!/usr/bin/env bash
# Boot a Flock simulated SSH node: install the orchestrator's public key for the
# `flock` user, then run sshd in the foreground. The pubkey arrives via the
# FLOCK_PUBKEY env var (set per-container in docker-compose.nodes.yml).
set -e

ssh-keygen -A  # ensure host keys exist

install -d -m 700 -o flock -g flock /home/flock/.ssh
if [ -n "${FLOCK_PUBKEY:-}" ]; then
  echo "$FLOCK_PUBKEY" > /home/flock/.ssh/authorized_keys
  chown flock:flock /home/flock/.ssh/authorized_keys
  chmod 600 /home/flock/.ssh/authorized_keys
else
  echo "WARN: FLOCK_PUBKEY not set — no authorized_keys installed" >&2
fi

# Quiet, key-only sshd.
sed -ri 's/^#?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -ri 's/^#?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

echo "[flock-node] $(hostname) ready — agents: $(command -v claude codex opencode 2>/dev/null | tr '\n' ' ')"
exec /usr/sbin/sshd -D -e
