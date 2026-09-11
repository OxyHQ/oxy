#!/usr/bin/env bash

# Install one already-minted service credential pair from a durable SecureString
# recovery package. The package remains the source of truth until BOTH destination
# parameters authenticate together, so a failed second write is repaired by
# replaying this exact package rather than by trying to recover a database secret.

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: handoff-service-credential-pair.sh <key-parameter> <secret-parameter>" >&2
  exit 2
fi

key_parameter="$1"
secret_parameter="$2"
package=$(</dev/stdin)
public_key=$(jq -er '.publicKey' <<<"$package")
secret=$(jq -er '.secret' <<<"$package")

cleanup_sensitive() {
  unset package public_key secret payload
}
trap cleanup_sensitive EXIT

if [[ ! "$public_key" =~ ^oxy_dk_[0-9a-f]{48}$ ]] || [[ ! "$secret" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::credential recovery package contains invalid material"
  exit 1
fi
echo "::add-mask::$public_key"
echo "::add-mask::$secret"

# Public key is the commit marker. If its write fails, replay writes the same
# secret again and then advances the key; no new database credential is minted.
printf '%s' "$secret" | bash .github/scripts/put-secure-parameter.sh \
  "$secret_parameter" overwrite
printf '%s' "$public_key" | bash .github/scripts/put-secure-parameter.sh \
  "$key_parameter" overwrite

payload=$(jq -nc --arg apiKey "$public_key" --arg apiSecret "$secret" \
  '{apiKey:$apiKey,apiSecret:$apiSecret}')
http_status=$(printf '%s' "$payload" | curl \
  --silent --show-error --connect-timeout 5 --max-time 20 \
  --request POST --header 'content-type: application/json' --data-binary @- \
  --output /dev/null --write-out '%{http_code}' \
  'https://api.oxy.so/auth/service-token')
if [ "$http_status" != "200" ]; then
  echo "::error::installed service credential pair did not authenticate (HTTP $http_status)"
  exit 1
fi

cleanup_sensitive
trap - EXIT
echo "service credential pair installed and authenticated"
