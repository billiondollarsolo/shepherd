#!/bin/sh
# Shepherd session-chrome entrypoint.
#
# Modern Chrome (111+) ignores `--remote-debugging-address` and binds the CDP
# server to the container's LOOPBACK only, so a published port can't reach it.
# We bridge it: Chrome listens on 127.0.0.1:<inner>, and socat exposes the
# requested CDP port on 0.0.0.0 forwarding to that loopback inner port. To Layer
# A (which publishes `--remote-debugging-port`) this is transparent.
#
# Args are Chrome flags (passed by Layer A as the container Cmd). We read the
# requested CDP port from them, run Chrome one port higher on loopback, and point
# socat at it.
set -eu

PORT=9222
for a in "$@"; do
  case "$a" in
    --remote-debugging-port=*) PORT="${a#*=}" ;;
  esac
done
INNER=$((PORT + 1))

# 0.0.0.0:PORT (the published CDP port) -> Chrome's loopback INNER port.
socat "TCP-LISTEN:${PORT},fork,reuseaddr,bind=0.0.0.0" "TCP:127.0.0.1:${INNER}" &

# Rewrite the CDP flags so Chrome runs on the inner loopback port.
NEWARGS=""
for a in "$@"; do
  case "$a" in
    --remote-debugging-port=*) a="--remote-debugging-port=${INNER}" ;;
    --remote-debugging-address=*) a="--remote-debugging-address=127.0.0.1" ;;
  esac
  NEWARGS="${NEWARGS} ${a}"
done

# shellcheck disable=SC2086
exec chromium-browser ${NEWARGS}
