#!/usr/bin/env bash
set -euo pipefail
: "${DEPLOY_SHA:?DEPLOY_SHA is required}"
[[ "$DEPLOY_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$(git rev-parse HEAD)" == "$DEPLOY_SHA" ]]
[[ "$(git ls-remote --exit-code origin refs/heads/main | cut -f1)" == "$DEPLOY_SHA" ]]
echo "Current protected main matches the deployment source."
