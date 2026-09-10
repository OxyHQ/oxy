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

  while IFS= read -r value_line; do
    if [ -n "$value_line" ] && grep -F -- "$value_line" "$argv_file" >/dev/null; then
      echo "$name: secure value leaked to aws argv"
      exit 1
    fi
  done <<<"$value"
  expected=(ssm put-parameter --name "$parameter" --type SecureString --value file:///dev/stdin)
  if [ "$mode" = overwrite ]; then expected+=(--overwrite); fi
  if [ -n "$description" ]; then expected+=(--description "$description"); fi
  diff -u <(printf '%s\n' "${expected[@]}") "$argv_file"
  cmp -s <(printf '%s' "$value") "$stdin_file"
}

OUTPUT_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
SERVICE_SECRET='service-secret-that-must-not-appear-in-aws-argv-0123456789abcdef'
PUBLIC_KEY='oxy_dk_public_identifier_is_not_a_secret'
MULTILINE_VALUE=$'first line\nsecond line\n'

run_case output-encryption-key "$OUTPUT_KEY" \
  '/oxy/_ops/service-credential-kaana-123-1' create \
  'Ephemeral credential envelope key for application exact-id'
run_case service-secret "$SERVICE_SECRET" \
  '/oxy/alia/OXY_SERVICE_API_SECRET' overwrite
run_case public-key "$PUBLIC_KEY" \
  '/oxy/alia/OXY_SERVICE_API_KEY' overwrite
run_case multiline "$MULTILINE_VALUE" \
  '/oxy/test/MULTILINE' overwrite

# Exercise the real AWS CLI parameter-file parser without making a request.
# The former `--cli-input-json` stdin form passed the fake above yet AWS CLI
# rejected it in production before calling SSM; the scalar form must be parsed
# by the installed CLI itself so that regression cannot recur silently.
if command -v aws >/dev/null 2>&1; then
  printf 'parser-probe' | \
    env AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
      aws ssm put-parameter \
        --name /oxy/test/PARSER_PROBE \
        --type SecureString \
        --value file:///dev/stdin \
        --overwrite \
        --generate-cli-skeleton output >/dev/null
fi

deploy_workflow="$repository_root/.github/workflows/deploy-aws.yml"
app_template="$repository_root/packages/create-oxy-app/templates/deploy/DOT_github/workflows/deploy-aws.yml"
if grep -Fq -- '--value "$v"' "$deploy_workflow" "$app_template"; then
  echo 'a deploy workflow still places a protected value in aws argv' >&2
  exit 1
fi
grep -Fq -- 'bash .github/scripts/put-secure-parameter.sh "$path" overwrite' "$deploy_workflow"
grep -Fq -- '- ".github/scripts/put-secure-parameter.sh"' "$deploy_workflow"
grep -Fq -- '--value file:///dev/stdin' "$app_template"
if grep -Fq -- '--cli-input-json file:///dev/stdin' "$subject" "$app_template"; then
  echo 'a secure-parameter writer still uses the AWS CLI JSON stdin form that production rejects' >&2
  exit 1
fi

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
