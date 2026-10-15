#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
subject="$repository_root/packages/api/scripts/run-native-product-agent-bootstrap.sh"
test_root=$(mktemp -d)
real_mktemp=$(command -v mktemp)
export TEST_REAL_BUN=$(command -v bun)
export TEST_SUCCESS_REPORT=$(bun -e '
import {createHash} from "node:crypto";
const plan={after:{},aliaManifest:{},before:{},desired:{},direction:"bootstrap",manifestVersion:1,operations:[]};
console.log("NATIVE_PRODUCT_AGENTS_RESULT="+JSON.stringify({mode:"dry-run",direction:"bootstrap",planSha256:createHash("sha256").update(JSON.stringify(plan)).digest("hex"),plan}));')
trap 'rm -rf -- "$test_root"' EXIT

mkdir -p "$test_root/bin"
cat >"$test_root/bin/bun" <<'EOF'
#!/bin/sh
set -eu
if [ "$1" = packages/api/scripts/validate-native-product-bootstrap-report.mjs ]; then
  exec "$TEST_REAL_BUN" "$@"
fi
[ "$1" = run ]
[ "$2" = packages/api/scripts/bootstrap-native-product-agents.ts ]
[ "${LOG_LEVEL:-}" = silent ]

# No secret, in any form, in any mode: the bootstrap retires credentials and
# never proves or mints one.
[ -z "${HOMIIO_SINDI_SERVICE_SECRET_VALUE+x}" ]
[ -z "${CLARITY_BACKEND_SERVICE_SECRET_VALUE+x}" ]
[ -z "${HOMIIO_SINDI_SERVICE_SECRET_FILE+x}" ]
[ -z "${CLARITY_BACKEND_SERVICE_SECRET_FILE+x}" ]

case "${TEST_BUN_MODE:-success}" in
  success)
    printf '%s\n' "$TEST_SUCCESS_REPORT"
    ;;
  success-noise)
    printf '%s\n' "$TEST_UNSAFE_MARKER"
    printf '%s\n' "$TEST_SUCCESS_REPORT"
    ;;
  success-extra)
    printf '%s\n' "NATIVE_PRODUCT_AGENTS_RESULT={\"mode\":\"dry-run\",\"direction\":\"bootstrap\",\"planSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"secret\":\"$TEST_UNSAFE_MARKER\"}"
    ;;
  success-state)
    # The pre-ADR-0026 envelope. Nothing consumes credential state any more, so
    # it is no longer a shape a success may take.
    printf '%s\n' 'NATIVE_PRODUCT_AGENTS_RESULT={"mode":"dry-run","direction":"bootstrap","planSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","serviceCredentialState":{"homiioSindiExists":false,"clarityBackendExists":true}}'
    ;;
  success-multiple)
    printf '%s\n' "$TEST_SUCCESS_REPORT"
    printf '%s\n' 'NATIVE_PRODUCT_AGENTS_RESULT={"mode":"apply","direction":"bootstrap","planSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    ;;
  success-missing) ;;
  must-not-run)
    # Succeeds if reached, so a wrapper that let the process start fails the
    # exit-code assertion rather than passing by coincidence.
    printf '%s\n' "$TEST_SUCCESS_REPORT"
    ;;
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

success_output=$(PATH="$test_root/bin:$PATH" APPLY=1 ROLLBACK=0 sh "$subject")
[ "$success_output" = "$TEST_SUCCESS_REPORT" ]

PATH="$test_root/bin:$PATH" APPLY=0 ROLLBACK=0 sh "$subject"
PATH="$test_root/bin:$PATH" APPLY=1 ROLLBACK=1 sh "$subject"

# A task that still injects a retired secret is refused before Bun starts, in
# every mode, and the value never reaches the output.
retired_secret=$(printf 'a%.0s' {1..64})
for mode in '0 0' '1 0' '1 1'; do
  set -- $mode
  for variable in HOMIIO_SINDI_SERVICE_SECRET_VALUE CLARITY_BACKEND_SERVICE_SECRET_VALUE; do
    set +e
    injected_output=$(env PATH="$test_root/bin:$PATH" APPLY="$1" ROLLBACK="$2" \
      "$variable=$retired_secret" TEST_BUN_MODE=must-not-run sh "$subject" 2>&1)
    injected_exit=$?
    set -e
    [ "$injected_exit" -eq 64 ]
    [ "$injected_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
    if grep -Fq "$retired_secret" <<<"$injected_output"; then
      echo 'a retired service secret leaked to wrapper output' >&2
      exit 1
    fi
  done
done

unsafe_marker='must-not-cross-the-wrapper-boundary'
set +e
mktemp_output=$(PATH="$test_root/bin:$PATH" APPLY=0 ROLLBACK=0 TEST_MKTEMP_FAIL=1 TEST_UNSAFE_MARKER="$unsafe_marker" sh "$subject" 2>&1)
mktemp_exit=$?
success_noise_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=success-noise TEST_UNSAFE_MARKER="$unsafe_marker" sh "$subject" 2>&1)
success_noise_exit=$?
success_extra_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=success-extra TEST_UNSAFE_MARKER="$unsafe_marker" sh "$subject" 2>&1)
success_extra_exit=$?
success_state_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=success-state sh "$subject" 2>&1)
success_state_exit=$?
success_multiple_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=success-multiple sh "$subject" 2>&1)
success_multiple_exit=$?
success_missing_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=success-missing sh "$subject" 2>&1)
success_missing_exit=$?
classified_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=classified-failure TEST_UNSAFE_MARKER="$unsafe_marker" sh "$subject" 2>&1)
classified_exit=$?
process_output=$(PATH="$test_root/bin:$PATH" TEST_BUN_MODE=process-failure TEST_UNSAFE_MARKER="$unsafe_marker" sh "$subject" 2>&1)
process_exit=$?
set -e
[ "$mktemp_exit" -eq 70 ]
[ "$mktemp_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
[ "$success_noise_exit" -eq 70 ]
[ "$success_noise_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
[ "$success_extra_exit" -eq 70 ]
[ "$success_extra_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
[ "$success_state_exit" -eq 70 ]
[ "$success_state_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
[ "$success_multiple_exit" -eq 70 ]
[ "$success_multiple_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
[ "$success_missing_exit" -eq 70 ]
[ "$success_missing_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
[ "$classified_exit" -eq 1 ]
[ "$classified_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"live_state_drift"}' ]
[ "$process_exit" -eq 1 ]
[ "$process_output" = 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"bootstrap_process_failed"}' ]
case "$mktemp_output$success_noise_output$success_extra_output$success_multiple_output$success_missing_output$classified_output$process_output" in
  *"$unsafe_marker"*)
    echo 'free-form bootstrap output crossed the wrapper boundary' >&2
    exit 1
    ;;
esac

echo 'Native product agent wrapper tests passed (no secret crosses it).'
