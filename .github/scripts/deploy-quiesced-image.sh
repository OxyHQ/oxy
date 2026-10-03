#!/usr/bin/env bash
# Manual/main maintenance cutover; the ordinary image/provenance gates remain in the workflow.
set -euo pipefail
export DEPLOY_SHA="${GITHUB_SHA:?Manual main Actions source is required}"
node .github/scripts/guard-quiesced-deploy.mjs --validate-input
QUIESCED_DEPLOY_PLAN_PATH="$(mktemp)"
export QUIESCED_DEPLOY_PLAN_PATH
trap 'rm -f -- "$QUIESCED_DEPLOY_PLAN_PATH"' EXIT
printf '%s' "$QUIESCED_DEPLOY_PLAN_JSON" >"$QUIESCED_DEPLOY_PLAN_PATH"
export INTERNAL_METRICS_PARAMETER=''
export TASK_ENV_OVERRIDES_JSON='{}'
export TASK_SECRET_OVERRIDES_JSON='{}'
export TASK_REMOVE_NAMES_JSON='[]'
export TASK_EXTRA_CONTAINERS_JSON='[]'
export RUN_MIGRATIONS=true
# Catalogue writes are reviewed separately after authority and consumer cutover.
# Preserve any required post-DDL from the canonical planner, without running Inbox registration.
export POST_DEPLOY_TASKS_JSON="$(jq -c '
  map(select(.command == ["node", "packages/api/dist/db/migrate.js", "--phase=post"]))
' <<<"${POST_DEPLOY_TASKS_JSON:-[]}")"
export POST_DEPLOY_TASK_COMMAND_JSON=''
export POST_DEPLOY_TASKS_CONCURRENT=false
export PRE_DEPLOY_TASK_COMMAND_JSON=''
export PRE_ROLLOUT_SCRIPT=.github/scripts/deploy-asset-variant-worker.sh
export WORKER_ROLLOUT_PHASE=start
export POST_DEPLOY_SMOKE_SCRIPT=.github/scripts/smoke-oxy-api.sh
bash .github/scripts/deploy-ecs-image.sh
