#!/usr/bin/env bash
# Rolls oxy-asset-variant-worker (the BullMQ consumer of `asset-variants`) onto
# the image oxy-api is deploying, in two phases:
#
#   start  Register a revision from the one the worker RUNS, repoint the service,
#          and return once every new consumer is RUNNING and ECS has scaled the
#          old deployment to zero (so each old consumer has been told to stop,
#          and on SIGTERM `stopAssetVariantWorker` stops fetching jobs).
#          deploy-ecs-image.sh runs this as oxy-api's PRE_ROLLOUT_SCRIPT: after
#          the pre-deploy migration, before the API moves. That keeps the order
#          the worker needs — schema first, consumer before producer — without
#          waiting for the old consumers' shutdown tail.
#   wait   Require the exact steady state: the new revision, one COMPLETED
#          deployment, every autoscaled task running. The workflow runs this
#          after the API rollout; by then it has usually been true for minutes.
#
# Before 2026-09-29 the whole rollout ran serially AFTER the API and its
# post-deploy tasks, on every deploy, because the "one-time asset queue
# cutover" detector's JMESPath could never match (see deploy-aws.yml). That
# cost ~370s per deploy (run 36505794567: 01:29:10 -> 01:35:20).
#
# Never pass --desired-count: Application Auto Scaling owns the worker's count
# (1..4), and a deploy that set it would fight the scaler.
# scripts/check-asset-worker-rollout.mjs holds this file to that.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"

phase="${1:-${WORKER_ROLLOUT_PHASE:-}}"
if [[ "$phase" != "start" && "$phase" != "wait" ]]; then
  echo "::error::usage: deploy-asset-variant-worker.sh start|wait (or WORKER_ROLLOUT_PHASE)"
  exit 1
fi

worker_service="oxy-asset-variant-worker"
worker_container="oxy-asset-variant-worker"
# 120 x 5 s: the same 600 s budget as the 40 x 15 s it replaced, observed at
# 5 s so neither phase overshoots the state it waits for by up to 15 s.
attempts="${WORKER_ROLLOUT_ATTEMPTS:-120}"
poll_seconds="${WORKER_ROLLOUT_POLL_SECONDS:-5}"

describe_worker() {
  aws ecs describe-services --cluster "$CLUSTER" --services "$worker_service"
}

fail_if_rollout_failed() {
  local task="$1" stable_json="$2"
  if jq -e --arg task "$task" '
    any(.services[0].deployments[]; .taskDefinition == $task and .rolloutState == "FAILED")
  ' <<<"$stable_json" >/dev/null; then
    echo "::error::asset-variant worker deployment failed"
    jq '.services[0] | {deployments, events: .events[0:10]}' <<<"$stable_json"
    exit 1
  fi
}

if [[ "$phase" == "start" ]]; then
  service_json="$(describe_worker)"
  if [[ "$(jq '.failures | length' <<<"$service_json")" != "0" ]] ||
     [[ "$(jq -r '.services[0].status // "NONE"' <<<"$service_json")" != "ACTIVE" ]]; then
    echo "::error::asset-variant worker service is not ACTIVE"
    exit 1
  fi

  current_task_definition="$(jq -er '.services[0].taskDefinition' <<<"$service_json")"
  task_definition="$(aws ecs describe-task-definition \
    --task-definition "$current_task_definition" \
    --query taskDefinition)"
  if [[ "$(jq --arg name "$worker_container" '[.containerDefinitions[] | select(.name == $name)] | length' <<<"$task_definition")" != "1" ]]; then
    echo "::error::worker task definition must contain exactly one $worker_container container"
    exit 1
  fi
  # The running revision may name `node` (every revision before the API moved
  # to a Bun image) or `bun`; anything else is refused. The revision rendered
  # below always names `bun`: the image is Bun's, and its `node` is only a
  # symlink to bun. A revert of that move still deploys, because the accepting
  # half landed first.
  worker_command="$(jq -c --arg name "$worker_container" '.containerDefinitions[] | select(.name == $name) | .command' <<<"$task_definition")"
  if [[ "$worker_command" != '["bun","packages/api/dist/asset-variant-worker.js"]' &&
        "$worker_command" != '["node","packages/api/dist/asset-variant-worker.js"]' ]]; then
    echo "::error::worker task definition has an unexpected command: $worker_command"
    exit 1
  fi

  # QUEUE_REDIS_URL is re-asserted, not introduced: every worker revision since
  # oxy-oxy-asset-variant-worker:10 (2026-09-12) carries it. The render carries
  # forward whatever the running revision binds, so this keeps the binding from
  # depending on nobody ever registering a revision without it.
  #
  # The object store is re-asserted the same way: the worker reads originals
  # and writes renditions in Oxy Files' R2 bucket with oxy-api's bucket token,
  # and purges what it deletes from cloud.oxy.so (ADR 0047). The parameters
  # exist before this line names them (oxy-infra runbook 61); a binding to a
  # missing one registers fine and then cannot START.
  ssm="arn:aws:ssm:us-west-2:237343248947:parameter"
  rendered_task_definition="$(jq \
    --arg name "$worker_container" \
    --arg image "$IMAGE_URI" \
    --argjson secrets "$(jq -n --arg ssm "$ssm" '[
      {name: "QUEUE_REDIS_URL", valueFrom: "\($ssm)/oxy/_shared/QUEUE_REDIS_URL"},
      {name: "R2_ACCESS_KEY_ID", valueFrom: "\($ssm)/oxy/oxy-api/R2_ACCESS_KEY_ID"},
      {name: "R2_SECRET_ACCESS_KEY", valueFrom: "\($ssm)/oxy/oxy-api/R2_SECRET_ACCESS_KEY"},
      {name: "CLOUDFLARE_CACHE_PURGE_TOKEN", valueFrom: "\($ssm)/oxy/oxy-api/CLOUDFLARE_CACHE_PURGE_TOKEN"}
    ]')" \
    --argjson environment '[
      {"name": "R2_BUCKET", "value": "oxy-files"},
      {"name": "R2_ENDPOINT", "value": "https://fa4392797e57d4e63ceaaf7b1dc687ed.r2.cloudflarestorage.com"},
      {"name": "CLOUDFLARE_ZONE_ID", "value": "7f70358609578c4a1f24dbf6cb9c4498"}
    ]' '
    del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)
    | ($secrets | map(.name)) as $secretNames
    | ($environment | map(.name)) as $environmentNames
    # Oxy Files left S3 for R2 (ADR 0047): AWS_S3_BUCKET leaves the worker.
    | ["AWS_S3_BUCKET"] as $retiredNames
    | .containerDefinitions |= map(
        if .name == $name then
          .image = $image
          | .command = ["bun", "packages/api/dist/asset-variant-worker.js"]
          | .secrets = ((.secrets // [] | map(select(.name as $n | $secretNames | index($n) | not))) + $secrets)
          | .environment = ((.environment // [] | map(select(.name as $n | ($environmentNames + $retiredNames) | index($n) | not))) + $environment)
        else . end
      )
  ' <<<"$task_definition")"
  new_task_definition="$(aws ecs register-task-definition \
    --cli-input-json "$rendered_task_definition" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)"

  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$worker_service" \
    --task-definition "$new_task_definition" \
    --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true},minimumHealthyPercent=100,maximumPercent=200' \
    >/dev/null
  echo "Asset-variant worker rolling to $new_task_definition"

  for attempt in $(seq 1 "$attempts"); do
    stable_json="$(describe_worker)"
    # Consumers replaced: the new deployment has every task it wants RUNNING,
    # and every other deployment has been scaled to zero by ECS (its tasks are
    # stopping, no longer fetching). The old tasks' shutdown and ECS's
    # COMPLETED bookkeeping are left to the `wait` phase.
    if jq -e --arg task "$new_task_definition" '
      .services[0] as $service
      | $service.taskDefinition == $task
        and ([$service.deployments[] | select(.status == "PRIMARY")] | length) == 1
        and ($service.deployments[] | select(.status == "PRIMARY") | .taskDefinition == $task
              and .desiredCount > 0
              and .runningCount == .desiredCount)
        and all($service.deployments[] | select(.status != "PRIMARY"); .desiredCount == 0)
    ' <<<"$stable_json" >/dev/null; then
      echo "Asset-variant worker consumers replaced at $new_task_definition; the API may move."
      exit 0
    fi
    fail_if_rollout_failed "$new_task_definition" "$stable_json"
    echo "Worker consumers not yet replaced (${attempt}/${attempts}); waiting."
    sleep "$poll_seconds"
  done
  echo "::error::asset-variant worker consumers were not replaced in time; oxy-api was not updated"
  jq '.services[0] | {desiredCount, runningCount, pendingCount, deployments, events: .events[0:10]}' <<<"$stable_json"
  exit 1
fi

# phase == wait: the exact steady state, on the revision `start` registered.
# That revision is identified by what the service now runs AND by its image,
# so a worker that a circuit breaker quietly returned to the previous revision
# can never pass.
service_json="$(describe_worker)"
new_task_definition="$(jq -er '.services[0].taskDefinition' <<<"$service_json")"
running_image="$(aws ecs describe-task-definition \
  --task-definition "$new_task_definition" \
  --query "taskDefinition.containerDefinitions[?name=='$worker_container'] | [0].image" \
  --output text)"
if [[ "$running_image" != "$IMAGE_URI" ]]; then
  echo "::error::asset-variant worker runs $new_task_definition with image $running_image, not $IMAGE_URI"
  jq '.services[0] | {deployments, events: .events[0:10]}' <<<"$service_json"
  exit 1
fi

for attempt in $(seq 1 "$attempts"); do
  stable_json="$(describe_worker)"
  if jq -e --arg task "$new_task_definition" '
    .services[0] as $service
    | $service.taskDefinition == $task
      and $service.desiredCount > 0
      and $service.runningCount == $service.desiredCount
      and $service.pendingCount == 0
      and ($service.deployments | length) == 1
      and $service.deployments[0].status == "PRIMARY"
      and $service.deployments[0].rolloutState == "COMPLETED"
  ' <<<"$stable_json" >/dev/null; then
    echo "Asset-variant worker is stable at $new_task_definition"
    exit 0
  fi
  fail_if_rollout_failed "$new_task_definition" "$stable_json"
  echo "Worker rollout not yet exact (${attempt}/${attempts}); waiting."
  sleep "$poll_seconds"
done

echo "::error::asset-variant worker did not reach the exact stable revision"
jq '.services[0] | {desiredCount, runningCount, pendingCount, deployments, events: .events[0:10]}' <<<"$stable_json"
exit 1
