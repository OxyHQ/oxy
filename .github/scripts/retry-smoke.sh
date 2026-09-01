#!/usr/bin/env bash
#
# Run a post-deploy smoke gate against the LIVE host, retrying while the
# Cloudflare edge propagates.
#
# A Pages deploy returns before every edge node serves the new build, so a gate
# that ran exactly once would go red on timing rather than on the thing it
# measures. The retry is not leniency: the gate still has to pass, and a deploy
# that is genuinely broken fails all five attempts and exits non-zero. Nothing
# here suppresses a failure — only a slow edge is forgiven.
#
# Run from the app package directory (the workflow step's `working-directory`),
# because `bun run <script>` resolves against that package's manifest.
#
# Usage:
#   "$GITHUB_WORKSPACE/.github/scripts/retry-smoke.sh" smoke:csp 'CSP smoke' 'the message'

set -uo pipefail

script="${1:?bun script name required}"
label="${2:?attempt label required}"
message="${3:?failure message required}"

ATTEMPTS=5
DELAY_SECONDS=15

for attempt in $(seq 1 "${ATTEMPTS}"); do
  echo "::group::${label} attempt ${attempt}/${ATTEMPTS}"
  if bun run "${script}"; then
    echo "::endgroup::"
    exit 0
  fi
  echo "::endgroup::"
  if [ "${attempt}" -lt "${ATTEMPTS}" ]; then
    echo "Smoke gate failed (edge may still be propagating); retrying in ${DELAY_SECONDS}s..."
    sleep "${DELAY_SECONDS}"
  fi
done

echo "::error::${message}"
exit 1
