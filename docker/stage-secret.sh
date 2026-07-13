#!/bin/sh
# Copy a Compose bind-mounted secret into an ephemeral, least-privilege runtime
# path before dropping root. Standalone Docker Compose cannot honor uid/gid/mode
# for file-backed secrets, so the source may correctly remain 0600 on the host.
set -eu

if [ "$#" -ne 6 ]; then
  echo "usage: flock-stage-secret SOURCE TARGET OWNER GROUP MODE LABEL" >&2
  exit 64
fi

SOURCE=$1
TARGET=$2
OWNER=$3
GROUP=$4
MODE=$5
LABEL=$6

if [ ! -f "$SOURCE" ] || [ ! -s "$SOURCE" ] || [ ! -r "$SOURCE" ]; then
  echo "[secret-stage] $LABEL is missing, empty, or unreadable: $SOURCE" >&2
  exit 1
fi

install -d -o root -g "$GROUP" -m 0750 "$(dirname "$TARGET")"
install -o "$OWNER" -g "$GROUP" -m "$MODE" "$SOURCE" "$TARGET"
printf '%s\n' "$TARGET"
