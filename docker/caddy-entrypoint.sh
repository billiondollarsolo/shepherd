#!/bin/sh
set -eu

# The generated fragment is imported only by the bundled-TLS Caddyfile. Keeping
# provider credentials out of the Caddyfile, command line, and Compose model
# prevents accidental disclosure through logs and process inspection.
fragment=/tmp/shepherd-dns-provider.caddy
provider=$(printf '%s' "${FLOCK_DNS_PROVIDER:-http-challenge}" | tr '[:upper:]' '[:lower:]')
umask 077

read_secret() {
  path=$1
  label=$2
  if [ ! -r "$path" ]; then
    printf 'Shepherd Caddy: %s secret file is not readable: %s\n' "$label" "$path" >&2
    exit 1
  fi
  value=$(tr -d '\r\n' < "$path")
  if [ -z "$value" ]; then
    printf 'Shepherd Caddy: %s secret file is empty: %s\n' "$label" "$path" >&2
    exit 1
  fi
  printf '%s' "$value"
}

case "$provider" in
  ''|none|http-challenge)
    printf '# Core automatic HTTPS uses HTTP-01 or TLS-ALPN-01.\n' > "$fragment"
    ;;
  cloudflare)
    if [ -n "${CF_API_TOKEN_FILE:-}" ]; then
      CF_API_TOKEN=$(read_secret "$CF_API_TOKEN_FILE" 'Cloudflare API token')
      export CF_API_TOKEN
    fi
    if [ -z "${CF_API_TOKEN:-}" ]; then
      printf 'Shepherd Caddy: cloudflare requires CF_API_TOKEN_FILE (recommended) or CF_API_TOKEN.\n' >&2
      exit 1
    fi
    printf 'acme_dns cloudflare {env.CF_API_TOKEN}\n' > "$fragment"
    ;;
  route53)
    if [ -n "${AWS_ACCESS_KEY_ID_FILE:-}" ]; then
      AWS_ACCESS_KEY_ID=$(read_secret "$AWS_ACCESS_KEY_ID_FILE" 'AWS access key ID')
      export AWS_ACCESS_KEY_ID
    fi
    if [ -n "${AWS_SECRET_ACCESS_KEY_FILE:-}" ]; then
      AWS_SECRET_ACCESS_KEY=$(read_secret "$AWS_SECRET_ACCESS_KEY_FILE" 'AWS secret access key')
      export AWS_SECRET_ACCESS_KEY
    fi
    if [ -n "${AWS_SESSION_TOKEN_FILE:-}" ]; then
      AWS_SESSION_TOKEN=$(read_secret "$AWS_SESSION_TOKEN_FILE" 'AWS session token')
      export AWS_SESSION_TOKEN
    fi
    if { [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; } || \
       { [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; }; then
      printf 'Shepherd Caddy: Route53 static credentials require both access-key and secret-key values.\n' >&2
      exit 1
    fi
    # With no static pair, the provider uses the normal AWS credential chain
    # (for example, an EC2 instance role or a mounted shared credentials file).
    printf 'acme_dns route53\n' > "$fragment"
    ;;
  *)
    printf 'Shepherd Caddy: unsupported FLOCK_DNS_PROVIDER: %s\n' "$provider" >&2
    exit 1
    ;;
esac

exec /usr/bin/caddy "$@"
