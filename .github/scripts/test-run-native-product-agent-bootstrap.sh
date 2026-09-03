#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
subject="$repository_root/packages/api/scripts/run-native-product-agent-bootstrap.sh"
test_root=$(mktemp -d)
real_mktemp=$(command -v mktemp)
trap 'rm -rf -- "$test_root"' EXIT

mkdir -p "$test_root/bin"
cat >"$test_root/bin/bun" <<'EOF'
#!/bin/sh
set -eu
[ "$1" = run ]
[ "$2" = packages/api/scripts/bootstrap-native-product-agents.ts ]

if [ "${APPLY:-0}" = '1' ] && [ "${ROLLBACK:-0}" != '1' ]; then
  [ -z "${HOMIIO_SINDI_SERVICE_SECRET_VALUE+x}" ]
  [ -z "${CLARITY_BACKEND_SERVICE_SECRET_VALUE+x}" ]
  [ "$(stat -c '%a' "$HOMIIO_SINDI_SERVICE_SECRET_FILE")" = '600' ]
  [ "$(stat -c '%a' "$CLARITY_BACKEND_SERVICE_SECRET_FILE")" = '600' ]
  [ "$(wc -c <"$HOMIIO_SINDI_SERVICE_SECRET_FILE")" = '64' ]
  [ "$(wc -c <"$CLARITY_BACKEND_SERVICE_SECRET_FILE")" = '64' ]
  [ "$(cat "$HOMIIO_SINDI_SERVICE_SECRET_FILE")" = "$TEST_HOMIIO_SECRET" ]
  [ "$(cat "$CLARITY_BACKEND_SERVICE_SECRET_FILE")" = "$TEST_CLARITY_SECRET" ]
  printf '%s\n' "$HOMIIO_SINDI_SERVICE_SECRET_FILE" >"$TEST_FILE_LIST"
  printf '%s\n' "$CLARITY_BACKEND_SERVICE_SECRET_FILE" >>"$TEST_FILE_LIST"
else
  [ -z "${HOMIIO_SINDI_SERVICE_SECRET_FILE+x}" ]
  [ -z "${CLARITY_BACKEND_SERVICE_SECRET_FILE+x}" ]
fi

case "${TEST_BUN_MODE:-success}" in
  success) ;;
  classified-failure)
    printf '%s\n' "$TEST_UNSAFE_MARKER"
    printf '%s\n' "$TEST_UNSAFE_MARKER" >&2
    printf '%s\n' 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"live_state_drift"}'
    exit 1
    ;;
  process-failure)
    printf '%s\n' "$TEST_UNSAFE_MARKER"
    printf '%s\n' "$TEST_UNSAFE_MARKER" >&2
    exit 1
    ;;
  *) exit 64 ;;
esac
EOF
chmod 0700 "$test_root/bin/bun"

cat >"$test_root/bin/mktemp" <<'EOF'
#!/bin/sh
set -eu
if [ "${TEST_MKTEMP_FAIL:-0}" = '1' ]; then
  printf '%s\n' "${TEST_UNSAFE_MARKER:-unsafe-mktemp-output}" >&2
  exit 1
fi
exec "$TEST_REAL_MKTEMP" "$@"
EOF
chmod 0700 "$test_root/bin/mktemp"
export TEST_REAL_MKTEMP="$real_mktemp"

homiio_secret=$(printf 'a%.0s' {1..64})
clarity_secret=$(printf 'b%.0s' {1..64})
file_list="$test_root/materialized-files"
PATH="$test_root/bin:$PATH" \
  APPLY=1 \
  ROLLBACK=0 \
  HOMIIO_SINDI_SERVICE_SECRET_VALUE="$homiio_secret" \
  CLARITY_BACKEND_SERVICE_SECRET_VALUE="$clarity_secret" \
  TEST_HOMIIO_SECRET="$homiio_secret" \
  TEST_CLARITY_SECRET="$clarity_secret" \
  TEST_FILE_LIST="$file_list" \
  sh "$subject"

while IFS= read -r materialized_file; do
  if [ -e "$materialized_file" ]; then
    echo "protected temporary file survived bootstrap: $materialized_file" >&2
    exit 1
  fi
done <"$file_list"

PATH="$test_root/bin:$PATH" APPLY=0 ROLLBACK=0 sh "$subject"
PATH="$test_root/bin:$PATH" APPLY=1 ROLLBACK=1 sh "$subject"

set +e
invalid_output=$(PATH="$test_root/bin:$PATH" \
  APPLY=1 \
  ROLLBACK=0 \
  HOMIIO_SINDI_SERVICE_SECRET_VALUE="${homiio_secret}A" \
  CLARITY_BACKEND_SERVICE_SECRET_VALUE="$clarity_secret" \
  sh "$subject" 2>&1)
invalid_exit=$?
set -e
[ "$invalid_exit" -eq 64 ]
[ "$invalid_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]

if grep -Fq "$clarity_secret" <<<"$invalid_output"; then
  echo 'a service secret leaked to wrapper output' >&2
  exit 1
fi

unsafe_marker='must-not-cross-the-wrapper-boundary'
set +e
missing_output=$(PATH="$test_root/bin:$PATH" APPLY=1 ROLLBACK=0 sh "$subject" 2>&1)
missing_exit=$?
mktemp_output=$(PATH="$test_root/bin:$PATH" APPLY=0 ROLLBACK=0 TEST_MKTEMP_FAIL=1 TEST_UNSAFE_MARKER="$unsafe_marker" sh "$subject" 2>&1)
mktemp_exit=$?
classified_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=classified-failure TEST_UNSAFE_MARKER="$unsafe_marker" sh "$subject" 2>&1)
classified_exit=$?
process_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=process-failure TEST_UNSAFE_MARKER="$unsafe_marker" sh "$subject" 2>&1)
process_exit=$?
set -e
[ "$missing_exit" -eq 64 ]
[ "$missing_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
[ "$mktemp_exit" -eq 70 ]
[ "$mktemp_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
[ "$classified_exit" -eq 1 ]
[ "$classified_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"live_state_drift"}' ]
[ "$process_exit" -eq 1 ]
[ "$process_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
case "$invalid_output$missing_output$mktemp_output$classified_output$process_output" in
  *"$unsafe_marker"*)
    echo 'free-form bootstrap output crossed the wrapper boundary' >&2
    exit 1
    ;;
esac

echo 'Native product agent secret-file wrapper tests passed.'
