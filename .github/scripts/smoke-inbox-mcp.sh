#!/usr/bin/env bash

set -euo pipefail

MCP_ORIGIN="${MCP_ORIGIN:-https://mcp.inbox.oxy.so}"
OXY_OAUTH_ORIGIN="${OXY_OAUTH_ORIGIN:-https://api.oxy.so}"
OXY_AUTHORIZATION_ENDPOINT="${OXY_AUTHORIZATION_ENDPOINT:-https://auth.oxy.so/authorize}"

MCP_ORIGIN="${MCP_ORIGIN%/}"
OXY_OAUTH_ORIGIN="${OXY_OAUTH_ORIGIN%/}"
OXY_AUTHORIZATION_ENDPOINT="${OXY_AUTHORIZATION_ENDPOINT%/}"
RESOURCE_METADATA_URL="$MCP_ORIGIN/.well-known/oauth-protected-resource"

smoke_dir="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
smoke_dir="$(realpath "$smoke_dir")"

cleanup_smoke_dir() {
  if [[ "$smoke_dir" == "$temporary_root/"* && -d "$smoke_dir" ]]; then
    rm -rf -- "$smoke_dir"
  else
    echo "::warning::Refusing to remove unexpected smoke directory: $smoke_dir"
  fi
}
trap cleanup_smoke_dir EXIT

fetch_json() {
  local output_file="$1"
  local url="$2"
  curl \
    --fail \
    --silent \
    --show-error \
    --max-time 20 \
    --retry 8 \
    --retry-delay 5 \
    --retry-all-errors \
    --output "$output_file" \
    "$url"
}

capture_response() {
  local name="$1"
  shift
  curl \
    --silent \
    --show-error \
    --max-time 20 \
    --retry 8 \
    --retry-delay 5 \
    --retry-all-errors \
    --max-redirs 0 \
    --dump-header "$smoke_dir/$name.headers" \
    --output "$smoke_dir/$name.body" \
    --write-out '%{http_code}' \
    "$@"
}

fetch_json \
  "$smoke_dir/authorization-server.json" \
  "$OXY_OAUTH_ORIGIN/.well-known/oauth-authorization-server"

if ! jq -e \
  --arg issuer "$OXY_OAUTH_ORIGIN" \
  --arg authorization_endpoint "$OXY_AUTHORIZATION_ENDPOINT" \
  '
    .issuer == $issuer and
    .authorization_endpoint == $authorization_endpoint and
    .token_endpoint == ($issuer + "/auth/mcp/oauth/token") and
    .registration_endpoint == ($issuer + "/auth/mcp/oauth/register") and
    .revocation_endpoint == ($issuer + "/auth/mcp/oauth/revoke") and
    .jwks_uri == ($issuer + "/auth/mcp/oauth/jwks") and
    (.grant_types_supported | index("authorization_code") != null) and
    (.grant_types_supported | index("refresh_token") != null) and
    (.code_challenge_methods_supported == ["S256"]) and
    .resource_parameter_supported == true
  ' "$smoke_dir/authorization-server.json" >/dev/null; then
  echo "::error::Oxy MCP authorization-server metadata is incomplete or points at the wrong endpoint."
  exit 1
fi

fetch_json "$smoke_dir/protected-resource.json" "$RESOURCE_METADATA_URL"

if ! jq -e \
  --arg resource "$MCP_ORIGIN" \
  --arg issuer "$OXY_OAUTH_ORIGIN" \
  '
    .resource == $resource and
    .authorization_servers == [$issuer] and
    .bearer_methods_supported == ["header"] and
    ((.scopes_supported | sort) == ["email.organize", "email.read", "email.send"])
  ' "$smoke_dir/protected-resource.json" >/dev/null; then
  echo "::error::Inbox protected-resource metadata does not match its canonical catalog and OAuth authority."
  exit 1
fi

challenge_status="$(capture_response challenge "$MCP_ORIGIN/mcp")"
if [[ "$challenge_status" != "401" ]]; then
  echo "::error::Inbox MCP unauthenticated endpoint returned HTTP $challenge_status (expected 401)."
  exit 1
fi
if ! tr -d '\r' <"$smoke_dir/challenge.headers" \
  | grep -i '^www-authenticate: *Bearer ' \
  | grep -Fqi "resource_metadata=\"$RESOURCE_METADATA_URL\""; then
  echo "::error::Inbox MCP 401 is missing its exact protected-resource metadata challenge."
  exit 1
fi

invalid_status="$(capture_response \
  invalid-token \
  --request POST \
  --header 'Authorization: Bearer invalid-production-smoke-token' \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":"smoke","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"inbox-production-smoke","version":"1.0.0"}}}' \
  "$MCP_ORIGIN/mcp")"
if [[ "$invalid_status" != "401" ]]; then
  echo "::error::Inbox MCP accepted or mishandled an inactive token with HTTP $invalid_status (expected 401)."
  exit 1
fi
if ! tr -d '\r' <"$smoke_dir/invalid-token.headers" \
  | grep -Fqi 'www-authenticate: Bearer error="invalid_token"'; then
  echo "::error::Inbox MCP inactive-token response is missing the OAuth invalid_token challenge."
  exit 1
fi

cross_host_status="$(capture_response cross-host "$OXY_OAUTH_ORIGIN/mcp")"
if [[ "$cross_host_status" != "421" ]]; then
  echo "::error::Inbox MCP resource-host isolation returned HTTP $cross_host_status (expected 421)."
  exit 1
fi

echo "Inbox MCP and central OAuth post-deploy smoke checks passed."
