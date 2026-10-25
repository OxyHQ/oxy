#!/usr/bin/env bash
#
# Oxy Updates serves only SIGNED manifests (services/updates/signing.service.ts).
# After every rollout, ask for Commons' production manifest the way a binary
# WITHOUT the certificate would (no expo-expect-signature) and require:
# HTTP 200 (a 503 means the signing key is not bound), and a signed part whose
# `expo-signature` verifies against the committed ecosystem certificate
# (packages/app-preset/certs/oxy-updates-code-signing.pem), keyid "main",
# RSA-SHA256. Any failure rolls back: a deploy that cannot sign serves nothing.

set -euo pipefail

OXY_API_ORIGIN="${OXY_API_ORIGIN:-https://api.oxy.so}"
# Commons' registered client id (public; packages/commons/constants/oxy.ts).
UPDATES_SMOKE_CLIENT_ID="${UPDATES_SMOKE_CLIENT_ID:-oxy_dk_f65326da2a0d106bf98e873ce19b0ca9094d6c0c1f845a18}"
MANIFEST_URL="${OXY_API_ORIGIN%/}/updates/v1/apps/${UPDATES_SMOKE_CLIENT_ID}/manifest"

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTIFICATE="${UPDATES_SMOKE_CERTIFICATE:-$script_directory/../../packages/app-preset/certs/oxy-updates-code-signing.pem}"

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

if [[ -n "${UPDATES_SMOKE_RESPONSE_DIR:-}" ]]; then
  # Test seam: a recorded response (headers + body) instead of the network.
  cp "$UPDATES_SMOKE_RESPONSE_DIR/headers" "$work_dir/headers"
  cp "$UPDATES_SMOKE_RESPONSE_DIR/body" "$work_dir/body"
  status="$(head -n 1 "$work_dir/headers" | tr -d '\r' | awk '{print $2}')"
else
  status="$(
    curl \
      --silent \
      --show-error \
      --max-time 20 \
      --retry 8 \
      --retry-delay 5 \
      --retry-all-errors \
      --max-redirs 0 \
      --header 'expo-protocol-version: 1' \
      --header 'expo-platform: android' \
      --header 'expo-runtime-version: 0.0.0-smoke' \
      --header 'expo-channel-name: production' \
      --dump-header "$work_dir/headers" \
      --output "$work_dir/body" \
      --write-out '%{http_code}' \
      "$MANIFEST_URL"
  )"
fi

if [[ "$status" != "200" ]]; then
  echo "::error::$MANIFEST_URL answered HTTP $status; Oxy Updates is not serving signed manifests (is UPDATES_CODE_SIGNING_PRIVATE_KEY bound?)."
  exit 1
fi

openssl x509 -in "$CERTIFICATE" -noout -pubkey > "$work_dir/public.pem"

# Split the multipart body; write the first manifest/directive part's exact bytes
# and its signature, decoded, for openssl.
python3 - "$work_dir" <<'PY'
import base64, re, sys
work = sys.argv[1]
headers = open(f"{work}/headers", "rb").read().decode("latin-1")
match = re.search(r"(?im)^content-type:\s*multipart/mixed;\s*boundary=([^\r\n;]+)", headers)
if not match:
    sys.exit("::error::the manifest response is not multipart/mixed")
boundary = match.group(1).strip().strip('"').encode()
body = open(f"{work}/body", "rb").read()
for raw in body.split(b"--" + boundary)[1:-1]:
    raw = raw[2:] if raw.startswith(b"\r\n") else raw
    head, _, content = raw.partition(b"\r\n\r\n")
    if content.endswith(b"\r\n"):
        content = content[:-2]
    head = head.decode("latin-1")
    if not re.search(r'name="(manifest|directive)"', head):
        continue
    sig = re.search(r'(?im)^expo-signature:\s*sig="([^"]+)",\s*keyid="([^"]+)"\s*$', head)
    if not sig:
        sys.exit("::error::a signable part carries no expo-signature: the server served it UNSIGNED")
    if sig.group(2) != "main":
        sys.exit(f"::error::unexpected signing keyid {sig.group(2)!r}")
    open(f"{work}/part", "wb").write(content)
    open(f"{work}/part.sig", "wb").write(base64.b64decode(sig.group(1)))
    sys.exit(0)
sys.exit("::error::the response has no manifest or directive part")
PY

if ! openssl dgst -sha256 -verify "$work_dir/public.pem" -signature "$work_dir/part.sig" "$work_dir/part" >/dev/null; then
  echo "::error::the manifest signature does not verify against packages/app-preset/certs/oxy-updates-code-signing.pem: the bound key is not the ecosystem key."
  exit 1
fi
echo "Oxy Updates: signed response verified against the ecosystem certificate."
