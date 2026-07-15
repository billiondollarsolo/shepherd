#!/usr/bin/env bash
# Bundle-aware, backup-gated, session-safe Shepherd Compose upgrade.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: FLOCK_VAULT_PASSWORD_FILE=/secure/path ./scripts/flock-upgrade.sh VERSION [OPTIONS]

Options:
  --upgrade-runtime                  Move a compatible idle runtime to the target version.
  --force-stop-local-sessions        Permit a runtime/topology change to stop listed sessions.
  --acknowledge-node-policy-change   Continue when target remote-daemon policy is stricter.
  --skip-backup                      Continue without the recommended verified DB vault.
  --skip-attestation-check           Verify checksums but not GitHub artifact attestation.
  --skip-compatibility-check         Skip target remote-daemon policy comparison.

Ordinary upgrades replace only control-plane services and keep a compatible local
runtime pinned. Runtime replacement is separately requested, deferred while sessions
are active, never downgraded, and requires the explicit force option when disruptive.
The first topology-generation-2 upgrade necessarily installs node-runtime and refuses
to continue until legacy local sessions are drained (or explicitly force-stopped).
EOF
}

if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then usage; exit 0; fi
TARGET="${1:-}"; [[ -n "$TARGET" ]] || { usage >&2; exit 2; }; shift
UPGRADE_RUNTIME=0 FORCE_SESSIONS=0 ACK_NODE_POLICY=0 SKIP_BACKUP=0 SKIP_ATTESTATION=0 SKIP_COMPATIBILITY=0
while (($#)); do
  case "$1" in
    --upgrade-runtime) UPGRADE_RUNTIME=1 ;;
    --force-stop-local-sessions) FORCE_SESSIONS=1 ;;
    --acknowledge-node-policy-change) ACK_NODE_POLICY=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --skip-attestation-check) SKIP_ATTESTATION=1 ;;
    --skip-compatibility-check) SKIP_COMPATIBILITY=1 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
[[ "$TARGET" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "VERSION must be semantic, for example 0.5.0." >&2; exit 2;
}
[[ -f .env ]] || { echo "Run from the Shepherd deployment directory containing .env." >&2; exit 1; }
for command in docker curl jq sha256sum tar; do command -v "$command" >/dev/null || { echo "$command is required." >&2; exit 1; }; done
docker compose version >/dev/null

# Compose does not remember `-f` flags across commands. Recover the exact active
# file set from a running container so an upgrade cannot silently drop a TLS or
# private-HTTP override. An explicit shell/.env COMPOSE_FILE always wins.
INFERRED_COMPOSE_FILE=''
configured_compose_file="${COMPOSE_FILE:-$(sed -n 's/^COMPOSE_FILE=//p' .env | tail -n1)}"
if [[ -n "$configured_compose_file" ]]; then
  export COMPOSE_FILE="$configured_compose_file"
else
  compose_container="$(docker compose ps --all -q orchestrator 2>/dev/null | head -n1)"
  if [[ -n "$compose_container" ]]; then
    compose_labels="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$compose_container")"
    if [[ -n "$compose_labels" && "$compose_labels" != '<no value>' ]]; then
      candidate="${compose_labels//,/:}"
      valid=1
      IFS=: read -r -a candidate_files <<<"$candidate"
      for compose_file in "${candidate_files[@]}"; do
        [[ -f "$compose_file" ]] || valid=0
      done
      if ((valid == 1)); then
        INFERRED_COMPOSE_FILE="$candidate"
        export COMPOSE_FILE="$candidate"
        echo "Using active Compose files recovered from the running deployment." >&2
      fi
    fi
  fi
fi
docker compose config --quiet

# Capture the previous edge container before the target definition removes the
# service name. Compose otherwise leaves it as an orphan holding ports 80/443,
# which would prevent Traefik (or an external proxy) from taking ownership.
RETIRED_EDGE_CONTAINER="$(docker compose ps --all -q caddy 2>/dev/null | head -n1 || true)"

# v0.5.2 replaces Caddy's local CA with upstream Traefik. A bundled-TLS
# localhost/IP installation must deliberately select private HTTP or configure a
# real certificate-bearing DNS name; silently starting an unusable edge is worse.
current_compose_json="$(docker compose config --format json)"
current_mode="$(jq -r '.services.orchestrator.environment.FLOCK_DEPLOYMENT_MODE // ""' <<<"$current_compose_json")"
current_domain="$(jq -r '.services.caddy.environment.FLOCK_DOMAIN // .services.traefik.environment.FLOCK_DOMAIN // ""' <<<"$current_compose_json")"
if [[ "$current_mode" == builtin-tls ]] && {
  [[ "$current_domain" == localhost ]] ||
    [[ "$current_domain" =~ ^[0-9]+(\.[0-9]+){3}$ ]] ||
    [[ "$current_domain" == *:* ]]
}; then
  cat >&2 <<'EOF'
This installation uses bundled TLS with localhost or a raw IP. Shepherd 0.5.2 moves to
upstream Traefik, which intentionally does not mint a host-local CA certificate.
Before upgrading, choose one supported edge:
  - a real DNS name with bundled/external TLS, or
  - docker-compose.private-http.yml on a restricted Tailnet/LAN/loopback origin.
Update .env/COMPOSE_FILE and confirm `docker compose config --quiet`, then retry.
EOF
  exit 1
fi

OLD_VERSION="$(sed -n 's/^FLOCK_VERSION=//p' .env | tail -n1)"
[[ -n "$OLD_VERSION" ]] || { echo ".env has no FLOCK_VERSION." >&2; exit 1; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/shepherd-upgrade.XXXXXX")"
MUTATED=0
DB_MIGRATION_STARTED=0
COMPLETED=0
ENV_ROLLBACK=''
DEPLOY_ROLLBACK=''
TARGET_UPGRADE_SCRIPT=''
on_exit() {
  code=$?
  trap - EXIT
  set +e
  if ((code != 0 && MUTATED == 1 && COMPLETED == 0)); then
    if ((DB_MIGRATION_STARTED == 0)); then
      echo "Upgrade failed before database migration; restoring the prior deployment definition and pins." >&2
      [[ -f "$ENV_ROLLBACK" ]] && cp -p "$ENV_ROLLBACK" .env
      if [[ -d "$DEPLOY_ROLLBACK" ]]; then
        find . -maxdepth 1 -type f -name 'docker-compose*.yml' -delete
        cp -a "$DEPLOY_ROLLBACK"/docker-compose*.yml . 2>/dev/null || true
        rm -rf docker
        [[ ! -d "$DEPLOY_ROLLBACK/docker" ]] || cp -a "$DEPLOY_ROLLBACK/docker" .
        mkdir -p scripts
        [[ ! -f "$DEPLOY_ROLLBACK/flock-upgrade.sh" ]] || cp -p "$DEPLOY_ROLLBACK/flock-upgrade.sh" scripts/flock-upgrade.sh
      fi
      if docker compose config --quiet; then
        if docker compose config --services | grep -qx node-runtime; then
          docker compose up -d --no-build node-runtime || true
        fi
        rollback_services=(postgres orchestrator web)
        if docker compose config --services | grep -qx traefik; then
          rollback_services+=(traefik)
        elif docker compose config --services | grep -qx caddy; then
          rollback_services+=(caddy)
        fi
        docker compose up -d --no-build "${rollback_services[@]}" || true
      fi
    else
      echo "Upgrade failed after database migration may have started. Data and rollback metadata were preserved; verify schema compatibility before starting older images." >&2
    fi
  fi
  # Never replace the script while Bash is still reading it. Install the next
  # release's helper from this already-parsed EXIT trap only after success.
  if ((code == 0 && COMPLETED == 1)) && [[ -f "$TARGET_UPGRADE_SCRIPT" ]]; then
    cp -p "$TARGET_UPGRADE_SCRIPT" scripts/flock-upgrade.sh
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap on_exit EXIT

# Fetch and validate the complete deployment definition before touching the installation.
base="${FLOCK_RELEASE_BASE_URL:-https://github.com/billiondollarsolo/shepherd/releases/download/v$TARGET}"
archive="${FLOCK_DEPLOYMENT_BUNDLE:-$WORK/shepherd-deployment-$TARGET.tar.gz}"
if [[ -z "${FLOCK_DEPLOYMENT_BUNDLE:-}" ]]; then
  curl --fail --silent --show-error --location "$base/shepherd-deployment-$TARGET.tar.gz" -o "$archive"
fi
curl --fail --silent --show-error --location "$base/shepherd-deployment-$TARGET.tar.gz.sha256" -o "$WORK/bundle.sha256"
(cd "$(dirname "$archive")" && sed "s#  .*#  $(basename "$archive")#" "$WORK/bundle.sha256" | sha256sum -c -)
if ((SKIP_ATTESTATION == 0)); then
  command -v gh >/dev/null || {
    echo "gh is required to verify the signed deployment bundle; use --skip-attestation-check only after review." >&2; exit 1;
  }
  gh attestation verify "$archive" --repo billiondollarsolo/shepherd >/dev/null
else
  echo "WARNING: deployment attestation verification explicitly skipped." >&2
fi
tar -xzf "$archive" -C "$WORK"
DEPLOY="$WORK/shepherd-$TARGET"
[[ -d "$DEPLOY" ]] || { echo "deployment bundle has an unexpected root." >&2; exit 1; }
TARGET_UPGRADE_SCRIPT="$DEPLOY/scripts/flock-upgrade.sh"
(cd "$DEPLOY" && sha256sum -c SHA256SUMS)
jq -e --arg version "$TARGET" '
  .schemaVersion == 1 and .topologyGeneration == 2 and
  .controlPlaneVersion == $version and .runtime.preferredVersion == $version and
  (.images["shepherd-node-runtime"] | startswith("ghcr.io/billiondollarsolo/shepherd-node-runtime@sha256:"))
' "$DEPLOY/release-manifest.json" >/dev/null
docker compose --env-file .env -f "$DEPLOY/docker-compose.yml" config --quiet

HAS_RUNTIME=0
# A service newly introduced by target files is not an installed runtime until
# its project container actually exists.
if docker compose ps --all --services | grep -qx node-runtime; then HAS_RUNTIME=1; fi
LEGACY=$((1 - HAS_RUNTIME))
CURRENT_RUNTIME_VERSION="$(sed -n 's/^FLOCK_NODE_RUNTIME_VERSION=//p' .env | tail -n1)"
if [[ -z "$CURRENT_RUNTIME_VERSION" && $HAS_RUNTIME -eq 1 ]]; then CURRENT_RUNTIME_VERSION="$OLD_VERSION"; fi
TARGET_MIN_RUNTIME="$(jq -r '.runtime.minimumVersion' "$DEPLOY/release-manifest.json")"

ACTIVE_IDS=()
RUNTIME_FACTS=''
EXPECTED_NODE_ID=''
EXPECTED_CONTROL_DIGEST=''
if ((HAS_RUNTIME == 1)); then
  if RUNTIME_FACTS="$(docker compose exec -T node-runtime flock-agentd inspect --socket /run/flock-agentd/control.sock 2>/dev/null)"; then
    RUNTIME_FACTS="$(jq '.sessions //= []' <<<"$RUNTIME_FACTS")"
    jq -e '.nodeId and .daemonVersion and (.protocolVersion | type == "number") and (.capabilities | type == "array") and (.sessions | type == "array")' <<<"$RUNTIME_FACTS" >/dev/null
  else
    # v0.5.0 inspect could consume a replayed status event before its list
    # response. Preserve a safe upgrade path: authenticate the daemon, read its
    # identity/version from the protected runtime container, and use the current
    # trusted control-plane policy plus the conservative DB session inventory.
    docker compose exec -T node-runtime flock-agentd probe --socket /run/flock-agentd/control.sock
    runtime_version="$(docker compose exec -T node-runtime flock-agentd version | tr -d '\r\n')"
    runtime_node="$(docker compose exec -T node-runtime cat /run/flock-agentd/node-id | tr -d '\r\n')"
    current_policy="$(docker compose exec -T orchestrator cat /app/agentd/COMPATIBILITY.json)"
    runtime_protocol="$(jq -r '.supportedProtocolVersions | max' <<<"$current_policy")"
    runtime_capabilities="$(jq -c '.requiredCapabilities' <<<"$current_policy")"
    db_sessions="$(docker compose exec -T postgres sh -lc \
      'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select id from agent_sessions where closed_at is null order by id"' | \
      jq -Rsc 'split("\n") | map(select(length > 0) | {id: ., kind: "unknown", cwd: "unknown"})')"
    RUNTIME_FACTS="$(jq -n --arg node "$runtime_node" --arg version "$runtime_version" \
      --argjson protocol "$runtime_protocol" --argjson capabilities "$runtime_capabilities" \
      --argjson sessions "$db_sessions" \
      '{nodeId:$node, daemonVersion:$version, protocolVersion:$protocol, capabilities:$capabilities, sessions:$sessions}')"
    echo "Authenticated runtime inspection used the v0.5.0 compatibility fallback." >&2
  fi
  if [[ -n "$RUNTIME_FACTS" ]]; then
    CURRENT_RUNTIME_VERSION="$(jq -r '.daemonVersion' <<<"$RUNTIME_FACTS")"
    [[ "$CURRENT_RUNTIME_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] || {
      echo "The authenticated runtime reported an invalid version." >&2; exit 1;
    }
    EXPECTED_NODE_ID="$(jq -r '.nodeId' <<<"$RUNTIME_FACTS")"
    EXPECTED_CONTROL_DIGEST="$(docker compose exec -T node-runtime cat /run/flock-agentd/control.key | sha256sum | awk '{print $1}')"
    mapfile -t ACTIVE_IDS < <(jq -r '.sessions[]?.id' <<<"$RUNTIME_FACTS")
  else
    echo "Cannot authenticate the local runtime; refusing a blind upgrade." >&2; exit 1
  fi
else
  if ! EXPECTED_NODE_ID="$(docker compose exec -T orchestrator cat /var/lib/flock-agentd/node-id 2>/dev/null | tr -d '\r\n')"; then
    EXPECTED_NODE_ID=''
  fi
  if ! EXPECTED_CONTROL_DIGEST="$(docker compose exec -T orchestrator cat /var/lib/flock-agentd/control.key 2>/dev/null | sha256sum | awk '{print $1}')"; then
    EXPECTED_CONTROL_DIGEST=''
  fi
  [[ -n "$EXPECTED_NODE_ID" && -n "$EXPECTED_CONTROL_DIGEST" ]] || {
    echo "Cannot read the legacy local daemon identity and credential; refusing migration." >&2; exit 1;
  }
  # The legacy daemon has no safe maintenance CLI. The database inventory gives
  # stable session IDs and deliberately treats every non-closed row as active.
  mapfile -t ACTIVE_IDS < <(docker compose exec -T postgres sh -lc \
    'psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select id from agent_sessions where closed_at is null order by id"' 2>/dev/null || true)
fi

version_lt() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$1" && "$1" != "$2" ]]; }
version_gt() { version_lt "$2" "$1"; }
RUNTIME_CHANGE=$LEGACY
RUNTIME_REQUIRED=$LEGACY
if ((HAS_RUNTIME == 1)); then
  if version_lt "$CURRENT_RUNTIME_VERSION" "$TARGET_MIN_RUNTIME"; then RUNTIME_CHANGE=1; RUNTIME_REQUIRED=1; fi
  if ((UPGRADE_RUNTIME == 1)) && version_lt "$CURRENT_RUNTIME_VERSION" "$TARGET"; then RUNTIME_CHANGE=1; fi
  if [[ -n "$RUNTIME_FACTS" ]]; then
    while read -r capability; do
      jq -e --arg value "$capability" '.capabilities | index($value) != null' <<<"$RUNTIME_FACTS" >/dev/null || {
        RUNTIME_CHANGE=1; RUNTIME_REQUIRED=1;
      }
    done < <(jq -r '.runtime.requiredCapabilities[]' "$DEPLOY/release-manifest.json")
  fi
fi
if ((RUNTIME_CHANGE == 1 && ${#ACTIVE_IDS[@]} > 0)); then
  printf 'Local runtime replacement would stop these sessions:\n' >&2
  printf '  %s\n' "${ACTIVE_IDS[@]}" >&2
  if ((FORCE_SESSIONS == 0)); then
    if ((RUNTIME_REQUIRED == 0)); then
      echo "Runtime upgrade deferred: active work is protected. The control plane will still upgrade." >&2
      {
        printf '%s deferred runtime upgrade %s -> %s; protected sessions:' "$STAMP" "$CURRENT_RUNTIME_VERSION" "$TARGET"
        printf ' %s' "${ACTIVE_IDS[@]}"
        printf '\n'
      } >> shepherd-maintenance.log
      RUNTIME_CHANGE=0
    else
      echo "Drain them and retry, or explicitly use --force-stop-local-sessions." >&2
      exit 1
    fi
  fi
fi
if ((RUNTIME_CHANGE == 1 && FORCE_SESSIONS == 1 && ${#ACTIVE_IDS[@]} > 0)); then
  { printf '%s forced runtime maintenance; stopped sessions:' "$STAMP"; printf ' %s' "${ACTIVE_IDS[@]}"; printf '\n'; } >> shepherd-maintenance.log
fi

# Compare remote-daemon support policy before mutating files.
if ((SKIP_COMPATIBILITY == 0)); then
  current_policy="$(docker compose exec -T orchestrator cat /app/agentd/COMPATIBILITY.json)"
  target_policy="$(cat "$DEPLOY/agentd-compatibility.json")"
  changed="$(jq -n --argjson current "$current_policy" --argjson target "$target_policy" '
    ($target.minimumDaemonVersion != $current.minimumDaemonVersion) or
    (($current.supportedProtocolVersions - $target.supportedProtocolVersions) | length > 0) or
    (($target.requiredCapabilities - $current.requiredCapabilities) | length > 0)')"
  if [[ "$changed" == true && $ACK_NODE_POLICY -eq 0 ]]; then
    echo "Target remote-node policy changed; review and rerun with --acknowledge-node-policy-change." >&2; exit 1
  fi
fi

ENV_ROLLBACK=".env.pre-upgrade-$OLD_VERSION-$STAMP"
DEPLOY_ROLLBACK=".shepherd-deployment-pre-upgrade-$OLD_VERSION-$STAMP"
cp -p .env "$ENV_ROLLBACK"
mkdir -p "$DEPLOY_ROLLBACK"
cp -a docker-compose*.yml docker scripts/flock-upgrade.sh "$DEPLOY_ROLLBACK/" 2>/dev/null || true

if ((SKIP_BACKUP == 0)); then
  PASSWORD_FILE="${FLOCK_VAULT_PASSWORD_FILE:-}"
  [[ -f "$PASSWORD_FILE" ]] || { echo "Set FLOCK_VAULT_PASSWORD_FILE or explicitly use --skip-backup." >&2; exit 1; }
  mode="$(stat -c %a "$PASSWORD_FILE")"; [[ "$mode" == 600 || "$mode" == 400 ]] || { echo "Vault password file must be 0600 or 0400." >&2; exit 1; }
  BACKUP="/backups/pre-upgrade-$OLD_VERSION-to-$TARGET-$STAMP.flockvault"
  # A login shell rewrites PATH in Debian and hides the image's pinned
  # PostgreSQL 16 client directory. Preserve the image environment with `sh -c`.
  docker compose exec -T orchestrator sh -c \
    "FLOCK_VAULT_PASSWORD_FD=3 node /app/apps/orchestrator/dist/operations/vault-cli.js create '$BACKUP' 3<&0" < "$PASSWORD_FILE"
  docker compose exec -T orchestrator sh -c \
    "FLOCK_VAULT_PASSWORD_FD=3 node /app/apps/orchestrator/dist/operations/vault-cli.js verify '$BACKUP' 3<&0" < "$PASSWORD_FILE"
else
  BACKUP='skipped by operator'; echo "WARNING: proceeding without a verified database vault." >&2
fi
echo "NOTICE: flock_agent_home is not part of the database vault; verify its operator-managed backup before runtime maintenance." >&2

# Install only validated deployment-owned files. .env, secrets, volumes, and custom
# override files are intentionally untouched.
MUTATED=1
cp -a "$DEPLOY"/docker-compose*.yml .
mkdir -p docker scripts
rm -f docker/Caddyfile docker/Caddyfile.local docker/Caddyfile.private-http \
  docker/caddy-entrypoint.sh docker/Dockerfile.caddy docker/Dockerfile.postgres
cp -a "$DEPLOY/docker/." docker/
for source in "$DEPLOY"/scripts/*; do
  [[ "$(basename "$source")" == flock-upgrade.sh ]] && continue
  cp -a "$source" scripts/
done
cp -a "$DEPLOY/release-manifest.json" .

tmp="$(mktemp .env.upgrade.XXXXXX)"
awk -v control="$TARGET" -v runtime="${CURRENT_RUNTIME_VERSION:-$TARGET}" \
  -v runtime_change="$RUNTIME_CHANGE" -v compose_file="$INFERRED_COMPOSE_FILE" '
  /^FLOCK_VERSION=/ { print "FLOCK_VERSION=" control; control_seen=1; next }
  /^FLOCK_NODE_RUNTIME_VERSION=/ {
    print "FLOCK_NODE_RUNTIME_VERSION=" (runtime_change ? control : runtime); runtime_seen=1; next
  }
  /^COMPOSE_FILE=/ { compose_seen=1 }
  { print }
  END {
    if (!control_seen) print "FLOCK_VERSION=" control
    if (!runtime_seen) print "FLOCK_NODE_RUNTIME_VERSION=" (runtime_change ? control : runtime)
    if (compose_file != "" && !compose_seen) print "COMPOSE_FILE=" compose_file
  }
' .env > "$tmp"
chmod --reference=.env "$tmp"; mv -f "$tmp" .env
docker compose config --quiet

pull=(postgres orchestrator web)
if docker compose config --services | grep -qx traefik; then
  pull+=(traefik)
fi
((RUNTIME_CHANGE == 0)) || pull+=(node-runtime)
docker compose pull "${pull[@]}"
if [[ -n "$RETIRED_EDGE_CONTAINER" ]]; then
  docker rm -f "$RETIRED_EDGE_CONTAINER" >/dev/null
  echo "Retired the previous deployment-owned Caddy edge container." >&2
fi
if ((LEGACY == 1)); then docker compose stop orchestrator; fi
if ((RUNTIME_CHANGE == 1)); then
  docker compose up -d --no-build --wait node-runtime
  docker compose exec -T node-runtime flock-agentd probe --socket /run/flock-agentd/control.sock
fi
DB_MIGRATION_STARTED=1
docker compose up -d --no-build --wait "${pull[@]}"
docker compose exec -T orchestrator node -e \
  "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
if POST_RUNTIME_FACTS="$(docker compose exec -T node-runtime flock-agentd inspect --socket /run/flock-agentd/control.sock 2>/dev/null)"; then
  POST_RUNTIME_FACTS="$(jq '.sessions //= []' <<<"$POST_RUNTIME_FACTS")"
  jq -e --arg node "$EXPECTED_NODE_ID" \
    '.nodeId == $node and .daemonVersion and .protocolVersion and .capabilities' \
    <<<"$POST_RUNTIME_FACTS" >/dev/null
else
  # The authenticated probe plus protected identity check covers v0.5.0's
  # status-replay/inspect race without weakening the post-upgrade gate.
  docker compose exec -T node-runtime flock-agentd probe --socket /run/flock-agentd/control.sock
  POST_NODE_ID="$(docker compose exec -T node-runtime cat /run/flock-agentd/node-id | tr -d '\r\n')"
  [[ "$POST_NODE_ID" == "$EXPECTED_NODE_ID" ]] || {
    echo "Local runtime identity changed unexpectedly." >&2; exit 1;
  }
fi
POST_CONTROL_DIGEST="$(docker compose exec -T node-runtime cat /run/flock-agentd/control.key | sha256sum | awk '{print $1}')"
[[ "$POST_CONTROL_DIGEST" == "$EXPECTED_CONTROL_DIGEST" ]] || {
  echo "Local runtime control credential changed unexpectedly." >&2; exit 1;
}
COMPLETED=1

echo "Shepherd control plane upgraded: $OLD_VERSION -> $TARGET"
if ((RUNTIME_CHANGE == 1)); then echo "Local runtime upgraded to $TARGET."; else echo "Compatible local runtime kept at $CURRENT_RUNTIME_VERSION."; fi
echo "Rollback metadata: $ENV_ROLLBACK and $DEPLOY_ROLLBACK"
echo "Database vault: $BACKUP"
echo "After a database migration, confirm schema compatibility before starting older control-plane images."
