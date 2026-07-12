#!/usr/bin/env bash
# Backup-gated Docker Compose upgrade for a self-hosted Flock installation.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: FLOCK_VAULT_PASSWORD_FILE=/secure/path ./scripts/flock-upgrade.sh VERSION [--skip-backup]

Pulls one immutable Flock release, couples all Flock images to that version,
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
if [[ "${1:-}" == --skip-backup ]]; then SKIP_BACKUP=1; shift; fi
(($# == 0)) || { usage >&2; exit 2; }
[[ "$TARGET" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "VERSION must be semantic, for example 0.3.1." >&2
  exit 2
}
[[ -f .env ]] || { echo "Run from the Flock deployment directory containing .env." >&2; exit 1; }
docker compose version >/dev/null
docker compose config --quiet

OLD_VERSION="$(sed -n 's/^FLOCK_VERSION=//p' .env | tail -n 1)"
[[ -n "$OLD_VERSION" ]] || { echo ".env has no FLOCK_VERSION." >&2; exit 1; }
if [[ "$OLD_VERSION" == "$TARGET" ]]; then
  echo "Flock is already pinned to $TARGET."
  exit 0
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

echo "Pulling immutable Flock $TARGET images..."
FLOCK_VERSION="$TARGET" BROWSER_IMAGE='' docker compose pull

tmp="$(mktemp .env.upgrade.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
awk -v target="$TARGET" '
  /^FLOCK_VERSION=/ { print "FLOCK_VERSION=" target; version=1; next }
  /^BROWSER_IMAGE=/ { print "BROWSER_IMAGE="; browser=1; next }
  { print }
  END {
    if (!version) print "FLOCK_VERSION=" target
    if (!browser) print "BROWSER_IMAGE="
  }
' .env > "$tmp"
chmod --reference=.env "$tmp"
mv -f "$tmp" .env

echo "Starting Flock $TARGET and applying idempotent migrations..."
if ! docker compose up -d --no-build --wait; then
  echo "Upgrade did not become healthy." >&2
  echo "Previous environment: $ENV_ROLLBACK" >&2
  echo "Verified database vault: $BACKUP" >&2
  echo "Do not start an older image against a migrated database until its schema compatibility is confirmed." >&2
  exit 1
fi

docker compose exec -T orchestrator node -e \
  "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

echo "Flock upgraded successfully: $OLD_VERSION -> $TARGET"
echo "Rollback metadata retained: $ENV_ROLLBACK"
echo "Verified database vault: $BACKUP"
