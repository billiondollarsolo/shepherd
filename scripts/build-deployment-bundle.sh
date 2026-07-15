#!/usr/bin/env bash
# Build the versioned, checksum-verifiable deployment definition published with a release.
set -euo pipefail

VERSION="${1:?usage: build-deployment-bundle.sh VERSION DIGEST_DIR [OUTPUT_DIR]}"
DIGEST_DIR="${2:?usage: build-deployment-bundle.sh VERSION DIGEST_DIR [OUTPUT_DIR]}"
OUTPUT_DIR="${3:-dist/deployment}"
case "$VERSION" in v*) VERSION="${VERSION#v}" ;; esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || {
  echo "invalid release version: $VERSION" >&2; exit 2;
}
command -v jq >/dev/null
command -v sha256sum >/dev/null

stage="$(mktemp -d "${TMPDIR:-/tmp}/shepherd-deploy.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
root="$stage/shepherd-$VERSION"
mkdir -p "$root/docker" "$root/scripts" "$OUTPUT_DIR"

cp .env.example LICENSE "$root/"
cp docker-compose*.yml "$root/"
cp docker/Caddyfile* docker/caddy-entrypoint.sh docker/stage-secret.sh "$root/docker/"
cp scripts/flock-upgrade.sh "$root/scripts/"
cp agentd/COMPATIBILITY.json "$root/agentd-compatibility.json"

images='{}'
for image in shepherd-orchestrator shepherd-node-runtime shepherd-web shepherd-caddy shepherd-postgres; do
  digest_file="$DIGEST_DIR/$image.digest"
  [ -s "$digest_file" ] || { echo "missing candidate digest: $digest_file" >&2; exit 1; }
  digest="$(tr -d '\r\n' < "$digest_file")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid digest for $image" >&2; exit 1; }
  images="$(jq --arg image "$image" --arg ref "ghcr.io/billiondollarsolo/$image@$digest" \
    '. + {($image): $ref}' <<<"$images")"
done

jq --arg version "$VERSION" --argjson images "$images" \
  '.controlPlaneVersion=$version | .runtime.preferredVersion=$version | .images=$images' \
  deploy/release-manifest.json > "$root/release-manifest.json"
(cd "$root" && find . -type f -print0 | sort -z | xargs -0 sha256sum) > "$stage/SHA256SUMS"
mv "$stage/SHA256SUMS" "$root/SHA256SUMS"

archive="$OUTPUT_DIR/shepherd-deployment-$VERSION.tar.gz"
tar -C "$stage" --sort=name --owner=0 --group=0 --numeric-owner -czf "$archive" "shepherd-$VERSION"
sha256sum "$archive" > "$archive.sha256"
echo "$archive"
