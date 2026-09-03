#!/usr/bin/env bash

set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
subject="$repository_root/packages/api/scripts/run-native-product-agent-bootstrap.sh"
test_root=$(mktemp -d)
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
EOF
chmod 0700 "$test_root/bin/bun"

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
PATH="$test_root/bin:$PATH" \
  APPLY=1 \
  ROLLBACK=0 \
  HOMIIO_SINDI_SERVICE_SECRET_VALUE="${homiio_secret}A" \
  CLARITY_BACKEND_SERVICE_SECRET_VALUE="$clarity_secret" \
  sh "$subject" >"$test_root/invalid.log" 2>&1
invalid_exit=$?
set -e
if [ "$invalid_exit" -eq 0 ]; then
  echo 'uppercase or wrong-length secrets must fail closed' >&2
  exit 1
fi

if grep -Fq "$clarity_secret" "$test_root/invalid.log"; then
  echo 'a service secret leaked to wrapper output' >&2
  exit 1
fi

echo 'Native product agent secret-file wrapper tests passed.'
