#!/usr/bin/env bash
# Deterministic previous-topology fixture for the node-runtime entrypoint.
# It proves identity/credential copying, home preservation, source retention, and
# restart idempotency against the exact image supplied by release smoke.
set -euo pipefail

IMAGE="${1:-ghcr.io/billiondollarsolo/shepherd-node-runtime:${FLOCK_NODE_RUNTIME_VERSION:-0.5.3}}"
suffix="${GITHUB_RUN_ID:-local}-$$"
name="shepherd-runtime-migration-$suffix"
state="shepherd-runtime-migration-state-$suffix"
control="shepherd-runtime-migration-control-$suffix"
home="shepherd-runtime-migration-home-$suffix"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$state" "$control" "$home" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker image inspect "$IMAGE" >/dev/null
docker volume create "$state" >/dev/null
docker volume create "$control" >/dev/null
docker volume create "$home" >/dev/null

# Model 0.4.x: credential + node ID in state, with the runtime home already in use.
docker run --rm --entrypoint sh \
  -v "$state:/legacy" -v "$home:/runtime-home" "$IMAGE" -c \
  'set -eu
   printf "%s\n" legacy-fixture-control-credential > /legacy/control.key
   printf "%s\n" 11111111-2222-4333-8444-555555555555 > /legacy/node-id
   printf "%s\n" preserve-me > /runtime-home/legacy-home-sentinel'

docker run -d --name "$name" \
  --read-only --security-opt no-new-privileges \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add KILL --cap-add SETGID --cap-add SETUID --pids-limit 2048 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  -e FLOCK_INSTALL_CLAUDE_CODE=0 \
  -v "$state:/var/lib/flock-agentd" \
  -v "$control:/run/flock-agentd" \
  -v "$home:/home/flock-agent" \
  "$IMAGE" >/dev/null

probe() {
  docker exec "$name" flock-agentd probe \
    --socket /run/flock-agentd/control.sock \
    --secret-file /run/flock-agentd/control.key \
    --node-id-file /run/flock-agentd/node-id \
    --timeout 2s >/dev/null 2>&1
}
for _attempt in $(seq 1 30); do probe && break; sleep 1; done
probe

assert_fixture() {
  docker exec "$name" sh -c '
    set -eu
    cmp -s /var/lib/flock-agentd/control.key /run/flock-agentd/control.key
    cmp -s /var/lib/flock-agentd/node-id /run/flock-agentd/node-id
    test "$(cat /home/flock-agent/legacy-home-sentinel)" = preserve-me
    test "$(tr -d "\n" < /run/flock-agentd/node-id)" = 11111111-2222-4333-8444-555555555555
  '
}
assert_fixture
before="$(docker exec "$name" sha256sum \
  /run/flock-agentd/control.key /run/flock-agentd/node-id | sha256sum | awk '{print $1}')"

docker restart "$name" >/dev/null
for _attempt in $(seq 1 30); do probe && break; sleep 1; done
probe
assert_fixture
after="$(docker exec "$name" sha256sum \
  /run/flock-agentd/control.key /run/flock-agentd/node-id | sha256sum | awk '{print $1}')"
[[ "$before" == "$after" ]]

echo 'node-runtime legacy migration fixture passed'
