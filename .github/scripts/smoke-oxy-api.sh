#!/usr/bin/env bash
#
# Post-deploy smoke for oxy-api: the service-token key set first (a failure
# there is this image's, so it rolls back), then the Inbox MCP checks, whose
# exit code — including their "a rollback cannot fix this" code — passes through
# to deploy-ecs-image.sh unchanged.

set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$script_directory/smoke-service-token-jwks.sh"
exec bash "$script_directory/smoke-inbox-mcp.sh"
