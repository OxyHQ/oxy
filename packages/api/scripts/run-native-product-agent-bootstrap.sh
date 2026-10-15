#!/bin/sh

# Run the one-shot native product-agent bootstrap and let exactly one
# structured result line cross the task boundary.
#
# No secret enters this process. The two product backends attest their ECS
# task roles (ADR 0026), so the bootstrap only ever REVOKES the service
# credentials they used to present, and never creates or proves one. The two
# variables that used to carry those secrets are refused outright: a task that
# still injects them was rendered by something that has not caught up, and
# running on would hand a retired secret to a process that has no use for it.

set -eu
umask 077

bootstrap_output_file=''

cleanup() {
  [ -z "$bootstrap_output_file" ] || rm -f -- "$bootstrap_output_file" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

fail_pre_entrypoint() {
  printf '%s\n' 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}'
  exit "$1"
}

is_valid_success_result() {
  printf '%s\n' "$1" | node packages/api/scripts/validate-native-product-bootstrap-report.mjs --check >/dev/null 2>&1
}

if [ -n "${HOMIIO_SINDI_SERVICE_SECRET_VALUE+x}" ] || [ -n "${CLARITY_BACKEND_SERVICE_SECRET_VALUE+x}" ]; then
  unset HOMIIO_SINDI_SERVICE_SECRET_VALUE CLARITY_BACKEND_SERVICE_SECRET_VALUE
  fail_pre_entrypoint 64
fi

bootstrap_output_file=$(mktemp /tmp/oxy-native-agent-bootstrap.XXXXXX 2>/dev/null) || fail_pre_entrypoint 70
bootstrap_status=0
LOG_LEVEL=silent bun run packages/api/scripts/bootstrap-native-product-agents.ts \
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
