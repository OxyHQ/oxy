#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"

worker_service="oxy-asset-variant-worker"
worker_container="oxy-asset-variant-worker"
service_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$worker_service")"
if [[ "$(jq -r '.services[0].status // "NONE"' <<<"$service_json")" != "ACTIVE" ]]; then
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
if [[ "$(jq -c --arg name "$worker_container" '.containerDefinitions[] | select(.name == $name) | .command' <<<"$task_definition")" != '["node","packages/api/dist/asset-variant-worker.js"]' ]]; then
  echo "::error::worker task definition has an unexpected command"
  exit 1
fi

rendered_task_definition="$(jq \
  --arg name "$worker_container" \
  --arg image "$IMAGE_URI" \
  --arg queue_redis_url "arn:aws:ssm:us-west-2:237343248947:parameter/oxy/_shared/QUEUE_REDIS_URL" '
  del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)
  | .containerDefinitions |= map(
      if .name == $name then
        .image = $image
        | .secrets = ((.secrets // [] | map(select(.name != "QUEUE_REDIS_URL"))) + [{
            name: "QUEUE_REDIS_URL",
            valueFrom: $queue_redis_url
          }])
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

for attempt in $(seq 1 40); do
  stable_json="$(aws ecs describe-services --cluster "$CLUSTER" --services "$worker_service")"
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
  if jq -e --arg task "$new_task_definition" '
    any(.services[0].deployments[]; .taskDefinition == $task and .rolloutState == "FAILED")
  ' <<<"$stable_json" >/dev/null; then
    echo "::error::asset-variant worker deployment failed"
    jq '.services[0] | {deployments, events: .events[0:10]}' <<<"$stable_json"
    exit 1
  fi
  echo "Worker rollout not yet exact (${attempt}/40); waiting."
  sleep 15
done

echo "::error::asset-variant worker did not reach the exact stable revision"
jq '.services[0] | {desiredCount, runningCount, pendingCount, deployments, events: .events[0:10]}' <<<"$stable_json"
exit 1
