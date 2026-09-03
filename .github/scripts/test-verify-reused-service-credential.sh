#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
subject="$repository_root/.github/scripts/verify-reused-service-credential.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

EXPECTED_KEY='oxy_dk_exact_reused_key'
VALID_SECRET='valid-reused-secret-that-must-never-appear'
STALE_SECRET='stale-reused-secret-that-must-never-appear'

aws() {
  local parameter=""
  local query=""
  local decrypt="false"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --name) parameter="$2"; shift 2 ;;
      --query) query="$2"; shift 2 ;;
      --with-decryption) decrypt="true"; shift ;;
      *) shift ;;
    esac
  done
  if [ "$query" = "Parameter.Type" ]; then
    printf '%s\n' "${TEST_PARAMETER_TYPE:-SecureString}"
    return
  fi
  if [ "$query" = "Parameter.Value" ] && [ "$decrypt" = "true" ]; then
    case "$parameter" in
      */KEY) printf '%s\n' "$TEST_STORED_KEY" ;;
      */SECRET) printf '%s\n' "$TEST_STORED_SECRET" ;;
      *) return 1 ;;
    esac
    return
  fi
  return 1
}
export -f aws

curl() {
  local payload=""
  local data_source=""
  local url=""
  printf '%s\n' "$@" >"$TEST_CURL_ARGV_FILE"
  payload=$(cat)
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --data-binary) data_source="$2"; shift 2 ;;
      https://*) url="$1"; shift ;;
      *) shift ;;
    esac
  done
  [ "$url" = "https://api.oxy.so/auth/service-token" ] || return 70
  [ "$data_source" = "@-" ] || return 72
  expected_payload=$(jq -nc \
    --arg apiKey "$TEST_STORED_KEY" \
    --arg apiSecret "$TEST_STORED_SECRET" \
    '{apiKey:$apiKey,apiSecret:$apiSecret}')
  [ "$payload" = "$expected_payload" ] || return 71
  printf '%s' "${TEST_CURL_STATUS:-200}"
}
export -f curl

run_case() {
  local name="$1"
  local expected_exit="$2"
  local stored_key="$3"
  local stored_secret="$4"
  local curl_status="$5"
  local parameter_type="${6:-SecureString}"
  local output="$test_root/$name.log"
  local visible_output="$test_root/$name.visible.log"
  local curl_argv="$test_root/$name.curl.argv"

  set +e
  EXPECTED_PUBLIC_KEY="$EXPECTED_KEY" \
  SSM_KEY_PARAMETER='/oxy/test/KEY' \
  SSM_SECRET_PARAMETER='/oxy/test/SECRET' \
  TEST_STORED_KEY="$stored_key" \
  TEST_STORED_SECRET="$stored_secret" \
  TEST_CURL_STATUS="$curl_status" \
  TEST_CURL_ARGV_FILE="$curl_argv" \
  TEST_PARAMETER_TYPE="$parameter_type" \
    bash "$subject" >"$output" 2>&1
  actual_exit=$?
  set -e

  if [ "$actual_exit" -ne "$expected_exit" ]; then
    echo "$name: expected exit $expected_exit, got $actual_exit"
    exit 1
  fi
  # `add-mask` is the Actions runner's secret-registration channel. Once those
  # control records are removed, no diagnostic or ordinary output may contain
  # either secret.
  grep -v '^::add-mask::' "$output" >"$visible_output" || true
  if grep -F "$VALID_SECRET" "$visible_output" >/dev/null || grep -F "$STALE_SECRET" "$visible_output" >/dev/null; then
    echo "$name: credential secret leaked to output"
    exit 1
  fi
  if [ -f "$curl_argv" ]; then
    if grep -F "$stored_key" "$curl_argv" >/dev/null || grep -F "$stored_secret" "$curl_argv" >/dev/null; then
      echo "$name: credential material leaked to curl argv"
      exit 1
    fi
    grep -Fx -- '--data-binary' "$curl_argv" >/dev/null
    grep -Fx -- '@-' "$curl_argv" >/dev/null
  fi
}

run_case valid-reuse 0 "$EXPECTED_KEY" "$VALID_SECRET" 200
grep -F 'authenticates successfully' "$test_root/valid-reuse.log" >/dev/null

run_case stale-key 1 'oxy_dk_stale_key' "$VALID_SECRET" 200
grep -F 'public key does not match' "$test_root/stale-key.log" >/dev/null

run_case stale-secret 1 "$EXPECTED_KEY" "$STALE_SECRET" 401
grep -F 'did not authenticate' "$test_root/stale-secret.log" >/dev/null

run_case wrong-parameter-type 1 "$EXPECTED_KEY" "$VALID_SECRET" 200 String
grep -F 'not SecureString' "$test_root/wrong-parameter-type.log" >/dev/null

echo "Reused service credential verification tests passed."
