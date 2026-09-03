#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 7 ]; then
  echo "usage: $0 CLUSTER SERVICE SERVICE_TASK_DEFINITION SERVICE_CONTAINER BOOTSTRAP_TASK_DEFINITION BOOTSTRAP_CONTAINER IMMUTABLE_IMAGE" >&2
  exit 64
fi

cluster="$1"
service="$2"
expected_service_task_definition="$3"
service_container="$4"
expected_bootstrap_task_definition="$5"
bootstrap_container="$6"
expected_image="$7"
confirm_delay_seconds="${KAANA_ROLLOUT_CONFIRM_DELAY_SECONDS:-5}"

fail() {
  echo "kaana catalogue rollout attestation: $*" >&2
  exit 1
}

[[ "$cluster" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || fail 'cluster is not an exact ECS short name'
[[ "$service" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || fail 'service is not an exact ECS short name'
[[ "$service_container" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || fail 'service container is invalid'
[[ "$bootstrap_container" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || fail 'bootstrap container is invalid'
[[ "$expected_service_task_definition" =~ ^arn:[^:]+:ecs:[^:]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ]] || fail 'service task definition ARN is invalid'
[[ "$expected_bootstrap_task_definition" =~ ^arn:[^:]+:ecs:[^:]+:[0-9]{12}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ]] || fail 'bootstrap task definition ARN is invalid'
[[ "$expected_image" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] || fail 'image must be an immutable digest URI'
[[ "$confirm_delay_seconds" =~ ^[0-9]+$ ]] || fail 'confirmation delay must be a non-negative integer'

scratch_directory="$(mktemp -d)"
trap 'rm -rf "$scratch_directory"' EXIT

capture_snapshot() {
  local label="$1"
  local service_file="$scratch_directory/${label}-service.json"
  local list_file="$scratch_directory/${label}-list.json"
  local tasks_file="$scratch_directory/${label}-tasks.json"
  local service_json desired running pending primary_count old_count list_count task_count exact_count

  aws ecs describe-services \
    --cluster "$cluster" \
    --services "$service" \
    --output json >"$service_file"
  service_json="$(<"$service_file")"

  [ "$(jq '(.failures // []) | length' <<<"$service_json")" -eq 0 ] \
    || fail "$label service read returned failures"
  [ "$(jq '(.services // []) | length' <<<"$service_json")" -eq 1 ] \
    || fail "$label service read did not return exactly one service"
  [ "$(jq -r '.services[0].status // ""' <<<"$service_json")" = ACTIVE ] \
    || fail "$label service is not ACTIVE"
  [ "$(jq -r '.services[0].taskDefinition // ""' <<<"$service_json")" = "$expected_service_task_definition" ] \
    || fail "$label service task definition changed"

  desired="$(jq -er '.services[0].desiredCount' <<<"$service_json")"
  running="$(jq -er '.services[0].runningCount' <<<"$service_json")"
  pending="$(jq -er '.services[0].pendingCount' <<<"$service_json")"
  [[ "$desired" =~ ^[1-9][0-9]*$ ]] || fail "$label desired count is not positive"
  [ "$running" -eq "$desired" ] || fail "$label running count does not equal desired count"
  [ "$pending" -eq 0 ] || fail "$label service still has pending tasks"

  primary_count="$(jq --arg task_definition "$expected_service_task_definition" '
    [.services[0].deployments[]? |
      select(.taskDefinition == $task_definition and .status == "PRIMARY" and
        .rolloutState == "COMPLETED" and .runningCount == .desiredCount and .pendingCount == 0)] |
    length
  ' <<<"$service_json")"
  [ "$primary_count" -eq 1 ] || fail "$label primary rollout is not uniquely COMPLETED"
  old_count="$(jq --arg task_definition "$expected_service_task_definition" '
    [.services[0].deployments[]? | select(.taskDefinition != $task_definition) |
      ((.runningCount // 0) + (.pendingCount // 0))] | add // 0
  ' <<<"$service_json")"
  [ "$old_count" -eq 0 ] || fail "$label still has old deployment tasks"

  aws ecs list-tasks \
    --cluster "$cluster" \
    --service-name "$service" \
    --desired-status RUNNING \
    --output json >"$list_file"
  list_count="$(jq '(.taskArns // []) | length' "$list_file")"
  [ "$list_count" -eq "$desired" ] || fail "$label RUNNING task list does not equal desired count"
  [ "$(jq '[.taskArns[]?] | unique | length' "$list_file")" -eq "$desired" ] \
    || fail "$label RUNNING task list contains duplicate task ARNs"

  mapfile -t task_arns < <(jq -er '.taskArns[]' "$list_file")
  aws ecs describe-tasks \
    --cluster "$cluster" \
    --tasks "${task_arns[@]}" \
    --output json >"$tasks_file"
  [ "$(jq '(.failures // []) | length' "$tasks_file")" -eq 0 ] \
    || fail "$label task read returned failures"
  task_count="$(jq '(.tasks // []) | length' "$tasks_file")"
  [ "$task_count" -eq "$desired" ] || fail "$label task read did not return every RUNNING task"
  [ "$(jq -c '(.taskArns // []) | sort' "$list_file")" = "$(jq -c '[.tasks[]?.taskArn] | sort' "$tasks_file")" ] \
    || fail "$label described task identities differ from the RUNNING task list"
  exact_count="$(jq --arg task_definition "$expected_service_task_definition" '
    [.tasks[]? | select(.lastStatus == "RUNNING" and .desiredStatus == "RUNNING" and
      .taskDefinitionArn == $task_definition)] | length
  ' "$tasks_file")"
  [ "$exact_count" -eq "$desired" ] || fail "$label includes an old or non-RUNNING task"

  jq -nc \
    --arg taskDefinitionArn "$expected_service_task_definition" \
    --argjson desiredCount "$desired" \
    --slurpfile taskList "$list_file" \
    '{taskDefinitionArn:$taskDefinitionArn,desiredCount:$desiredCount,taskArns:($taskList[0].taskArns | sort)}'
}

before_snapshot="$(capture_snapshot before)"
sleep "$confirm_delay_seconds"
after_snapshot="$(capture_snapshot after)"

[ "$(jq -r '.taskDefinitionArn' <<<"$before_snapshot")" = "$(jq -r '.taskDefinitionArn' <<<"$after_snapshot")" ] \
  || fail 'service task definition changed between rollout observations'

service_task_file="$scratch_directory/service-task-definition.json"
bootstrap_task_file="$scratch_directory/bootstrap-task-definition.json"
aws ecs describe-task-definition \
  --task-definition "$expected_service_task_definition" \
  --query taskDefinition \
  --output json >"$service_task_file"
aws ecs describe-task-definition \
  --task-definition "$expected_bootstrap_task_definition" \
  --query taskDefinition \
  --output json >"$bootstrap_task_file"

validate_task_image() {
  local label="$1"
  local file="$2"
  local expected_task_definition="$3"
  local container="$4"
  [ "$(jq -r '.taskDefinitionArn // ""' "$file")" = "$expected_task_definition" ] \
    || fail "$label task definition identity changed"
  [ "$(jq -r '.status // ""' "$file")" = ACTIVE ] || fail "$label task definition is not ACTIVE"
  [ "$(jq --arg container "$container" '[.containerDefinitions[]? | select(.name == $container)] | length' "$file")" -eq 1 ] \
    || fail "$label task definition does not contain exactly one expected container"
  [ "$(jq -r --arg container "$container" '.containerDefinitions[] | select(.name == $container) | .image' "$file")" = "$expected_image" ] \
    || fail "$label task definition does not use the attested immutable image"
}

validate_task_image service "$service_task_file" "$expected_service_task_definition" "$service_container"
validate_task_image bootstrap "$bootstrap_task_file" "$expected_bootstrap_task_definition" "$bootstrap_container"

account_id="$(cut -d: -f5 <<<"$expected_bootstrap_task_definition")"
[ "$(jq '(.containerDefinitions // []) | length' "$bootstrap_task_file")" -eq 1 ] \
  || fail 'bootstrap task definition must contain exactly one container'
jq -e \
  --arg task_role "arn:aws:iam::${account_id}:role/oxy-kaana-catalogue-bootstrap" \
  --arg execution_role "arn:aws:iam::${account_id}:role/oxy-ecs-execution" \
  --arg container "$bootstrap_container" '
    .taskRoleArn == $task_role and
    .executionRoleArn == $execution_role and
    .networkMode == "awsvpc" and
    .requiresCompatibilities == ["FARGATE"] and
    .cpu == "512" and .memory == "1024" and
    .runtimePlatform.cpuArchitecture == "ARM64" and
    .runtimePlatform.operatingSystemFamily == "LINUX" and
    (.containerDefinitions[0] |
      .name == $container and .essential == true and
      .command == ["bun","run","packages/api/scripts/bootstrap-kaana-catalogue.ts"] and
      .logConfiguration.logDriver == "awslogs" and
      ([.secrets[]?.name] == ["DATABASE_URL"]) and
      ([.environment[]?.name] | index("AWS_ACCESS_KEY_ID") | not) and
      ([.environment[]?.name] | index("AWS_SECRET_ACCESS_KEY") | not) and
      ([.environment[]?.name] | index("AWS_SESSION_TOKEN") | not))
  ' "$bootstrap_task_file" >/dev/null \
  || fail 'bootstrap task definition does not match the dedicated least-authority configuration'

attested_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
jq -nc \
  --arg cluster "$cluster" \
  --arg service "$service" \
  --arg serviceTaskDefinitionArn "$expected_service_task_definition" \
  --arg bootstrapTaskDefinitionArn "$expected_bootstrap_task_definition" \
  --arg image "$expected_image" \
  --arg attestedAt "$attested_at" \
  --argjson serviceState "$after_snapshot" \
  '{cluster:$cluster,service:$service,serviceTaskDefinitionArn:$serviceTaskDefinitionArn,
    bootstrapTaskDefinitionArn:$bootstrapTaskDefinitionArn,image:$image,attestedAt:$attestedAt,
    serviceState:$serviceState}'
