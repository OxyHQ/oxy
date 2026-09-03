#!/usr/bin/env bash

# Prove that an already-existing service credential is recoverable from the
# exact SSM destinations before the provision workflow declares an idempotent
# success. Merely observing two SecureStrings is insufficient: either value may
# belong to an older credential or a partially failed rotation.

set -euo pipefail

SERVICE_TOKEN_URL="https://api.oxy.so/auth/service-token"

required() {
  local name="$1"
  local value="${!name-}"
  if [ -z "$value" ]; then
    echo "::error::$name is required for reused credential verification"
    exit 1
  fi
}

mask() {
  if [ -n "$1" ]; then
    printf '::add-mask::%s\n' "$1"
  fi
}

required EXPECTED_PUBLIC_KEY
required SSM_KEY_PARAMETER
required SSM_SECRET_PARAMETER

destination_key=""
destination_secret=""
credential_payload=""
cleanup_sensitive() {
  unset destination_key destination_secret credential_payload EXPECTED_PUBLIC_KEY
}
trap cleanup_sensitive EXIT

for destination in "$SSM_KEY_PARAMETER" "$SSM_SECRET_PARAMETER"; do
  parameter_type=$(aws ssm get-parameter \
    --name "$destination" \
    --query 'Parameter.Type' \
    --output text 2>/dev/null || true)
  if [ "$parameter_type" != "SecureString" ]; then
    echo "::error::reused credential destination is absent or not SecureString: $destination"
    exit 1
  fi
done

destination_key=$(aws ssm get-parameter \
  --name "$SSM_KEY_PARAMETER" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text 2>/dev/null || true)
destination_secret=$(aws ssm get-parameter \
  --name "$SSM_SECRET_PARAMETER" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text 2>/dev/null || true)

# Mask immediately after capture, before any comparison or network operation.
mask "$EXPECTED_PUBLIC_KEY"
mask "$destination_key"
mask "$destination_secret"

if [ -z "$destination_key" ] || [ -z "$destination_secret" ]; then
  echo "::error::reused credential destination could not be decrypted; rotate explicitly"
  exit 1
fi
if [ "$destination_key" != "$EXPECTED_PUBLIC_KEY" ]; then
  echo "::error::stored service public key does not match the exact reused credential; rotate explicitly"
  exit 1
fi

credential_payload=$(jq -nc \
  --arg apiKey "$destination_key" \
  --arg apiSecret "$destination_secret" \
  '{apiKey:$apiKey,apiSecret:$apiSecret}')

if ! http_status=$(printf '%s' "$credential_payload" | curl \
  --silent \
  --show-error \
  --connect-timeout 5 \
  --max-time 20 \
  --request POST \
  --header 'content-type: application/json' \
  --data-binary @- \
  --output /dev/null \
  --write-out '%{http_code}' \
  "$SERVICE_TOKEN_URL"); then
  cleanup_sensitive
  echo "::error::could not authenticate the stored service credential; reuse is refused and explicit rotation is required"
  exit 1
fi

cleanup_sensitive
if [ "$http_status" != "200" ]; then
  echo "::error::stored service credential did not authenticate (HTTP $http_status); rotate explicitly"
  exit 1
fi

trap - EXIT
echo "reused exact service credential is recoverable and authenticates successfully"
