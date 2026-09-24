#!/usr/bin/env bash
# Run one command in the dedicated oxy-kaana-catalogue-bootstrap task and print
# a JSON envelope {exitCode, resultCount, result, resultLine} on stdout.
#
#   run-kaana-catalogue-one-shot.sh <label> <command-json> <environment-json> <result-prefix>
#
# Required env: CLUSTER, TASK_DEFINITION_ARN, CONTAINER, NETWORK_JSON,
# LOG_GROUP, LOG_PREFIX, STARTED_BY. Only lines starting with <result-prefix>
# are read back from CloudWatch; `result` is that line parsed as JSON when it
# is JSON, and `resultLine` is the raw remainder for plain-text pass lines.
set -euo pipefail

task_label="$1"
task_command="$2"
task_environment="$3"
result_prefix="$4"

overrides=$(jq -nc \
  --arg container "$CONTAINER" \
  --argjson command "$task_command" \
  --argjson environment "$task_environment" '
    {containerOverrides:[{name:$container,command:$command,environment:$environment}]}
  ')
run_json=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEFINITION_ARN" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_JSON" \
  --overrides "$overrides" \
  --started-by "$STARTED_BY")
task_arn=$(jq -r '.tasks[0].taskArn // empty' <<<"$run_json")
if [ -z "$task_arn" ]; then
  echo "::error::$task_label task was not started" >&2
  printf '%s\n' '{"exitCode":255,"resultCount":0,"result":null,"resultLine":null}'
  exit 0
fi
echo "$task_label task: $task_arn" >&2
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"
task_json=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn")
exit_code=$(jq -r --arg container "$CONTAINER" '
  [.tasks[0].containers[] | select(.name == $container)] |
  if length == 1 and (.[0].exitCode | type) == "number" then .[0].exitCode else 255 end
' <<<"$task_json")
task_id=${task_arn##*/}
result_lines='[]'
for _attempt in $(seq 1 10); do
  log_json=$(aws logs get-log-events \
    --log-group-name "$LOG_GROUP" \
    --log-stream-name "$LOG_PREFIX/$CONTAINER/$task_id" \
    --start-from-head --output json 2>/dev/null || printf '{"events":[]}')
  result_lines=$(jq -c --arg prefix "$result_prefix" '
    [.events[].message | select(startswith($prefix)) | ltrimstr($prefix)]
  ' <<<"$log_json")
  [ "$(jq 'length' <<<"$result_lines")" != 0 ] && break
  sleep 3
done
jq -nc \
  --argjson exitCode "$exit_code" \
  --argjson lines "$result_lines" '
    {
      exitCode:$exitCode,
      resultCount:($lines | length),
      result:(if ($lines | length) == 1 then (try ($lines[0] | fromjson) catch null) else null end),
      resultLine:(if ($lines | length) == 1 then $lines[0] else null end)
    }
  '
