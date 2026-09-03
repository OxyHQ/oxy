#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
subject="$repository_root/.github/scripts/put-secure-parameter.sh"
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT

aws() {
  printf '%s\n' "$@" >"$TEST_AWS_ARGV_FILE"
  cat >"$TEST_AWS_STDIN_FILE"
}
export -f aws

run_case() {
  local name="$1"
  local value="$2"
  local parameter="$3"
  local mode="$4"
  local description="${5-}"
  local argv_file="$test_root/$name.aws.argv"
  local stdin_file="$test_root/$name.aws.stdin"

  printf '%s' "$value" | \
    TEST_AWS_ARGV_FILE="$argv_file" \
    TEST_AWS_STDIN_FILE="$stdin_file" \
      bash "$subject" "$parameter" "$mode" "$description"

  if grep -F "$value" "$argv_file" >/dev/null; then
    echo "$name: secure value leaked to aws argv"
    exit 1
  fi
  diff -u <(printf '%s\n' ssm put-parameter --cli-input-json file:///dev/stdin) "$argv_file"
  jq -e \
    --arg name "$parameter" \
    --arg value "$value" \
    --arg description "$description" \
    --argjson overwrite "$([ "$mode" = overwrite ] && printf true || printf false)" '
      .Name == $name and
      .Type == "SecureString" and
      .Value == $value and
      .Overwrite == $overwrite and
      (if $description == "" then has("Description") | not else .Description == $description end)
    ' "$stdin_file" >/dev/null
}

OUTPUT_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
SERVICE_SECRET='service-secret-that-must-not-appear-in-aws-argv-0123456789abcdef'
PUBLIC_KEY='oxy_dk_public_identifier_is_not_a_secret'

run_case output-encryption-key "$OUTPUT_KEY" \
  '/oxy/_ops/service-credential-kaana-123-1' create \
  'Ephemeral credential envelope key for application exact-id'
run_case service-secret "$SERVICE_SECRET" \
  '/oxy/alia/OXY_SERVICE_API_SECRET' overwrite
run_case public-key "$PUBLIC_KEY" \
  '/oxy/alia/OXY_SERVICE_API_KEY' overwrite

deploy_workflow="$repository_root/.github/workflows/deploy-aws.yml"
app_template="$repository_root/packages/create-oxy-app/templates/deploy/DOT_github/workflows/deploy-aws.yml"
if grep -Fq -- '--value "$v"' "$deploy_workflow" "$app_template"; then
  echo 'a deploy workflow still places a protected value in aws argv' >&2
  exit 1
fi
grep -Fq -- 'bash .github/scripts/put-secure-parameter.sh "$path" overwrite' "$deploy_workflow"
grep -Fq -- '--cli-input-json file:///dev/stdin' "$app_template"

set +e
printf '' | TEST_AWS_ARGV_FILE="$test_root/empty.argv" TEST_AWS_STDIN_FILE="$test_root/empty.stdin" \
  bash "$subject" '/oxy/test/EMPTY' create >"$test_root/empty.log" 2>&1
empty_exit=$?
set -e
if [ "$empty_exit" -eq 0 ]; then
  echo "empty value must fail"
  exit 1
fi

echo "Secure SSM parameter stdin and argv tests passed."
