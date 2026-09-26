#!/usr/bin/env bash
#
# Drives smoke-service-token-jwks.sh against a fake curl: the healthy key set
# passes, and every shape a verifier cannot use — or must never see — fails.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* && -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

mkdir -p "$test_directory/bin"

# The fake answers with FAKE_STATUS, FAKE_CACHE_CONTROL and FAKE_BODY, and
# records the URL it was asked for.
cat >"$test_directory/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
output_file=""
header_file=""
url=""
while (($# > 0)); do
  case "$1" in
    --output) output_file="$2"; shift 2 ;;
    --dump-header) header_file="$2"; shift 2 ;;
    --write-out | --max-time | --retry | --retry-delay | --max-redirs) shift 2 ;;
    --silent | --show-error | --retry-all-errors) shift ;;
    http://* | https://*) url="$1"; shift ;;
    *) echo "Unexpected fake curl argument: $1" >&2; exit 2 ;;
  esac
done
printf '%s\n' "$url" >"$FAKE_URL_LOG"
printf 'HTTP/2 %s\r\ncache-control: %s\r\n\r\n' "$FAKE_STATUS" "$FAKE_CACHE_CONTROL" >"$header_file"
printf '%s' "$FAKE_BODY" >"$output_file"
printf '%s' "$FAKE_STATUS"
FAKE_CURL
chmod +x "$test_directory/bin/curl"

good_key='{"kty":"OKP","crv":"Ed25519","x":"LPjteWFxEUwKO0Kqv-DKx1nF4pRz9Kp2t-Bapj_bdaw","use":"sig","alg":"EdDSA","kid":"oxy-service-2026-09-17"}'
next_key='{"kty":"OKP","crv":"Ed25519","x":"AAjteWFxEUwKO0Kqv-DKx1nF4pRz9Kp2t-Bapj_bdaw","use":"sig","alg":"EdDSA","kid":"oxy-service-2026-10-01"}'

failures=0

run_case() {
  local expectation="$1" label="$2" body="$3" status="${4:-200}" cache="${5:-public, max-age=300, must-revalidate}"
  local exit_code=0
  PATH="$test_directory/bin:$PATH" \
    TMPDIR="$test_directory" \
    FAKE_URL_LOG="$test_directory/url.log" \
    FAKE_STATUS="$status" \
    FAKE_CACHE_CONTROL="$cache" \
    FAKE_BODY="$body" \
    OXY_API_ORIGIN="https://api.example.test/" \
    bash "$repository_root/.github/scripts/smoke-service-token-jwks.sh" >/dev/null 2>&1 || exit_code=$?
  if [[ "$expectation" == pass && $exit_code -ne 0 ]] || [[ "$expectation" == fail && $exit_code -eq 0 ]]; then
    echo "FAIL: $label (expected $expectation, exit $exit_code)" >&2
    failures=$((failures + 1))
  else
    echo "ok: $label"
  fi
}

run_case pass 'the live shape: one Ed25519 signing key' "{\"keys\":[$good_key]}"
run_case pass 'a rotation window: two keys' "{\"keys\":[$good_key,$next_key]}"
if [[ "$(cat "$test_directory/url.log")" != "https://api.example.test/.well-known/jwks.json" ]]; then
  echo "FAIL: fetched $(cat "$test_directory/url.log")" >&2
  failures=$((failures + 1))
fi

run_case fail 'an empty key set' '{"keys":[]}'
run_case fail 'no keys member' '{}'
run_case fail 'not JSON' 'not json'
run_case fail 'a private member (d)' "{\"keys\":[${good_key%\}},\"d\":\"secret\"}]}"
run_case fail 'an extra member' "{\"keys\":[${good_key%\}},\"x5u\":\"https://attacker.example\"}]}"
run_case fail 'a symmetric key' '{"keys":[{"kty":"oct","k":"c2VjcmV0","use":"sig","alg":"HS256","kid":"legacy"}]}'
run_case fail 'the wrong algorithm' "{\"keys\":[${good_key/EdDSA/RS256}]}"
run_case fail 'the wrong use' "{\"keys\":[${good_key/\"sig\"/\"enc\"}]}"
run_case fail 'a short public key' "{\"keys\":[${good_key/LPjteWFx/LP}]}"
run_case fail 'a duplicate kid' "{\"keys\":[$good_key,$good_key]}"
run_case fail 'a kid with unsafe characters' "{\"keys\":[${good_key/oxy-service-2026-09-17/..\/etc passwd}]}"
run_case fail 'an HTTP 503' "{\"keys\":[$good_key]}" 503
run_case fail 'a non-cacheable response' "{\"keys\":[$good_key]}" 200 'no-store'

if ((failures > 0)); then
  echo "$failures smoke-service-token-jwks case(s) failed" >&2
  exit 1
fi
echo "smoke-service-token-jwks: all cases passed"
