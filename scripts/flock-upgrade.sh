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
docker compose config --quiet

OLD_VERSION="$(sed -n 's/^FLOCK_VERSION=//p' .env | tail -n1)"
[[ -n "$OLD_VERSION" ]] || { echo ".env has no FLOCK_VERSION." >&2; exit 1; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/shepherd-upgrade.XXXXXX")"
MUTATED=0
DB_MIGRATION_STARTED=0
COMPLETED=0
ENV_ROLLBACK=''
DEPLOY_ROLLBACK=''
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
        docker compose up -d --no-build postgres orchestrator web caddy || true
      fi
    else
      echo "Upgrade failed after database migration may have started. Data and rollback metadata were preserved; verify schema compatibility before starting older images." >&2
    fi
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
(cd "$DEPLOY" && sha256sum -c SHA256SUMS)
jq -e --arg version "$TARGET" '
  .schemaVersion == 1 and .topologyGeneration == 2 and
  .controlPlaneVersion == $version and .runtime.preferredVersion == $version and
  (.images["shepherd-node-runtime"] | startswith("ghcr.io/billiondollarsolo/shepherd-node-runtime@sha256:"))
' "$DEPLOY/release-manifest.json" >/dev/null
docker compose --env-file .env -f "$DEPLOY/docker-compose.yml" config --quiet

HAS_RUNTIME=0
if docker compose config --services | grep -qx node-runtime; then HAS_RUNTIME=1; fi
LEGACY=$((1 - HAS_RUNTIME))
CURRENT_RUNTIME_VERSION="$(sed -n 's/^FLOCK_NODE_RUNTIME_VERSION=//p' .env | tail -n1)"
if [[ -z "$CURRENT_RUNTIME_VERSION" && $HAS_RUNTIME -eq 1 ]]; then CURRENT_RUNTIME_VERSION="$OLD_VERSION"; fi
TARGET_MIN_RUNTIME="$(jq -r '.runtime.minimumVersion' "$DEPLOY/release-manifest.json")"

ACTIVE_IDS=()
RUNTIME_FACTS=''
EXPECTED_NODE_ID=''
EXPECTED_CONTROL_DIGEST=''
if ((HAS_RUNTIME == 1)); then
  if RUNTIME_FACTS="$(docker compose exec -T node-runtime flock-agentd inspect 2>/dev/null)"; then
    jq -e '.nodeId and .daemonVersion and (.protocolVersion | type == "number") and (.capabilities | type == "array") and (.sessions | type == "array")' <<<"$RUNTIME_FACTS" >/dev/null
    CURRENT_RUNTIME_VERSION="$(jq -r '.daemonVersion' <<<"$RUNTIME_FACTS")"
    [[ "$CURRENT_RUNTIME_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] || {
      echo "The authenticated runtime reported an invalid version." >&2; exit 1;
    }
    EXPECTED_NODE_ID="$(jq -r '.nodeId' <<<"$RUNTIME_FACTS")"
    EXPECTED_CONTROL_DIGEST="$(docker compose exec -T node-runtime cat /run/flock-agentd/control.key | sha256sum | awk '{print $1}')"
    mapfile -t ACTIVE_IDS < <(jq -r '.sessions[].id' <<<"$RUNTIME_FACTS")
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
  docker compose exec -T orchestrator sh -lc \
    "FLOCK_VAULT_PASSWORD_FD=3 pnpm --filter @flock/orchestrator vault create '$BACKUP' 3<&0" < "$PASSWORD_FILE"
  docker compose exec -T orchestrator sh -lc \
    "FLOCK_VAULT_PASSWORD_FD=3 pnpm --filter @flock/orchestrator vault verify '$BACKUP' 3<&0" < "$PASSWORD_FILE"
else
  BACKUP='skipped by operator'; echo "WARNING: proceeding without a verified database vault." >&2
fi
echo "NOTICE: flock_agent_home is not part of the database vault; verify its operator-managed backup before runtime maintenance." >&2

# Install only validated deployment-owned files. .env, secrets, volumes, and custom
# override files are intentionally untouched.
MUTATED=1
cp -a "$DEPLOY"/docker-compose*.yml .
mkdir -p docker scripts
cp -a "$DEPLOY/docker/." docker/
cp -a "$DEPLOY/scripts/." scripts/
cp -a "$DEPLOY/release-manifest.json" .

tmp="$(mktemp .env.upgrade.XXXXXX)"
awk -v control="$TARGET" -v runtime="${CURRENT_RUNTIME_VERSION:-$TARGET}" -v runtime_change="$RUNTIME_CHANGE" '
  /^FLOCK_VERSION=/ { print "FLOCK_VERSION=" control; control_seen=1; next }
  /^FLOCK_NODE_RUNTIME_VERSION=/ {
    print "FLOCK_NODE_RUNTIME_VERSION=" (runtime_change ? control : runtime); runtime_seen=1; next
  }
  { print }
  END {
    if (!control_seen) print "FLOCK_VERSION=" control
    if (!runtime_seen) print "FLOCK_NODE_RUNTIME_VERSION=" (runtime_change ? control : runtime)
  }
' .env > "$tmp"
chmod --reference=.env "$tmp"; mv -f "$tmp" .env
docker compose config --quiet

pull=(postgres orchestrator web caddy)
((RUNTIME_CHANGE == 0)) || pull+=(node-runtime)
docker compose pull "${pull[@]}"
if ((LEGACY == 1)); then docker compose stop orchestrator; fi
if ((RUNTIME_CHANGE == 1)); then
  docker compose up -d --no-build --wait node-runtime
  docker compose exec -T node-runtime flock-agentd probe
fi
DB_MIGRATION_STARTED=1
docker compose up -d --no-build --wait postgres orchestrator web caddy
docker compose exec -T orchestrator node -e \
  "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
POST_RUNTIME_FACTS="$(docker compose exec -T node-runtime flock-agentd inspect)"
jq -e --arg node "$EXPECTED_NODE_ID" '.nodeId == $node and .daemonVersion and .protocolVersion and .capabilities' <<<"$POST_RUNTIME_FACTS" >/dev/null
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
