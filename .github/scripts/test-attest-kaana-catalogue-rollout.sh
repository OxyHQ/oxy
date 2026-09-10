#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
attestor="$script_directory/attest-kaana-catalogue-rollout.sh"
scratch_directory="$(mktemp -d)"
trap 'rm -rf "$scratch_directory"' EXIT

service_task_definition='arn:aws:ecs:us-west-2:123456789012:task-definition/oxy-oxy-api:207'
bootstrap_task_definition='arn:aws:ecs:us-west-2:123456789012:task-definition/oxy-kaana-catalogue-bootstrap:12'
image="123456789012.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@sha256:$(printf 'a%.0s' {1..64})"

mkdir -p "$scratch_directory/bin"
cat >"$scratch_directory/bin/aws" <<'MOCK_AWS'
#!/usr/bin/env bash
set -euo pipefail

command_name="$1 $2"
shift 2

argument() {
  local wanted="$1"
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "$wanted" ]; then
      printf '%s' "$2"
      return
    fi
    shift
  done
  return 1
}

case "$command_name" in
  'ecs describe-services')
    count=0
    [ ! -f "$MOCK_AWS_COUNT_FILE" ] || count="$(<"$MOCK_AWS_COUNT_FILE")"
    count=$((count + 1))
    printf '%s' "$count" >"$MOCK_AWS_COUNT_FILE"
    active_task_definition="$MOCK_SERVICE_TASK_DEFINITION"
    rollout_state=COMPLETED
    old_running=0
    if [ "$MOCK_SCENARIO" = toctou ] && [ "$count" -ge 2 ]; then
      active_task_definition='arn:aws:ecs:us-west-2:123456789012:task-definition/oxy-oxy-api:208'
    elif [ "$MOCK_SCENARIO" = incomplete ]; then
      rollout_state=IN_PROGRESS
    elif [ "$MOCK_SCENARIO" = old-task ]; then
      old_running=1
    fi
    jq -nc \
      --arg task "$active_task_definition" \
      --arg expected "$MOCK_SERVICE_TASK_DEFINITION" \
      --arg rollout "$rollout_state" \
      --argjson old "$old_running" '
      {failures:[],services:[{status:"ACTIVE",taskDefinition:$task,desiredCount:2,runningCount:2,
        pendingCount:0,deployments:[
          {taskDefinition:$task,status:"PRIMARY",rolloutState:$rollout,desiredCount:2,runningCount:2,pendingCount:0},
          {taskDefinition:"arn:aws:ecs:us-west-2:123456789012:task-definition/oxy-oxy-api:206",
            status:"ACTIVE",rolloutState:"COMPLETED",desiredCount:0,runningCount:$old,pendingCount:0}
        ]}]}'
    ;;
  'ecs list-tasks')
    jq -nc '{taskArns:[
      "arn:aws:ecs:us-west-2:123456789012:task/oxy-cluster/task-1",
      "arn:aws:ecs:us-west-2:123456789012:task/oxy-cluster/task-2"
    ]}'
    ;;
  'ecs describe-tasks')
    jq -nc --arg task "$MOCK_SERVICE_TASK_DEFINITION" '{failures:[],tasks:[
      {taskArn:"arn:aws:ecs:us-west-2:123456789012:task/oxy-cluster/task-1",lastStatus:"RUNNING",desiredStatus:"RUNNING",taskDefinitionArn:$task},
      {taskArn:"arn:aws:ecs:us-west-2:123456789012:task/oxy-cluster/task-2",lastStatus:"RUNNING",desiredStatus:"RUNNING",taskDefinitionArn:$task}
    ]}'
    ;;
  'ecs describe-task-definition')
    requested="$(argument --task-definition "$@")"
    if [ "$requested" = "$MOCK_SERVICE_TASK_DEFINITION" ]; then
      container=oxy-api
    elif [ "$requested" = "$MOCK_BOOTSTRAP_TASK_DEFINITION" ]; then
      container=kaana-catalogue-bootstrap
    else
      exit 22
    fi
    task_role='arn:aws:iam::123456789012:role/oxy-kaana-catalogue-bootstrap'
    if [ "$MOCK_SCENARIO" = wrong-role ] && [ "$requested" = "$MOCK_BOOTSTRAP_TASK_DEFINITION" ]; then
      task_role='arn:aws:iam::123456789012:role/oxy-ecs-task'
    fi
    jq -nc --arg task "$requested" --arg container "$container" --arg image "$MOCK_IMAGE" --arg task_role "$task_role" '
      {taskDefinitionArn:$task,status:"ACTIVE",
       taskRoleArn:$task_role,
       executionRoleArn:"arn:aws:iam::123456789012:role/oxy-ecs-execution",
       networkMode:"awsvpc",requiresCompatibilities:["FARGATE"],cpu:"512",memory:"1024",
       runtimePlatform:{cpuArchitecture:"ARM64",operatingSystemFamily:"LINUX"},
       containerDefinitions:[{name:$container,image:$image,essential:true,
         command:["bun","run","packages/api/scripts/bootstrap-kaana-catalogue.ts"],
         environment:[{name:"AWS_REGION",value:"us-west-2"}],
         secrets:[{name:"DATABASE_URL",valueFrom:"parameter"}],
         logConfiguration:{logDriver:"awslogs"}}]}'
    ;;
  *)
    echo "unexpected mocked AWS command: $command_name" >&2
    exit 22
    ;;
esac
MOCK_AWS
chmod +x "$scratch_directory/bin/aws"

run_attestor() {
  local scenario="$1"
  rm -f "$scratch_directory/aws-count"
  PATH="$scratch_directory/bin:$PATH" \
  MOCK_AWS_COUNT_FILE="$scratch_directory/aws-count" \
  MOCK_SCENARIO="$scenario" \
  MOCK_SERVICE_TASK_DEFINITION="$service_task_definition" \
  MOCK_BOOTSTRAP_TASK_DEFINITION="$bootstrap_task_definition" \
  MOCK_IMAGE="$image" \
  KAANA_ROLLOUT_CONFIRM_DELAY_SECONDS=0 \
    "$attestor" \
      oxy-cluster oxy-api "$service_task_definition" oxy-api \
      "$bootstrap_task_definition" kaana-catalogue-bootstrap "$image"
}

stable_output="$(run_attestor stable)"
jq -e \
  --arg service_task "$service_task_definition" \
  --arg bootstrap_task "$bootstrap_task_definition" \
  --arg image "$image" '
    .cluster == "oxy-cluster" and .service == "oxy-api" and
    .serviceTaskDefinitionArn == $service_task and
    .bootstrapTaskDefinitionArn == $bootstrap_task and .image == $image and
    (.attestedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.000Z$")) and
    .serviceState.desiredCount == 2 and (.serviceState.taskArns | length) == 2
  ' <<<"$stable_output" >/dev/null

expect_failure() {
  local scenario="$1"
  local expected="$2"
  local error_file="$scratch_directory/${scenario}.err"
  if run_attestor "$scenario" >"$scratch_directory/${scenario}.out" 2>"$error_file"; then
    echo "scenario $scenario unexpectedly passed" >&2
    exit 1
  fi
  grep -F "$expected" "$error_file" >/dev/null
}

expect_failure old-task 'still has old deployment tasks'
expect_failure incomplete 'primary rollout is not uniquely COMPLETED'
expect_failure toctou 'service task definition changed'
expect_failure wrong-role 'does not match the dedicated least-authority configuration'

echo 'Kaana catalogue rollout attestation tests passed'
