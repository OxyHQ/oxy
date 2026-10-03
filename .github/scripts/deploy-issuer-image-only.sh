#!/usr/bin/env bash
# Root-reviewed manual issuer stage; keep existing live configuration and rollback helper.
set -euo pipefail
node .github/scripts/guard-issuer-image-only.mjs
export RUN_MIGRATIONS=false
export INTERNAL_METRICS_PARAMETER=''
export PRE_DEPLOY_TASK_COMMAND_JSON=''
export POST_DEPLOY_TASK_COMMAND_JSON=''
export POST_DEPLOY_TASKS_JSON='[]'
export POST_DEPLOY_TASKS_CONCURRENT=false
export PRE_ROLLOUT_SCRIPT=''
export TASK_ENV_OVERRIDES_JSON='{}'
export TASK_SECRET_OVERRIDES_JSON='{}'
export TASK_REMOVE_NAMES_JSON='[]'
export TASK_EXTRA_CONTAINERS_JSON='[]'
# Public metadata, JWKS and unauthenticated Inbox rejection checks; no catalog registration.
export POST_DEPLOY_SMOKE_SCRIPT=.github/scripts/smoke-oxy-api.sh
bash .github/scripts/deploy-ecs-image.sh
