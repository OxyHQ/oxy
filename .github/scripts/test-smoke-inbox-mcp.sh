#!/usr/bin/env bash

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

cat >"$test_directory/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail

output_file=""
header_file=""
write_out=""
authorization=""
url=""

while (($# > 0)); do
  case "$1" in
    --output | --dump-header | --write-out | --header | --request | --data | --max-time | --retry | --retry-delay)
      option="$1"
      value="$2"
      shift 2
      case "$option" in
        --output) output_file="$value" ;;
        --dump-header) header_file="$value" ;;
        --write-out) write_out="$value" ;;
        --header)
          if [[ "$value" == Authorization:* ]]; then
            authorization="$value"
          fi
          ;;
      esac
      ;;
    --fail | --silent | --show-error | --retry-all-errors | --max-redirs)
      if [[ "$1" == "--max-redirs" ]]; then
        shift 2
      else
        shift
      fi
      ;;
    http://* | https://*)
      url="$1"
      shift
      ;;
    *)
      echo "Unexpected fake curl argument: $1" >&2
      exit 2
      ;;
  esac
done

status=200
headers='Content-Type: application/json'
body='{}'

case "$url" in
  https://api.oxy.test/.well-known/oauth-authorization-server)
    methods='["S256"]'
    if [[ "${BROKEN_CASE:-}" == "missing-s256" ]]; then
      methods='[]'
    fi
    body="{\"issuer\":\"https://api.oxy.test\",\"authorization_endpoint\":\"https://auth.oxy.test/authorize\",\"token_endpoint\":\"https://api.oxy.test/auth/mcp/oauth/token\",\"registration_endpoint\":\"https://api.oxy.test/auth/mcp/oauth/register\",\"revocation_endpoint\":\"https://api.oxy.test/auth/mcp/oauth/revoke\",\"jwks_uri\":\"https://api.oxy.test/auth/mcp/oauth/jwks\",\"grant_types_supported\":[\"authorization_code\",\"refresh_token\"],\"code_challenge_methods_supported\":$methods,\"resource_parameter_supported\":true}"
    ;;
  https://mcp.inbox.oxy.test/.well-known/oauth-protected-resource)
    resource='https://mcp.inbox.oxy.test'
    if [[ "${BROKEN_CASE:-}" == "wrong-resource" ]]; then
      resource='https://mcp.noted.oxy.test'
    fi
    body="{\"resource\":\"$resource\",\"authorization_servers\":[\"https://api.oxy.test\"],\"bearer_methods_supported\":[\"header\"],\"scopes_supported\":[\"email.send\",\"email.organize\",\"email.read\"]}"
    ;;
  https://mcp.inbox.oxy.test/mcp)
    status=401
    if [[ -z "$authorization" ]]; then
      headers='WWW-Authenticate: Bearer realm="inbox-mcp", resource_metadata="https://mcp.inbox.oxy.test/.well-known/oauth-protected-resource"'
      if [[ "${BROKEN_CASE:-}" == "missing-challenge" ]]; then
        headers='Content-Type: application/json'
      fi
    else
      headers='WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://mcp.inbox.oxy.test/.well-known/oauth-protected-resource"'
      if [[ "${BROKEN_CASE:-}" == "inactive-token-accepted" ]]; then
        status=200
      fi
    fi
    ;;
  https://api.oxy.test/mcp)
    status=421
    if [[ "${BROKEN_CASE:-}" == "cross-host-accepted" ]]; then
      status=401
    fi
    ;;
  *)
    echo "Unexpected fake curl URL: $url" >&2
    exit 2
    ;;
esac

if [[ -n "$header_file" ]]; then
  printf 'HTTP/2 %s\r\n%s\r\n\r\n' "$status" "$headers" >"$header_file"
fi
if [[ -n "$output_file" ]]; then
  printf '%s' "$body" >"$output_file"
else
  printf '%s' "$body"
fi
if [[ -n "$write_out" ]]; then
  printf '%s' "$status"
fi
FAKE_CURL
chmod +x "$test_directory/bin/curl"

run_smoke() {
  env \
    PATH="$test_directory/bin:$PATH" \
    MCP_ORIGIN=https://mcp.inbox.oxy.test \
    OXY_OAUTH_ORIGIN=https://api.oxy.test \
    OXY_AUTHORIZATION_ENDPOINT=https://auth.oxy.test/authorize \
    BROKEN_CASE="${1:-}" \
    bash "$repository_root/.github/scripts/smoke-inbox-mcp.sh"
}

run_smoke >"$test_directory/success.log"
grep -F 'Inbox MCP and central OAuth post-deploy smoke checks passed.' \
  "$test_directory/success.log" >/dev/null

for broken_case in \
  missing-s256 \
  wrong-resource \
  missing-challenge \
  inactive-token-accepted \
  cross-host-accepted; do
  if run_smoke "$broken_case" >"$test_directory/$broken_case.log" 2>&1; then
    echo "Smoke gate accepted broken fixture: $broken_case" >&2
    exit 1
  fi
done

echo "Inbox MCP smoke gate fixture tests passed."
