#!/usr/bin/env bash
# Run only the already-deployed identity reconciler, never build or deploy an image.
set -euo pipefail
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || { echo 'Protected main required' >&2; exit 1; }
[[ "${GITHUB_REF_PROTECTED:-}" == true ]] || { echo 'Protected ref required' >&2; exit 1; }
[[ "${EXPECTED_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected full source SHA required' >&2; exit 1; }
[[ "$EXPECTED_SOURCE_SHA" == "${GITHUB_SHA:-}" ]] || { echo 'Workflow source must match deployed source' >&2; exit 1; }
[[ "${DRY_RUN:-true}" == true || "${DRY_RUN:-true}" == false ]] || exit 1
cursor="${AFTER_CURSOR:-}"
if [[ -n "$cursor" ]] && { [[ ${#cursor} -gt 2048 ]] || ! [[ "$cursor" =~ ^(https://|did:)[a-zA-Z0-9:/._%@+-]+$ ]]; }; then
  echo 'Invalid source cursor' >&2; exit 1
fi
readonly cluster=oxy-cluster service=oxy-api repository=oxy/oxy-api
readonly registry=237343248947.dkr.ecr.us-west-2.amazonaws.com
export AWS_DEFAULT_REGION=us-west-2
export AWS_PAGER=''
report_dir=identity-reconciliation-report
mkdir -p "$report_dir"
scratch=$(mktemp -d)
task_arn='' transient_definition='' log_group='' log_stream='' logs_collected=false
collect_logs() {
  [[ -n "$log_group" && -n "$log_stream" ]] || return 1
  local token='' next page page_count=0
  : > "$report_dir/task.log"
  while :; do
    page_count=$((page_count + 1))
    [[ "$page_count" -le 1000 ]] || return 1
    local args=(logs get-log-events --log-group-name "$log_group" --log-stream-name "$log_stream" --start-from-head --output json)
    [[ -z "$token" ]] || args+=(--next-token "$token")
    page=$(aws "${args[@]}" --cli-connect-timeout 5 --cli-read-timeout 15) || return 1
    jq -r '.events[].message' <<< "$page" >> "$report_dir/task.log"
    next=$(jq -r '.nextForwardToken // empty' <<< "$page")
    [[ -n "$next" && "$next" != "$token" ]] || break
    token=$next
  done
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$task_arn" ]]; then
    aws ecs stop-task --cluster "$cluster" --task "$task_arn" --reason 'Identity reconciliation workflow cleanup' >/dev/null 2>&1 || true
  fi
  if [[ -n "$transient_definition" ]]; then
    aws ecs deregister-task-definition --task-definition "$transient_definition" >/dev/null 2>&1 || true
  fi
  if [[ -n "$task_arn" ]] && ! $logs_collected; then collect_logs || true; fi
  rm -rf -- "$scratch"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
aws ecs describe-services --cluster "$cluster" --services "$service" --output json > "$scratch/service.json"
jq -e '.failures | length == 0' "$scratch/service.json" >/dev/null
jq -e '.services | length == 1 and .[0].status == "ACTIVE" and .[0].desiredCount > 0 and .[0].runningCount == .[0].desiredCount and .[0].pendingCount == 0 and (.[0].deployments | length == 1 and .[0].rolloutState == "COMPLETED")' "$scratch/service.json" >/dev/null
live_definition=$(jq -r '.services[0].taskDefinition' "$scratch/service.json")
aws ecs describe-task-definition --task-definition "$live_definition" --query taskDefinition --output json > "$scratch/live.json"
readonly container=oxy-api
jq -e --arg name "$container" '[.containerDefinitions[] | select(.name == $name and .essential != false)] | length == 1' "$scratch/live.json" >/dev/null
image=$(jq -r --arg name "$container" '.containerDefinitions[] | select(.name == $name) | .image' "$scratch/live.json")
[[ "$image" == "$registry/$repository:"* || "$image" == "$registry/$repository@sha256:"* ]] || { echo 'Unexpected deployed repository' >&2; exit 1; }
digest=$(aws ecr batch-get-image --repository-name "$repository" --image-ids "imageTag=$EXPECTED_SOURCE_SHA" --query 'images[0].imageId.imageDigest' --output text)
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
aws ecs list-tasks --cluster "$cluster" --service-name "$service" --desired-status RUNNING --output json > "$scratch/task-list.json"
mapfile -t live_tasks < <(jq -r '.taskArns[]' "$scratch/task-list.json")
[[ ${#live_tasks[@]} -gt 0 && ${#live_tasks[@]} -le 100 ]] || exit 1
jq -e --argjson count "${#live_tasks[@]}" ' .services[0].desiredCount == $count' "$scratch/service.json" >/dev/null
aws ecs describe-tasks --cluster "$cluster" --tasks "${live_tasks[@]}" --output json > "$scratch/live-tasks.json"
jq -e --arg definition "$live_definition" --arg digest "$digest" --arg name "$container" --argjson count "${#live_tasks[@]}" '.failures | length == 0' "$scratch/live-tasks.json" >/dev/null
jq -e --arg definition "$live_definition" --arg digest "$digest" --arg name "$container" --argjson count "${#live_tasks[@]}" '.tasks | length == $count and all(.[]; .taskDefinitionArn == $definition and .lastStatus == "RUNNING" and ([.containers[] | select(.name == $name and .imageDigest == $digest)] | length == 1))' "$scratch/live-tasks.json" >/dev/null
# Pin the live image digest; a mutable deployment tag cannot swap the task's code.
jq --arg name "$container" --arg image "$registry/$repository@$digest" '(.containerDefinitions[] | select(.name == $name) | .image) = $image | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)' "$scratch/live.json" > "$scratch/run.json"
transient_definition=$(aws ecs register-task-definition --cli-input-json "file://$scratch/run.json" --query taskDefinition.taskDefinitionArn --output text)
[[ "$transient_definition" == arn:aws:ecs:*:task-definition/* ]] || exit 1
# BusyBox and GNU timeout share these short flags. Even without StopTask IAM,
# termination is enforced inside the essential container after 90 minutes plus 30 seconds.
command=$(jq -nc --arg dry "${DRY_RUN:-true}" --arg cursor "$cursor" '["busybox","timeout","-s","TERM","-k","30","5400","bun","run","packages/api/scripts/reconcile-external-identities.ts"] + (if $dry == "false" then ["--apply"] else [] end) + (if $cursor != "" then ["--after=" + $cursor] else [] end)')
overrides=$(jq -nc --arg name "$container" --argjson command "$command" '{containerOverrides:[{name:$name,command:$command}]}')
network=$(jq -c '.services[0].networkConfiguration' "$scratch/service.json")
for attempt in $(seq 1 31); do
  aws ecs run-task --cluster "$cluster" --task-definition "$transient_definition" --launch-type FARGATE --network-configuration "$network" --overrides "$overrides" --started-by gh-identity-reconciliation --output json > "$scratch/run-result.json"
  task_arn=$(jq -r '.tasks[0].taskArn // empty' "$scratch/run-result.json")
  [[ -z "$task_arn" ]] || break
  jq -e '.failures | length > 0 and all(.[]; .reason == "RESOURCE:CPU" or ((.reason // "") | ascii_downcase | contains("limit on the number of vcpus")))' "$scratch/run-result.json" >/dev/null || { echo 'ECS refused task' >&2; exit 1; }
  [[ "$attempt" -lt 31 ]] || { echo 'Fargate capacity timeout' >&2; exit 1; }
  sleep 20
done
log_group=$(jq -r --arg name "$container" '.containerDefinitions[] | select(.name == $name) | .logConfiguration.options["awslogs-group"] // empty' "$scratch/live.json")
log_prefix=$(jq -r --arg name "$container" '.containerDefinitions[] | select(.name == $name) | .logConfiguration.options["awslogs-stream-prefix"] // empty' "$scratch/live.json")
log_stream="$log_prefix/$container/${task_arn##*/}"
jq -n --arg sha "$EXPECTED_SOURCE_SHA" --arg digest "$digest" --arg task "$task_arn" --argjson dry "${DRY_RUN:-true}" '{expectedSourceSha:$sha,imageDigest:$digest,taskArn:$task,dryRun:$dry}' > "$report_dir/run.json"
# ECS waiter is deliberately bounded (~100 minutes total).
for attempt in $(seq 1 10); do
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn" && break
  [[ "$attempt" -lt 10 ]] || { echo 'Task completion timeout' >&2; exit 1; }
done
aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --output json > "$scratch/completed.json"
jq --arg name "$container" '{failures, tasks:[.tasks[] | {taskArn,lastStatus,stopCode,stoppedReason,containers:[.containers[] | select(.name == $name) | {name,exitCode,reason}]}]}' "$scratch/completed.json" > "$report_dir/result.json"
jq -e --arg name "$container" '.failures | length == 0' "$scratch/completed.json" >/dev/null

collect_logs
logs_collected=true
jq -Rsc '[split("\n")[] | fromjson? | select(has("visited") and has("refused"))] | last' "$report_dir/task.log" > "$report_dir/summary.json"
jq -e 'type == "object"' "$report_dir/summary.json" >/dev/null || { echo 'Missing reconciliation summary in task logs' >&2; exit 1; }

jq -e --arg name "$container" '.tasks | length == 1 and .[0].lastStatus == "STOPPED" and ([.[0].containers[] | select(.name == $name and .exitCode == 0)] | length == 1)' "$scratch/completed.json" >/dev/null
