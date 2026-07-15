#!/usr/bin/env bash
# Regression test for the portable, self-verifying release deployment bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/shepherd-bundle-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/digests" "$TMP/output" "$TMP/extracted"
for image in shepherd-orchestrator shepherd-node-runtime shepherd-web shepherd-caddy shepherd-postgres; do
  printf 'sha256:%064d\n' 0 > "$TMP/digests/$image.digest"
done

cd "$ROOT"
scripts/build-deployment-bundle.sh 0.0.0-test "$TMP/digests" "$TMP/output" >/dev/null

archive_name='shepherd-deployment-0.0.0-test.tar.gz'
checksum_target="$(awk '{print $2}' "$TMP/output/$archive_name.sha256")"
[[ "$checksum_target" == "$archive_name" ]] || {
  echo "deployment checksum is not portable: $checksum_target" >&2
  exit 1
}
(cd "$TMP/output" && sha256sum -c "$archive_name.sha256")

tar -C "$TMP/extracted" -xzf "$TMP/output/$archive_name"
bundle_root="$TMP/extracted/shepherd-0.0.0-test"
(cd "$bundle_root" && sha256sum -c SHA256SUMS)
jq -e \
  '.controlPlaneVersion == "0.0.0-test" and
   .runtime.preferredVersion == "0.0.0-test" and
   (.images | length) == 5 and
   ([.images[] | startswith("ghcr.io/billiondollarsolo/shepherd-")] | all)' \
  "$bundle_root/release-manifest.json" >/dev/null
