#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
subject="$repository_root/.github/scripts/report-native-product-agent-task-failure.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

plan_sha=$(printf 'a%.0s' {1..64})

run_reporter() {
  local reporter="$1"
  local envelope="$2"
  printf '%s' "$envelope" | bash "$reporter" dry-run-bootstrap 1 2>&1
}

expected="::error::dry-run-bootstrap task exited 1; structured_result={\"code\":\"database_unavailable\"}"
actual=$(run_reporter "$subject" 'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"database_unavailable"}')
[ "$actual" = "$expected" ]

expected="::error::dry-run-bootstrap task exited 1; structured_result={\"code\":\"plan_rejected\",\"planSha256\":\"$plan_sha\"}"
actual=$(run_reporter "$subject" "NATIVE_PRODUCT_AGENTS_RESULT={\"status\":\"failed\",\"code\":\"plan_rejected\",\"planSha256\":\"$plan_sha\"}")
[ "$actual" = "$expected" ]

expected="::error::dry-run-bootstrap task exited 1; structured_result={\"code\":\"task_exited_after_valid_plan\",\"planSha256\":\"$plan_sha\"}"
actual=$(run_reporter "$subject" "NATIVE_PRODUCT_AGENTS_RESULT={\"mode\":\"dry-run\",\"direction\":\"bootstrap\",\"planSha256\":\"$plan_sha\",\"serviceCredentialState\":{\"homiioSindiExists\":false,\"clarityBackendExists\":true}}")
[ "$actual" = "$expected" ]

unsafe_marker='must-not-appear-9d65d1'
for unsafe_envelope in \
  "NATIVE_PRODUCT_AGENTS_RESULT={\"status\":\"failed\",\"code\":\"database_unavailable\",\"secret\":\"$unsafe_marker\"}" \
  "NATIVE_PRODUCT_AGENTS_RESULT={\"status\":\"failed\",\"code\":\"database_unavailable\",\"name\":\"$unsafe_marker\"}" \
  "NATIVE_PRODUCT_AGENTS_RESULT={\"status\":\"failed\",\"code\":\"database_unavailable\",\"actor\":\"$unsafe_marker\"}" \
  'NATIVE_PRODUCT_AGENTS_RESULT={"status":"failed","code":"UPPERCASE_NOT_ALLOWED"}' \
  'NATIVE_PRODUCT_AGENTS_RESULT=not-json'
do
  actual=$(run_reporter "$subject" "$unsafe_envelope")
  [ "$actual" = '::error::dry-run-bootstrap task exited 1; structured_result=invalid' ]
  if grep -Fq "$unsafe_marker" <<<"$actual"; then
    echo 'an unallowlisted result field leaked to operator output' >&2
    exit 1
  fi
done

actual=$(run_reporter "$subject" '')
[ "$actual" = '::error::dry-run-bootstrap task exited 1; result_present=no' ]

mutant="$test_root/report-mutant.sh"
sed 's/\["code","status"\]/["code","secret","status"]/' "$subject" >"$mutant"
grep -Fq '["code","secret","status"]' "$mutant"
set +e
(
  mutated_output=$(run_reporter "$mutant" "NATIVE_PRODUCT_AGENTS_RESULT={\"status\":\"failed\",\"code\":\"database_unavailable\",\"secret\":\"$unsafe_marker\"}")
  [ "$mutated_output" = '::error::dry-run-bootstrap task exited 1; structured_result=invalid' ]
) >/dev/null 2>&1
mutation_status=$?
set -e
if [ "$mutation_status" -eq 0 ]; then
  echo 'the extra-field allowlist mutation survived the rejection assertion' >&2
  exit 1
fi

echo 'Native product-agent failure reporting allowlist and mutation tests passed.'
