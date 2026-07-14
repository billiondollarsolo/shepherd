#!/usr/bin/env bash
# Backup-gated Docker Compose upgrade for a self-hosted Shepherd installation.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: FLOCK_VAULT_PASSWORD_FILE=/secure/path ./scripts/flock-upgrade.sh VERSION [OPTIONS]

Options:
  --acknowledge-node-policy-change  Continue when the target raises daemon requirements.
  --skip-backup                     Continue without the recommended verified vault.
  --skip-compatibility-check        Continue when release metadata cannot be fetched.

Pulls one immutable Shepherd release, couples all Shepherd images to that version,
runs the stack's normal migrations, and verifies readiness. A verified encrypted
vault is required unless --skip-backup is explicitly supplied.

This command does not claim an automatic database downgrade. If readiness fails,
it preserves the prior .env and backup paths and prints recovery guidance.
EOF
}

if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then usage; exit 0; fi
TARGET="${1:-}"
[[ -n "$TARGET" ]] || { usage >&2; exit 2; }
shift
SKIP_BACKUP=0
SKIP_COMPATIBILITY=0
ACK_NODE_POLICY=0
while (($# > 0)); do
  case "$1" in
    --skip-backup) SKIP_BACKUP=1 ;;
    --skip-compatibility-check) SKIP_COMPATIBILITY=1 ;;
    --acknowledge-node-policy-change) ACK_NODE_POLICY=1 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
[[ "$TARGET" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "VERSION must be semantic, for example 0.4.0." >&2
  exit 2
}
[[ -f .env ]] || { echo "Run from the Shepherd deployment directory containing .env." >&2; exit 1; }
docker compose version >/dev/null
docker compose config --quiet

OLD_VERSION="$(sed -n 's/^FLOCK_VERSION=//p' .env | tail -n 1)"
[[ -n "$OLD_VERSION" ]] || { echo ".env has no FLOCK_VERSION." >&2; exit 1; }
if [[ "$OLD_VERSION" == "$TARGET" ]]; then
  echo "Shepherd is already pinned to $TARGET."
  exit 0
fi

TARGET_COMPATIBILITY="$(mktemp "${TMPDIR:-/tmp}/flock-agentd-compatibility.XXXXXX")"
cleanup() { rm -f "$TARGET_COMPATIBILITY" "${tmp:-}"; }
trap cleanup EXIT
if ((SKIP_COMPATIBILITY == 0)); then
  command -v curl >/dev/null || {
    echo "curl is required for the release compatibility preflight." >&2
    exit 1
  }
  COMPATIBILITY_URL="${FLOCK_COMPATIBILITY_URL:-https://github.com/billiondollarsolo/shepherd/releases/download/v$TARGET/agentd-compatibility.json}"
  echo "Fetching target node compatibility policy..."
  curl --fail --silent --show-error --location "$COMPATIBILITY_URL" > "$TARGET_COMPATIBILITY"
  set +e
  COMPATIBILITY_REPORT="$({ docker compose exec -T orchestrator node -e '
    const fs = require("node:fs");
    const current = JSON.parse(fs.readFileSync("/app/agentd/COMPATIBILITY.json", "utf8"));
    const target = JSON.parse(fs.readFileSync(0, "utf8"));
    const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/;
    const parse = (value) => {
      const match = semver.exec(value || "");
      if (!match) throw new Error(`invalid minimumDaemonVersion: ${value}`);
      return match.slice(1).map(Number);
    };
    const compare = (a, b) => {
      for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
      return 0;
    };
    if (target.schemaVersion !== 1 || !Array.isArray(target.supportedProtocolVersions) ||
        !target.supportedProtocolVersions.includes(target.preferredProtocolVersion) ||
        !Array.isArray(target.requiredCapabilities)) {
      throw new Error("target compatibility manifest is invalid");
    }
    const floorRaised = compare(parse(target.minimumDaemonVersion), parse(current.minimumDaemonVersion)) > 0;
    const removedProtocols = current.supportedProtocolVersions.filter((v) => !target.supportedProtocolVersions.includes(v));
    const addedCapabilities = target.requiredCapabilities.filter((v) => !current.requiredCapabilities.includes(v));
    console.log(`Target node policy: daemon >=${target.minimumDaemonVersion}; protocols ${target.supportedProtocolVersions.join("/")}; required capabilities ${target.requiredCapabilities.join(", ")}.`);
    if (floorRaised || removedProtocols.length || addedCapabilities.length) {
      console.log(`Node policy changed: floor raised=${floorRaised}; removed protocols=${removedProtocols.join(",") || "none"}; new required capabilities=${addedCapabilities.join(",") || "none"}.`);
      process.exit(42);
    }
  ' < "$TARGET_COMPATIBILITY"; } 2>&1)"
  COMPATIBILITY_STATUS=$?
  set -e
  printf '%s\n' "$COMPATIBILITY_REPORT"
  if ((COMPATIBILITY_STATUS == 42 && ACK_NODE_POLICY == 0)); then
    echo "The target can make node daemon upgrades mandatory. Review its release notes and rerun with --acknowledge-node-policy-change." >&2
    exit 1
  fi
  if ((COMPATIBILITY_STATUS != 0 && COMPATIBILITY_STATUS != 42)); then
    echo "Could not validate the target compatibility policy. Use --skip-compatibility-check only after manual review." >&2
    exit 1
  fi
else
  echo "WARNING: target node compatibility was not checked." >&2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ENV_ROLLBACK=".env.pre-upgrade-$OLD_VERSION-$STAMP"
cp -p .env "$ENV_ROLLBACK"

if ((SKIP_BACKUP == 0)); then
  PASSWORD_FILE="${FLOCK_VAULT_PASSWORD_FILE:-}"
  [[ -n "$PASSWORD_FILE" && -f "$PASSWORD_FILE" ]] || {
    echo "Set FLOCK_VAULT_PASSWORD_FILE to a 0600 password file, or explicitly use --skip-backup." >&2
    exit 1
  }
  mode="$(stat -c %a "$PASSWORD_FILE")"
  [[ "$mode" == 600 || "$mode" == 400 ]] || {
    echo "Vault password file must have mode 0600 or 0400." >&2
    exit 1
  }
  BACKUP="/backups/pre-upgrade-$OLD_VERSION-to-$TARGET-$STAMP.flockvault"
  echo "Creating and verifying $BACKUP..."
  docker compose exec -T orchestrator sh -lc \
    "FLOCK_VAULT_PASSWORD_FD=3 pnpm --filter @flock/orchestrator vault create '$BACKUP' 3<&0" \
    < "$PASSWORD_FILE"
  docker compose exec -T orchestrator sh -lc \
    "FLOCK_VAULT_PASSWORD_FD=3 pnpm --filter @flock/orchestrator vault verify '$BACKUP' 3<&0" \
    < "$PASSWORD_FILE"
else
  BACKUP="skipped by operator"
  echo "WARNING: proceeding without the recommended verified vault." >&2
fi

echo "Pulling immutable Shepherd $TARGET images..."
FLOCK_VERSION="$TARGET" docker compose pull

tmp="$(mktemp .env.upgrade.XXXXXX)"
awk -v target="$TARGET" '
  /^FLOCK_VERSION=/ { print "FLOCK_VERSION=" target; version=1; next }
  { print }
  END {
    if (!version) print "FLOCK_VERSION=" target
  }
' .env > "$tmp"
chmod --reference=.env "$tmp"
mv -f "$tmp" .env

echo "Starting Shepherd $TARGET and applying idempotent migrations..."
if ! docker compose up -d --no-build --wait; then
  echo "Upgrade did not become healthy." >&2
  echo "Previous environment: $ENV_ROLLBACK" >&2
  echo "Verified database vault: $BACKUP" >&2
  echo "Do not start an older image against a migrated database until its schema compatibility is confirmed." >&2
  exit 1
fi

docker compose exec -T orchestrator node -e \
  "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

echo "Shepherd upgraded successfully: $OLD_VERSION -> $TARGET"
echo "Rollback metadata retained: $ENV_ROLLBACK"
echo "Verified database vault: $BACKUP"
