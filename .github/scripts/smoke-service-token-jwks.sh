#!/usr/bin/env bash
#
# The service-token key set a deploy just put in front of every verifier
# (ADR 0012). Verifiers cache it for five minutes and refuse every service token
# when it is empty or unusable, so a bad key set is an authentication outage for
# every Oxy service — the one time it happened (`{"keys":[]}`) it existed in no
# log on either side. Checked after every rollout; any failure rolls back.
#
# Asserts: HTTP 200, a public cache header, a non-empty set of Ed25519 signing
# keys, unique kids, and ONLY the public members — a `d` (or anything else a
# private or foreign key would carry) fails the deploy before a scraper sees it.

set -euo pipefail

OXY_API_ORIGIN="${OXY_API_ORIGIN:-https://api.oxy.so}"
JWKS_URL="${OXY_API_ORIGIN%/}/.well-known/jwks.json"

work_dir="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
work_dir="$(realpath "$work_dir")"

cleanup_work_dir() {
  if [[ "$work_dir" == "$temporary_root/"* && -d "$work_dir" ]]; then
    rm -rf -- "$work_dir"
  else
    echo "::warning::Refusing to remove unexpected smoke directory: $work_dir"
  fi
}
trap cleanup_work_dir EXIT

status="$(
  curl \
    --silent \
    --show-error \
    --max-time 20 \
    --retry 8 \
    --retry-delay 5 \
    --retry-all-errors \
    --max-redirs 0 \
    --dump-header "$work_dir/jwks.headers" \
    --output "$work_dir/jwks.json" \
    --write-out '%{http_code}' \
    "$JWKS_URL"
)"

if [[ "$status" != "200" ]]; then
  echo "::error::$JWKS_URL answered HTTP $status; service-token verifiers cannot refresh their keys."
  exit 1
fi

if ! grep -qiE '^cache-control:.*public.*max-age=[0-9]+' "$work_dir/jwks.headers"; then
  echo "::error::$JWKS_URL is not publicly cacheable; verifiers would refetch it on every cold key."
  exit 1
fi

if ! jq -e '
  (.keys | type == "array" and length > 0) and
  ([.keys[].kid] | length == (unique | length)) and
  all(.keys[];
    (keys == (["alg", "crv", "kid", "kty", "use", "x"])) and
    .kty == "OKP" and
    .crv == "Ed25519" and
    .use == "sig" and
    .alg == "EdDSA" and
    (.kid | type == "string" and test("^[A-Za-z0-9._-]{1,128}$")) and
    (.x | type == "string" and test("^[A-Za-z0-9_-]{43}$"))
  )
' "$work_dir/jwks.json" >/dev/null 2>&1; then
  echo "::error::$JWKS_URL is empty, malformed, or carries a member a public Ed25519 signing key must not have."
  exit 1
fi

echo "Service-token JWKS OK: $(jq -r '[.keys[].kid] | join(", ")' "$work_dir/jwks.json")"
