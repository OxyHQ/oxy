#!/usr/bin/env bash
# Read-only by default. Explicit stop_completed only targets a verified finished scan.
# The task selector comes from a trusted workflow artifact, never arbitrary input.
set -euo pipefail
[[ "${GITHUB_REF:-}" == refs/heads/main && "${GITHUB_REF_PROTECTED:-}" == true ]] || exit 1
[[ "${EXPECTED_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${EXPECTED_IMAGE_DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
readonly cluster=oxy-cluster container=oxy-api
readonly registry=237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api
export AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_MAX_ATTEMPTS=2
report_dir=identity-reconciliation-report
jq -e --arg sha "$EXPECTED_SOURCE_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" '
  .expectedSourceSha == $sha and .imageDigest == $digest
  and (.operation == "reconcile" or .operation == "inspect_cache")
  and (.dryRun | type == "boolean")
  and (.taskArn | test("^arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/[0-9a-f]{32}$"))
' "$report_dir/run.json" >/dev/null
mode=$(jq -r .operation "$report_dir/run.json")
task_arn=$(jq -r .taskArn "$report_dir/run.json")
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
aws_read() { aws "$@" --cli-connect-timeout 5 --cli-read-timeout 15; }
read_task() {
  aws_read ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" --output json > "$scratch/task.json"
  jq -e --arg task "$task_arn" --arg digest "$EXPECTED_IMAGE_DIGEST" --arg name "$container" '
    (.failures | length == 0) and (.tasks | length == 1)
    and .tasks[0].taskArn == $task and .tasks[0].startedBy == "gh-identity-reconciliation"
    and (.tasks[0].taskDefinitionArn | test("^arn:aws:ecs:us-west-2:237343248947:task-definition/[A-Za-z0-9_-]+:[0-9]+$"))
    and ([.tasks[0].containers[] | select(.name == $name and (.imageDigest == $digest or .imageDigest == null))] | length == 1)
    and (if .tasks[0].lastStatus == "RUNNING" or .tasks[0].lastStatus == "STOPPED" then ([.tasks[0].containers[] | select(.name == $name and .imageDigest == $digest)] | length == 1) else true end)
  ' "$scratch/task.json" >/dev/null
  jq --arg name "$container" '{failures, tasks:[.tasks[] | {taskArn,taskDefinitionArn,lastStatus,createdAt,startedAt,stoppingAt,stoppedAt,stopCode,stoppedReason,containers:[.containers[] | select(.name == $name) | {name,imageDigest,exitCode,reason}]}]}' "$scratch/task.json" > "$report_dir/result.json"
}
read_task
initial_definition=$(jq -r '.tasks[0].taskDefinitionArn' "$scratch/task.json")
aws_read ecs describe-task-definition --task-definition "$initial_definition" --query taskDefinition --output json > "$scratch/definition.json"
jq -e --arg name "$container" --arg image "$registry@$EXPECTED_IMAGE_DIGEST" --arg definition "$initial_definition" '
  .taskDefinitionArn == $definition and ([.containerDefinitions[] | select(.name == $name and .image == $image)] | length == 1)
' "$scratch/definition.json" >/dev/null
log_group=$(jq -er --arg name "$container" '.containerDefinitions[] | select(.name == $name) | .logConfiguration.options["awslogs-group"] | select(length > 0)' "$scratch/definition.json")
log_prefix=$(jq -er --arg name "$container" '.containerDefinitions[] | select(.name == $name) | .logConfiguration.options["awslogs-stream-prefix"] | select(length > 0)' "$scratch/definition.json")
log_stream="$log_prefix/$container/${task_arn##*/}"
# A workflow phase returns before credentials expire, then the official action
# obtains a new OIDC session. Recovery takes a snapshot without waiting at all.
collection_mode=${COLLECTION_MODE:-wait}
[[ "$collection_mode" == wait || "$collection_mode" == snapshot || "$collection_mode" == stop_completed ]] || exit 1
phase_deadline=$((SECONDS + 2100))
if [[ "$collection_mode" == wait ]]; then
  while [[ "$(jq -r '.tasks[0].lastStatus' "$scratch/task.json")" != STOPPED && "$SECONDS" -lt "$phase_deadline" ]]; do
    sleep 15
    read_task
    [[ "$(jq -r '.tasks[0].taskDefinitionArn' "$scratch/task.json")" == "$initial_definition" ]] || exit 1
  done
fi
stopped=false
[[ "$(jq -r '.tasks[0].lastStatus' "$scratch/task.json")" != STOPPED ]] || stopped=true
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "stopped=$stopped" >> "$GITHUB_OUTPUT"; fi
# A pending phase retains sanitized status. The next phase continues this task;
# it cannot launch another one. A recovery snapshot also collects current logs.
if [[ "$stopped" != true && "$collection_mode" == wait ]]; then exit 0; fi
for attempt in 1 2 3 4 5; do
  token=''
  : > "$report_dir/task.log"
  for ((page=0; page<1000; page++)); do
    args=(logs get-log-events --log-group-name "$log_group" --log-stream-name "$log_stream" --start-from-head --output json)
    [[ -z "$token" ]] || args+=(--next-token "$token")
    aws_read "${args[@]}" > "$scratch/page.json"
    jq -r '.events[].message' "$scratch/page.json" >> "$report_dir/task.log"
    next=$(jq -r '.nextForwardToken // empty' "$scratch/page.json")
    [[ -n "$next" && "$next" != "$token" ]] || break
    token=$next
  done
  [[ "$page" -lt 1000 ]] || { echo 'CloudWatch paging bound exceeded; logs incomplete' >&2; exit 1; }
  if [[ "$mode" == inspect_cache ]]; then
    jq -Rsc --arg sha "$EXPECTED_SOURCE_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" '[split("\n")[] | fromjson? | select(.operation == "inspect_cache" and .sourceSha == $sha and .imageDigest == $digest and (.absent | type == "boolean") and (.counts | type == "object"))] | last' "$report_dir/task.log" > "$report_dir/summary.json"
  else
    jq -Rsc '[split("\n")[] | fromjson? | select(has("visited") and has("refused") and .operation != "inspect_cache")] | last' "$report_dir/task.log" > "$report_dir/summary.json"
  fi
  jq -e 'type == "object"' "$report_dir/summary.json" >/dev/null && break
  [[ "$stopped" == true && "$attempt" -lt 5 ]] || break
  sleep 2
done
if [[ "$collection_mode" == stop_completed ]]; then
  # Only a complete, single full-scan report can authorize stopping this exact
  # standalone task. An inspector, partial log or resumed cursor is insufficient.
  [[ "$mode" == reconcile ]] || exit 1
  jq -e '(.afterCursor // "") == ""' "$report_dir/run.json" >/dev/null
  jq -Rsec --slurpfile run "$report_dir/run.json" '
    [split("\n")[] | fromjson?] as $rows
    | [$rows[] | select(has("visited") and has("refused"))] as $summaries
    | ($summaries | length == 1) and ($summaries[0] as $s
      | $s.apply == ($run[0].dryRun | not)
      and ([$s.visited,$s.changed,$s.refused,$s.pending] | all(.[]; type == "number" and . >= 0 and floor == .))
      and ($s.after | type == "string" and startswith("https://"))
      and $s.changed <= $s.visited and $s.refused <= $s.visited and $s.pending <= $s.visited
      and ([$rows[] | select(has("actorUri") and (.state == "refused" or .state == "canonicalized" or .state == "transport_identity_retained"))] | length == $s.visited)
      and ([$rows[] | select(has("visited") or has("state"))] | last == $s))
  ' "$report_dir/task.log" >/dev/null
  # Re-read immediately before mutation and reject service tasks, changed
  # definitions or a running service using this supposedly transient definition.
  read_task
  [[ "$(jq -r '.tasks[0].taskDefinitionArn' "$scratch/task.json")" == "$initial_definition" ]] || exit 1
  jq -e '.tasks[0].group | startswith("family:")' "$scratch/task.json" >/dev/null
  jq -e --slurpfile run "$report_dir/run.json" '
    [.tasks[0].overrides.containerOverrides[] | select(.name == "oxy-api")]
    | length == 1 and .[0].command == (["busybox","timeout","-s","TERM","-k","30","5400","bun","run","packages/api/scripts/reconcile-external-identities.ts"] + (if $run[0].dryRun then [] else ["--apply"] end))
  ' "$scratch/task.json" >/dev/null
  aws_read ecs describe-services --cluster "$cluster" --services oxy-api --output json > "$scratch/services.json"
  jq -e --arg definition "$initial_definition" '.failures | length == 0' "$scratch/services.json" >/dev/null
  jq -e --arg definition "$initial_definition" '.services | length == 1 and all(.[]; .taskDefinition != $definition and all(.deployments[]; .taskDefinition != $definition))' "$scratch/services.json" >/dev/null
  state=$(jq -r '.tasks[0].lastStatus' "$scratch/task.json")
  if [[ "$state" == STOPPED ]]; then
    echo 'Exact task already stopped; no mutation needed.'
    exit 0
  fi
  [[ "$state" == RUNNING ]] || exit 1
  aws_read ecs stop-task --cluster "$cluster" --task "$task_arn" --reason 'Completed identity reconciliation: recovered full-scan report verified' --output json > "$scratch/stop.json"
  jq -e --arg task "$task_arn" '.task.taskArn == $task' "$scratch/stop.json" >/dev/null
  jq -n --arg task "$task_arn" '{operation:"stop_completed",taskArn:$task,stopRequested:true}' > "$report_dir/stop.json"
  for ((attempt=0; attempt<24; attempt++)); do
    read_task
    [[ "$(jq -r '.tasks[0].taskDefinitionArn' "$scratch/task.json")" == "$initial_definition" ]] || exit 1
    if [[ "$(jq -r '.tasks[0].lastStatus' "$scratch/task.json")" == STOPPED ]]; then exit 0; fi
    sleep 5
  done
  echo 'Stop requested, but STOPPED not observed within two minutes; recover another snapshot.' >&2
  exit 1
fi
if [[ "$stopped" != true ]]; then
  echo 'Task is still running; snapshot is not completion evidence.' >&2
  exit 0
fi
jq -e 'type == "object"' "$report_dir/summary.json" >/dev/null || { echo 'Missing completion summary' >&2; exit 1; }
jq -e --arg name "$container" '[.tasks[0].containers[] | select(.name == $name and .exitCode == 0)] | length == 1' "$scratch/task.json" >/dev/null
