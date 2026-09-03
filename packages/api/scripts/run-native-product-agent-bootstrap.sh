#!/bin/sh

# Materialize the two ECS-injected service secrets only for the lifetime of the
# one-shot bootstrap process. The raw values are unset before Bun starts; the
# bootstrap receives only 0600 file paths and hashes their contents itself.

set -eu
umask 077

homiio_secret_file=''
clarity_secret_file=''

cleanup() {
  unset HOMIIO_SINDI_SERVICE_SECRET_VALUE CLARITY_BACKEND_SERVICE_SECRET_VALUE
  [ -z "$homiio_secret_file" ] || rm -f -- "$homiio_secret_file"
  [ -z "$clarity_secret_file" ] || rm -f -- "$clarity_secret_file"
}
trap cleanup EXIT HUP INT TERM

is_service_secret() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

if [ "${APPLY:-0}" = '1' ] && [ "${ROLLBACK:-0}" != '1' ]; then
  : "${HOMIIO_SINDI_SERVICE_SECRET_VALUE:?missing protected Homiio Sindi service secret}"
  : "${CLARITY_BACKEND_SERVICE_SECRET_VALUE:?missing protected Clarity backend service secret}"
  is_service_secret "$HOMIIO_SINDI_SERVICE_SECRET_VALUE" || {
    echo 'Homiio Sindi service secret must be exactly 64 lowercase hex characters' >&2
    exit 64
  }
  is_service_secret "$CLARITY_BACKEND_SERVICE_SECRET_VALUE" || {
    echo 'Clarity backend service secret must be exactly 64 lowercase hex characters' >&2
    exit 64
  }

  homiio_secret_file=$(mktemp /tmp/oxy-native-agent-homiio.XXXXXX)
  clarity_secret_file=$(mktemp /tmp/oxy-native-agent-clarity.XXXXXX)
  chmod 0600 "$homiio_secret_file" "$clarity_secret_file"
  printf '%s' "$HOMIIO_SINDI_SERVICE_SECRET_VALUE" >"$homiio_secret_file"
  printf '%s' "$CLARITY_BACKEND_SERVICE_SECRET_VALUE" >"$clarity_secret_file"
  unset HOMIIO_SINDI_SERVICE_SECRET_VALUE CLARITY_BACKEND_SERVICE_SECRET_VALUE

  export HOMIIO_SINDI_SERVICE_SECRET_FILE="$homiio_secret_file"
  export CLARITY_BACKEND_SERVICE_SECRET_FILE="$clarity_secret_file"
fi

bun run packages/api/scripts/bootstrap-native-product-agents.ts
