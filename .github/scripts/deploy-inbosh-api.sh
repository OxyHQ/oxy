#!/usr/bin/env bash
# Rolls inbosh-api (the email backend of inbo.sh: the oxy-api image started with
# OXY_API_ROLE=inbosh) onto the image oxy-api is deploying. Same two phases as
# deploy-asset-variant-worker.sh, but it runs AFTER the oxy-api rollout: nothing
# in oxy-api depends on this service, and a problem here must not hold the
# oxy-api rollout back.
#
#   start  Register a revision from the one the service RUNS, with the new image,
#          and repoint the service. Return at once.
#   wait   When the service wants tasks, require the exact steady state on that
#          revision: one COMPLETED deployment, every task running.
#
# The service is created by oxy-infra (terraform-uswest2/app-inbosh-api.tf) and
# stays at 0 tasks until the infra's inbosh_api_desired_count says otherwise. At 0
# tasks a rollout is only a new revision, so `wait` has nothing to wait for.
#
# Never pass --desired-count: Terraform owns it, and a deploy that set it would
# fight the infra. Everything but the image (environment, secrets, command, size)
# is carried forward from the running revision.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${CLUSTER:?CLUSTER is required}"
: "${IMAGE_URI:?IMAGE_URI is required}"

phase="${1:-}"
if [[ "$phase" != "start" && "$phase" != "wait" ]]; then
  echo "::error::usage: deploy-inbosh-api.sh start|wait"
  exit 1
fi

service="inbosh-api"
container="inbosh-api"
attempts="${INBOSH_ROLLOUT_ATTEMPTS:-120}"
poll_seconds="${INBOSH_ROLLOUT_POLL_SECONDS:-5}"

describe_service() {
  aws ecs describe-services --cluster "$CLUSTER" --services "$service"
}

service_json="$(describe_service)"
if [[ "$(jq '.failures | length' <<<"$service_json")" != "0" ]] ||
   [[ "$(jq -r '.services[0].status // "NONE"' <<<"$service_json")" != "ACTIVE" ]]; then
  echo "ECS service $service is not ACTIVE - nothing to roll"
  exit 0
fi

if [[ "$phase" == "start" ]]; then
  current_task_definition="$(jq -er '.services[0].taskDefinition' <<<"$service_json")"
  task_definition="$(aws ecs describe-task-definition \
    --task-definition "$current_task_definition" \
    --query taskDefinition)"
  if [[ "$(jq --arg name "$container" '[.containerDefinitions[] | select(.name == $name)] | length' <<<"$task_definition")" != "1" ]]; then
    echo "::error::$service task definition must contain exactly one $container container"
    exit 1
  fi
  if [[ "$(jq -r --arg name "$container" '.containerDefinitions[] | select(.name == $name) | (.environment // [])[] | select(.name == "OXY_API_ROLE") | .value' <<<"$task_definition")" != "inbosh" ]]; then
    echo "::error::$service task definition does not run with OXY_API_ROLE=inbosh; refusing to put the full API on it"
    exit 1
  fi

  rendered_task_definition="$(jq --arg name "$container" --arg image "$IMAGE_URI" '
    del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy)
    | .containerDefinitions |= map(if .name == $name then .image = $image else . end)
  ' <<<"$task_definition")"
  new_task_definition="$(aws ecs register-task-definition \
    --cli-input-json "$rendered_task_definition" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)"

  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$service" \
    --task-definition "$new_task_definition" \
    >/dev/null
  echo "$service now points at $new_task_definition"
  exit 0
fi

# phase == wait
if [[ "$(jq '.services[0].desiredCount' <<<"$service_json")" == "0" ]]; then
  echo "$service wants no tasks; its new revision needs no rollout"
  exit 0
fi

new_task_definition="$(jq -er '.services[0].taskDefinition' <<<"$service_json")"
running_image="$(aws ecs describe-task-definition \
  --task-definition "$new_task_definition" \
  --query "taskDefinition.containerDefinitions[?name=='$container'] | [0].image" \
  --output text)"
if [[ "$running_image" != "$IMAGE_URI" ]]; then
  echo "::error::$service runs $new_task_definition with image $running_image, not $IMAGE_URI"
  jq '.services[0] | {deployments, events: .events[0:10]}' <<<"$service_json"
  exit 1
fi

for attempt in $(seq 1 "$attempts"); do
  stable_json="$(describe_service)"
  if jq -e --arg task "$new_task_definition" '
    .services[0] as $service
    | $service.taskDefinition == $task
      and $service.runningCount == $service.desiredCount
      and $service.pendingCount == 0
      and ($service.deployments | length) == 1
      and $service.deployments[0].status == "PRIMARY"
      and $service.deployments[0].rolloutState == "COMPLETED"
  ' <<<"$stable_json" >/dev/null; then
    echo "$service is stable at $new_task_definition"
    exit 0
  fi
  if jq -e --arg task "$new_task_definition" 'any(.services[0].deployments[]; .taskDefinition == $task and .rolloutState == "FAILED")' <<<"$stable_json" >/dev/null; then
    echo "::error::$service deployment failed"
    jq '.services[0] | {deployments, events: .events[0:10]}' <<<"$stable_json"
    exit 1
  fi
  echo "$service rollout not yet exact (${attempt}/${attempts}); waiting."
  sleep "$poll_seconds"
done
echo "::error::$service did not reach the exact stable revision"
jq '.services[0] | {desiredCount, runningCount, pendingCount, deployments, events: .events[0:10]}' <<<"$stable_json"
exit 1
