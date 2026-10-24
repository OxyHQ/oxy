#!/usr/bin/env bash
# Cases for smoke-updates-signing.sh against recorded responses signed by a
# throwaway keypair: a valid signed directive passes; unsigned, wrongly signed,
# tampered and 503 responses fail.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" \
  -days 2 -subj '/CN=smoke-test' >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/other-key.pem" -out "$work/other-cert.pem" \
  -days 2 -subj '/CN=smoke-other' >/dev/null 2>&1

# make_case <dir> <status> <signing key or "none"> [tamper]
make_case() {
  local dir="$1" status="$2" key="$3" tamper="${4:-}"
  mkdir -p "$dir"
  local part='{"type":"noUpdateAvailable"}'
  printf '%s' "$part" > "$dir/part"
  local sig_header=''
  if [[ "$key" != none ]]; then
    local sig
    sig="$(openssl dgst -sha256 -sign "$key" "$dir/part" | base64 -w0)"
    sig_header="expo-signature: sig=\"$sig\", keyid=\"main\""$'\r\n'
  fi
  [[ -n "$tamper" ]] && part='{"type":"rollBackToEmbedded"}'
  printf 'HTTP/2 %s\r\ncontent-type: multipart/mixed; boundary=b0\r\n\r\n' "$status" > "$dir/headers"
  printf -- '--b0\r\nContent-Disposition: form-data; name="directive"\r\nContent-Type: application/json\r\n%s\r\n%s\r\n--b0--\r\n' \
    "$sig_header" "$part" > "$dir/body"
}

run_case() {
  UPDATES_SMOKE_RESPONSE_DIR="$1" UPDATES_SMOKE_CERTIFICATE="$work/cert.pem" \
    bash "$here/smoke-updates-signing.sh" >/dev/null 2>&1
}

failures=0
expect() {
  local name="$1" want="$2" dir="$3"
  if run_case "$dir"; then got=0; else got=1; fi
  if [[ "$got" != "$want" ]]; then
    echo "FAIL: $name (exit $got, wanted $want)"
    failures=$((failures + 1))
  fi
}

make_case "$work/valid" 200 "$work/key.pem"
make_case "$work/unsigned" 200 none
make_case "$work/foreign" 200 "$work/other-key.pem"
make_case "$work/tampered" 200 "$work/key.pem" tamper
make_case "$work/unavailable" 503 "$work/key.pem"

expect 'signed by the ecosystem key' 0 "$work/valid"
expect 'unsigned part' 1 "$work/unsigned"
expect 'signed by another key' 1 "$work/foreign"
expect 'tampered after signing' 1 "$work/tampered"
expect 'HTTP 503 (no key bound)' 1 "$work/unavailable"

if [[ "$failures" -gt 0 ]]; then
  exit 1
fi
echo "smoke-updates-signing.sh discriminated 5 cases."
