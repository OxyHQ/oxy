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
  [ -z "$homiio_secret_file" ] || rm -f -- "$homiio_secret_file" >/dev/null 2>&1 || true
  [ -z "$clarity_secret_file" ] || rm -f -- "$clarity_secret_file" >/dev/null 2>&1 || true
  [ -z "$bootstrap_output_file" ] || rm -f -- "$bootstrap_output_file" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

fail_pre_entrypoint() {
  printf '%s\n' 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}'
  exit "$1"
}

is_service_secret() {
  [ "${#1}" -eq 64 ] || return 1
  case "$1" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

is_valid_success_result() {
  printf '%s\n' "$1" | grep -Eq '^NATIVE_PRODUCT_AGENTS_RESULT=\{"mode":"(dry-run|apply)","direction":"(bootstrap|rollback)","planSha256":"[a-f0-9]{64}"(,"serviceCredentialState":\{"homiioSindiExists":(true|false),"clarityBackendExists":(true|false)\})?\}$' >/dev/null 2>&1
}

if [ "${APPLY:-0}" = '1' ] && [ "${ROLLBACK:-0}" != '1' ]; then
  [ -n "${HOMIIO_SINDI_SERVICE_SECRET_VALUE:-}" ] || fail_pre_entrypoint 64
  [ -n "${CLARITY_BACKEND_SERVICE_SECRET_VALUE:-}" ] || fail_pre_entrypoint 64
  is_service_secret "${HOMIIO_SINDI_SERVICE_SECRET_VALUE:-}" || fail_pre_entrypoint 64
  is_service_secret "${CLARITY_BACKEND_SERVICE_SECRET_VALUE:-}" || fail_pre_entrypoint 64

  homiio_secret_file=$(mktemp /tmp/oxy-native-agent-homiio.XXXXXX 2>/dev/null) || fail_pre_entrypoint 70
  clarity_secret_file=$(mktemp /tmp/oxy-native-agent-clarity.XXXXXX 2>/dev/null) || fail_pre_entrypoint 70
  chmod 0600 "$homiio_secret_file" "$clarity_secret_file" >/dev/null 2>&1 || fail_pre_entrypoint 70
  printf '%s' "$HOMIIO_SINDI_SERVICE_SECRET_VALUE" 2>/dev/null >"$homiio_secret_file" || fail_pre_entrypoint 70
  printf '%s' "$CLARITY_BACKEND_SERVICE_SECRET_VALUE" 2>/dev/null >"$clarity_secret_file" || fail_pre_entrypoint 70
  unset HOMIIO_SINDI_SERVICE_SECRET_VALUE CLARITY_BACKEND_SERVICE_SECRET_VALUE

  export HOMIIO_SINDI_SERVICE_SECRET_FILE="$homiio_secret_file"
  export CLARITY_BACKEND_SERVICE_SECRET_FILE="$clarity_secret_file"
fi

bootstrap_output_file=$(mktemp /tmp/oxy-native-agent-bootstrap.XXXXXX 2>/dev/null) || fail_pre_entrypoint 70
bootstrap_status=0
bun run packages/api/scripts/bootstrap-native-product-agents.ts \
  >"$bootstrap_output_file" 2>/dev/null || bootstrap_status=$?
result_line=$(grep -a '^NATIVE_PRODUCT_AGENTS_RESULT=' "$bootstrap_output_file" 2>/dev/null | tail -1 || true)
if [ "$bootstrap_status" -eq 0 ]; then
  result_count=$(grep -ac '^NATIVE_PRODUCT_AGENTS_RESULT=' "$bootstrap_output_file" 2>/dev/null || true)
  output_bytes=$(wc -c <"$bootstrap_output_file" 2>/dev/null | tr -d '[:space:]' || true)
  result_bytes=$(printf '%s\n' "$result_line" | wc -c | tr -d '[:space:]')
  if [ "$result_count" = '1' ] && [ "$output_bytes" = "$result_bytes" ] && is_valid_success_result "$result_line"; then
    printf '%s\n' "$result_line"
  else
    printf '%s\n' 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}'
    bootstrap_status=70
  fi
else
  if [ -n "$result_line" ]; then
    printf '%s\n' "$result_line"
  else
    printf '%s\n' 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}'
  fi
fi
exit "$bootstrap_status"
