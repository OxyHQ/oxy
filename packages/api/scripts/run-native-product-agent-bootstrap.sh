#!/bin/sh

# Materialize the two ECS-injected service secrets only for the lifetime of the
# one-shot bootstrap process. The raw values are unset before Bun starts; the
# bootstrap receives only 0600 file paths and hashes their contents itself.

set -eu
umask 077

homiio_secret_file=''
clarity_secret_file=''
bootstrap_output_file=''

cleanup() {
  unset HOMIIO_SINDI_SERVICE_SECRET_VALUE CLARITY_BACKEND_SERVICE_SECRET_VALUE
  [ -z "$homiio_secret_file" ] || rm -f -- "$homiio_secret_file"
  [ -z "$clarity_secret_file" ] || rm -f -- "$clarity_secret_file"
  [ -z "$bootstrap_output_file" ] || rm -f -- "$bootstrap_output_file"
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

bootstrap_output_file=$(mktemp /tmp/oxy-native-agent-bootstrap.XXXXXX)
bootstrap_status=0
bun run packages/api/scripts/bootstrap-native-product-agents.ts \
  >"$bootstrap_output_file" 2>/dev/null || bootstrap_status=$?
if [ "$bootstrap_status" -eq 0 ]; then
  cat "$bootstrap_output_file"
else
  result_line=$(grep '^NATIVE_PRODUCT_AGENTS_RESULT=' "$bootstrap_output_file" | tail -1 || true)
  if [ -n "$result_line" ]; then
    printf '%s\n' "$result_line"
  else
    printf '%s\n' 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}'
  fi
fi
exit "$bootstrap_status"
