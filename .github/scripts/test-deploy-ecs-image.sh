#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* &&
        -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

export DEPLOY_TEST_LOG=""
export DEPLOY_TEST_EXPECT_METRICS_ARN=false
# The SSM parameter path a case feeds to INTERNAL_METRICS_PARAMETER, and from
# which the mocked register-task-definition derives the ARN it demands. A case
# overrides it to cover a path shape the default does not.
export DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
export DEPLOY_TEST_TASK_EXIT_CODE=0
export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN=false
export DEPLOY_TEST_EXPECT_TASK_ENV=false
export DEPLOY_TEST_EXPECT_TASK_REMOVE=false
export DEPLOY_TEST_SERVICE_DESIRED_COUNT=1
export DEPLOY_TEST_ROLLOUT_SCENARIO=healthy
export DEPLOY_TEST_DEPLOYMENT_ID=ecs-deploy-test-2
export DEPLOY_TEST_ROLLBACK_DEPLOYMENT_ID=ecs-deploy-test-rollback
export DEPLOY_TEST_MISSING_PRIMARY_DEPLOYMENT=false

aws() {
  local service_json='{
    "failures": [],
    "services": [{
      "status": "ACTIVE",
      "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
      "desiredCount": 1,
      "networkConfiguration": {
        "awsvpcConfiguration": {
          "subnets": ["subnet-test"],
          "securityGroups": ["sg-test"]
        }
      },
      "launchType": "FARGATE",
      "deployments": [
        {
          "id": "ecs-deploy-test-2",
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:2",
          "status": "PRIMARY",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        },
        {
          "id": "ecs-deploy-test-1",
          "taskDefinition": "arn:aws:ecs:test:task-definition/deploy-test:1",
          "status": "ACTIVE",
          "rolloutState": "COMPLETED",
          "runningCount": 1,
          "desiredCount": 1
        }
      ]
    }]
  }'
  service_json="$(jq \
    --argjson desired "$DEPLOY_TEST_SERVICE_DESIRED_COUNT" \
    '.services[0].desiredCount = $desired' \
    <<<"$service_json")"

  case "$1 $2" in
    "ecs describe-services")
      local describe_count_file="${DEPLOY_TEST_LOG}.describe-count"
      local describe_count=0
      if [[ -f "$describe_count_file" ]]; then
        describe_count="$(<"$describe_count_file")"
      fi
      describe_count=$((describe_count + 1))
      printf '%s\n' "$describe_count" >"$describe_count_file"
      if [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "transient-zero-deployment" &&
            "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .id == "ecs-deploy-test-2"
              then
                .rolloutState = "IN_PROGRESS"
                | .desiredCount = 0
                | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "circuit-breaker-rollback" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              select(.id != "ecs-deploy-test-2")
            )
          | .services[0].deployments[0].status = "PRIMARY"
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "zero-service-during-deploy" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].desiredCount = 0
          | .services[0].deployments |= map(
              if .id == "ecs-deploy-test-2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      elif [[ "$DEPLOY_TEST_ROLLOUT_SCENARIO" == "completed-zero-deployment" &&
              "$describe_count" == "2" ]]; then
        service_json="$(jq '
          .services[0].deployments |= map(
              if .id == "ecs-deploy-test-2"
              then .desiredCount = 0 | .runningCount = 0
              else .
              end
            )
        ' <<<"$service_json")"
      fi
      printf '%s\n' "$service_json"
      ;;
    "ecs describe-task-definition")
      printf '%s\n' '{
        "family": "deploy-test",
        "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"],
        "cpu": "256",
        "memory": "512",
        "containerDefinitions": [{
          "name": "deploy-test",
          "image": "example.invalid/deploy-test:old",
          "essential": true,
          "environment": [
            {"name": "KEEP_EXISTING", "value": "preserved"},
            {"name": "REPLACE_EXISTING", "value": "old"},
            {"name": "REMOVE_ENV", "value": "obsolete"}
          ],
          "secrets": [
            {
              "name": "EXISTING_SECRET",
              "valueFrom": "arn:aws:ssm:test:123456789012:parameter/oxy/deploy-test/EXISTING_SECRET"
            },
            {
              "name": "REMOVE_SECRET",
              "valueFrom": "arn:aws:ssm:test:123456789012:parameter/oxy/deploy-test/REMOVE_SECRET"
            }
          ],
          "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
              "awslogs-group": "/ecs/deploy-test",
              "awslogs-stream-prefix": "ecs"
            }
          }
        }]
      }'
      ;;
    "ecs register-task-definition")
      if [[ "$DEPLOY_TEST_EXPECT_METRICS_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # The verdict is written to the log rather than left to `set -e`. A
        # command that fails in the MIDDLE of this function does not abort the
        # run -- measured, and it holds whether the function is exported or
        # local -- because the caller consumes it as `v="$(aws ...)"` and only
        # the function's LAST command reaches that assignment's exit status. An
        # assertion whose only effect is its own exit status therefore cannot
        # fail, which is what this one did: pointing it at an ARN no case uses
        # left the suite green. Logging a distinct token instead puts the
        # mismatch in the expected.log diff, where it names itself.
        if jq -e \
          --arg expected \
          "arn:aws:ssm:test:123456789012:parameter${DEPLOY_TEST_METRICS_PARAMETER}" \
          '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "INTERNAL_METRICS_TOKEN" and
              .valueFrom == $expected
            )
        ' "$input_json" >/dev/null; then
          printf 'metrics:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'metrics:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_SECRET_ARN" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        # Same reason as the metrics assertion above: log the verdict, do not
        # rely on this function's exit status.
        if jq -e '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | .secrets[]
          | select(
              .name == "EXTRA_TASK_SECRET" and
              .valueFrom == "arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"
            )
        ' "$input_json" >/dev/null; then
          printf 'task-secret:arn\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-secret:arn:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_ENV" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        if jq -e '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | (.environment | map({key: .name, value: .value}) | from_entries) as $environment
          | $environment.KEEP_EXISTING == "preserved" and
            $environment.REPLACE_EXISTING == "new" and
            $environment.NEW_PLAIN_SETTING == "do-not-log-sensitive-value"
        ' "$input_json" >/dev/null; then
          printf 'task-env:valid\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-env:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      if [[ "$DEPLOY_TEST_EXPECT_TASK_REMOVE" == "true" ]]; then
        local previous_argument=""
        local input_json=""
        local argument
        for argument in "$@"; do
          if [[ "$previous_argument" == "--cli-input-json" ]]; then
            input_json="${argument#file://}"
            break
          fi
          previous_argument="$argument"
        done
        if jq -e '
          .containerDefinitions[]
          | select(.name == "deploy-test")
          | ([.environment[].name] | index("REMOVE_ENV") == null) and
            ([.secrets[].name] | index("REMOVE_SECRET") == null) and
            ([.environment[].name] | index("KEEP_EXISTING") != null) and
            ([.secrets[].name] | index("EXISTING_SECRET") != null)
        ' "$input_json" >/dev/null; then
          printf 'task-remove:valid\n' >>"$DEPLOY_TEST_LOG"
        else
          printf 'task-remove:MISMATCH\n' >>"$DEPLOY_TEST_LOG"
        fi
      fi
      printf '%s\n' "arn:aws:ecs:test:task-definition/deploy-test:2"
      ;;
    "ecs update-service")
      local previous_argument=""
      local task_definition=""
      local desired_count=""
      local output_json=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--task-definition" ]]; then
          task_definition="$argument"
        elif [[ "$previous_argument" == "--desired-count" ]]; then
          desired_count="$argument"
        fi
        previous_argument="$argument"
      done
      if [[ -z "$desired_count" ]]; then
        echo "Mocked update-service requires an explicit --desired-count." >&2
        return 1
      fi
      if [[ "$task_definition" == "arn:aws:ecs:test:task-definition/deploy-test:1" ]]; then
        output_json="$(jq -n \
          --arg id "$DEPLOY_TEST_ROLLBACK_DEPLOYMENT_ID" \
          --arg task "$task_definition" \
          '{
            service: {
              deployments: [{
                id: $id,
                taskDefinition: $task,
                status: "PRIMARY",
                rolloutState: "COMPLETED",
                runningCount: 1,
                desiredCount: 1
              }]
            }
          }')"
      else
        if [[ "$DEPLOY_TEST_MISSING_PRIMARY_DEPLOYMENT" == "true" ]]; then
          output_json="$(jq -n \
            --arg id "$DEPLOY_TEST_DEPLOYMENT_ID" \
            --arg task "$task_definition" \
            '{
              service: {
                deployments: [{
                  id: $id,
                  taskDefinition: $task,
                  status: "ACTIVE",
                  rolloutState: "IN_PROGRESS",
                  runningCount: 0,
                  desiredCount: 1
                }]
              }
            }')"
        else
        output_json="$(jq -n \
          --arg id "$DEPLOY_TEST_DEPLOYMENT_ID" \
          --arg task "$task_definition" \
          '{
            service: {
              deployments: [{
                id: $id,
                taskDefinition: $task,
                status: "PRIMARY",
                rolloutState: "COMPLETED",
                runningCount: 1,
                desiredCount: 1
              }]
            }
          }')"
        fi
      fi
      printf 'service:%s:desired=%s\n' \
        "$task_definition" \
        "$desired_count" \
        >>"$DEPLOY_TEST_LOG"
      if [[ "$*" == *"--output json"* ]]; then
        printf '%s\n' "$output_json"
      else
        printf '{}\n'
      fi
      ;;
    "ecs run-task")
      local previous_argument=""
      local overrides=""
      local argument
      for argument in "$@"; do
        if [[ "$previous_argument" == "--overrides" ]]; then
          overrides="$argument"
          break
        fi
        previous_argument="$argument"
      done
      if jq -e '.containerOverrides[0].command | index("packages/api/dist/db/migrate.js") != null' \
        <<<"$overrides" >/dev/null; then
        printf 'migration\n' >>"$DEPLOY_TEST_LOG"
      elif jq -e '.containerOverrides[0].command | index("packages/api/scripts/verify-inference-routing-readiness.ts") != null' \
        <<<"$overrides" >/dev/null; then
        printf 'readiness\n' >>"$DEPLOY_TEST_LOG"
      else
        printf 'reconcile\n' >>"$DEPLOY_TEST_LOG"
      fi
      printf '%s\n' '{
        "failures": [],
        "tasks": [{"taskArn": "arn:aws:ecs:test:task/deploy-test-reconcile"}]
      }'
      ;;
    "ecs describe-tasks")
      printf '{
        "failures": [],
        "tasks": [{
          "lastStatus": "STOPPED",
          "stoppedReason": "Essential container exited",
          "containers": [{
            "name": "deploy-test",
            "exitCode": %s
          }]
        }]
      }\n' "$DEPLOY_TEST_TASK_EXIT_CODE"
      ;;
    "logs get-log-events")
      printf 'tasklogs\n' >>"$DEPLOY_TEST_LOG"
      printf '%s\n' '{
        "events": [{
          "message": "[migration] fixture failure"
        }]
      }'
      ;;
    *)
      printf 'Unexpected mocked AWS call: %s\n' "$*" >&2
      return 1
      ;;
  esac
}
export -f aws

run_release() {
  local case_name="$1"
  local expect_success="$2"
  local run_migrations="${3:-false}"
  local inject_internal_metrics="${4:-false}"
  local task_exit_code="${5:-0}"
  local inject_task_secret="${6:-false}"
  local service_desired_count="${7:-1}"
  local rollout_scenario="${8:-healthy}"
  local smoke_exit_code="${9:-0}"
  local pre_deploy_command="${10:-}"
  local task_environment_overrides="${11:-}"
  local task_remove_names="${12:-}"
  local case_directory="$test_directory/$case_name"
  local output_file="$case_directory/output.log"
  local smoke_script="$case_directory/smoke.sh"

  mkdir -p "$case_directory"
  DEPLOY_TEST_LOG="$case_directory/aws.log"
  DEPLOY_TEST_EXPECT_METRICS_ARN="$inject_internal_metrics"
  DEPLOY_TEST_TASK_EXIT_CODE="$task_exit_code"
  DEPLOY_TEST_EXPECT_TASK_SECRET_ARN="$inject_task_secret"
  DEPLOY_TEST_EXPECT_TASK_ENV=false
  if [[ -n "$task_environment_overrides" ]]; then
    DEPLOY_TEST_EXPECT_TASK_ENV=true
  fi
  DEPLOY_TEST_EXPECT_TASK_REMOVE=false
  if [[ -n "$task_remove_names" ]]; then
    DEPLOY_TEST_EXPECT_TASK_REMOVE=true
  fi
  DEPLOY_TEST_SERVICE_DESIRED_COUNT="$service_desired_count"
  DEPLOY_TEST_ROLLOUT_SCENARIO="$rollout_scenario"
  export DEPLOY_TEST_LOG DEPLOY_TEST_EXPECT_METRICS_ARN
  export DEPLOY_TEST_TASK_EXIT_CODE
  export DEPLOY_TEST_EXPECT_TASK_SECRET_ARN
  export DEPLOY_TEST_EXPECT_TASK_ENV
  export DEPLOY_TEST_EXPECT_TASK_REMOVE
  export DEPLOY_TEST_SERVICE_DESIRED_COUNT
  export DEPLOY_TEST_ROLLOUT_SCENARIO
  export DEPLOY_TEST_DEPLOYMENT_ID
  export DEPLOY_TEST_ROLLBACK_DEPLOYMENT_ID

  # The generated smoke fixture expands DEPLOY_TEST_LOG when it runs; its exit
  # code is the entire interface deploy-ecs-image.sh reads, so each case picks
  # one. 75 is the "failed, but a rollback cannot repair it" code.
  # shellcheck disable=SC2016
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'printf "smoke\n" >>"$DEPLOY_TEST_LOG"' \
    "exit $smoke_exit_code" \
    >"$smoke_script"

  local -a release_environment=(
    AWS_REGION=test
    AWS_ACCOUNT_ID=123456789012
    CLUSTER=deploy-test
    APP=deploy-test
    CONTAINER_NAME=deploy-test
    IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    MAX_WAIT_SECS=5
    POLL_INTERVAL=1
    RUN_MIGRATIONS="$run_migrations"
    POST_DEPLOY_SMOKE_SCRIPT="$smoke_script"
    PRE_DEPLOY_TASK_COMMAND_JSON="$pre_deploy_command"
    POST_DEPLOY_TASK_COMMAND_JSON='["reconcile"]'
    TASK_ENV_OVERRIDES_JSON="$task_environment_overrides"
    TASK_REMOVE_NAMES_JSON="$task_remove_names"
  )
  if [[ "$inject_internal_metrics" == "true" ]]; then
    release_environment+=(
      INTERNAL_METRICS_PARAMETER="$DEPLOY_TEST_METRICS_PARAMETER"
    )
  fi
  if [[ "$inject_task_secret" == "true" ]]; then
    release_environment+=(
      TASK_SECRET_OVERRIDES_JSON='{"EXTRA_TASK_SECRET":"arn:aws:ssm:test:123456789012:parameter/oxy/sample-app/EXTRA_TASK_SECRET"}'
    )
  fi

  if env "${release_environment[@]}" \
    bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
    >"$output_file" 2>&1; then
    if [[ "$expect_success" != "true" ]]; then
      echo "Expected $case_name to fail." >&2
      return 1
    fi
  elif [[ "$expect_success" == "true" ]]; then
    echo "Expected $case_name to succeed." >&2
    sed -n '1,240p' "$output_file" >&2
    return 1
  fi
}

run_release success true false true
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/success/expected.log"
diff -u \
  "$test_directory/success/expected.log" \
  "$test_directory/success/aws.log"

# A hyphen in the parameter path is its own case because it is its own bug: the
# bracket expression validating this name once matched every character EXCEPT a
# hyphen, so an app whose path had none deployed and an app whose path had one
# did not -- and the only repo with a smoke fixture at the time was one of the
# former, which is why nothing here caught it.
#
# KEEP BOTH, and keep the plain one's app segment hyphen-FREE. That asymmetry is
# the entire test: rename them to two spellings that both contain a hyphen and
# this pair silently stops discriminating, while the suite still passes and still
# goes red under a mutation -- just for the wrong case.
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sample-app/INTERNAL_METRICS_TOKEN
run_release hyphenated-metrics-parameter true false true
DEPLOY_TEST_METRICS_PARAMETER=/oxy/sampleapp/INTERNAL_METRICS_TOKEN
printf '%s\n' \
  metrics:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/hyphenated-metrics-parameter/expected.log"
diff -u \
  "$test_directory/hyphenated-metrics-parameter/expected.log" \
  "$test_directory/hyphenated-metrics-parameter/aws.log"

run_release explicit-task-secret true false false 0 true
printf '%s\n' \
  task-secret:arn \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/explicit-task-secret/expected.log"
diff -u \
  "$test_directory/explicit-task-secret/expected.log" \
  "$test_directory/explicit-task-secret/aws.log"

run_release explicit-task-environment true false false 0 false 1 healthy 0 '' \
  '{"REPLACE_EXISTING":"new","NEW_PLAIN_SETTING":"do-not-log-sensitive-value"}'
printf '%s\n' \
  task-env:valid \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/explicit-task-environment/expected.log"
diff -u \
  "$test_directory/explicit-task-environment/expected.log" \
  "$test_directory/explicit-task-environment/aws.log"
if grep -R -F 'do-not-log-sensitive-value' \
  "$test_directory/explicit-task-environment/output.log" \
  "$test_directory/explicit-task-environment/aws.log" >/dev/null; then
  echo "TASK_ENV_OVERRIDES_JSON value leaked to deploy logs." >&2
  exit 1
fi

run_release explicit-task-removal true false false 0 false 1 healthy 0 '' '' \
  '["REMOVE_ENV","REMOVE_SECRET"]'
printf '%s\n' \
  task-remove:valid \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/explicit-task-removal/expected.log"
diff -u \
  "$test_directory/explicit-task-removal/expected.log" \
  "$test_directory/explicit-task-removal/aws.log"

case_directory="$test_directory/invalid-task-removal"
mkdir -p "$case_directory"
if env \
  AWS_REGION=test \
  CLUSTER=deploy-test \
  APP=deploy-test \
  IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  TASK_REMOVE_NAMES_JSON='["DUPLICATE","DUPLICATE"]' \
  bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
  >"$case_directory/output.log" 2>&1; then
  echo "Expected invalid TASK_REMOVE_NAMES_JSON to fail." >&2
  exit 1
fi
grep -F 'TASK_REMOVE_NAMES_JSON must be an array' "$case_directory/output.log" >/dev/null
if [[ -s "$case_directory/aws.log" ]]; then
  echo "Invalid TASK_REMOVE_NAMES_JSON reached AWS." >&2
  exit 1
fi

case_directory="$test_directory/remove-override-overlap"
mkdir -p "$case_directory"
if env \
  AWS_REGION=test \
  CLUSTER=deploy-test \
  APP=deploy-test \
  IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  TASK_ENV_OVERRIDES_JSON='{"SAME_NAME":"new"}' \
  TASK_REMOVE_NAMES_JSON='["SAME_NAME"]' \
  bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
  >"$case_directory/output.log" 2>&1; then
  echo "Expected remove/override overlap to fail." >&2
  exit 1
fi
grep -F 'must not name a TASK_ENV_OVERRIDES_JSON' "$case_directory/output.log" >/dev/null

case_directory="$test_directory/invalid-task-environment"
mkdir -p "$case_directory"
if env \
  AWS_REGION=test \
  CLUSTER=deploy-test \
  APP=deploy-test \
  IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  TASK_ENV_OVERRIDES_JSON='{"INVALID":42}' \
  bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
  >"$case_directory/output.log" 2>&1; then
  echo "Expected invalid TASK_ENV_OVERRIDES_JSON to fail." >&2
  exit 1
fi
grep -F 'TASK_ENV_OVERRIDES_JSON must map environment variable names to string values' \
  "$case_directory/output.log" >/dev/null
if [[ -s "$case_directory/aws.log" ]]; then
  echo "Invalid TASK_ENV_OVERRIDES_JSON reached AWS." >&2
  exit 1
fi

case_directory="$test_directory/plain-secret-override-overlap"
mkdir -p "$case_directory"
if env \
  AWS_REGION=test \
  CLUSTER=deploy-test \
  APP=deploy-test \
  IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  TASK_ENV_OVERRIDES_JSON='{"SHARED_NAME":"do-not-print-overlap"}' \
  TASK_SECRET_OVERRIDES_JSON='{"SHARED_NAME":"arn:aws:ssm:test:123456789012:parameter/oxy/deploy-test/SHARED_NAME"}' \
  bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
  >"$case_directory/output.log" 2>&1; then
  echo "Expected plaintext/secret override overlap to fail." >&2
  exit 1
fi
grep -F 'must not overlap TASK_SECRET_OVERRIDES_JSON' \
  "$case_directory/output.log" >/dev/null
if grep -F 'do-not-print-overlap' "$case_directory/output.log" >/dev/null; then
  echo "Overlapping plaintext value leaked to deploy logs." >&2
  exit 1
fi

case_directory="$test_directory/plain-existing-secret-overlap"
mkdir -p "$case_directory"
DEPLOY_TEST_LOG="$case_directory/aws.log"
export DEPLOY_TEST_LOG
if env \
  AWS_REGION=test \
  CLUSTER=deploy-test \
  APP=deploy-test \
  CONTAINER_NAME=deploy-test \
  IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  TASK_ENV_OVERRIDES_JSON='{"EXISTING_SECRET":"do-not-print"}' \
  bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
  >"$case_directory/output.log" 2>&1; then
  echo "Expected plaintext/existing ECS secret overlap to fail." >&2
  exit 1
fi
grep -F 'must not replace an existing ECS secret' \
  "$case_directory/output.log" >/dev/null
if grep -F 'do-not-print' "$case_directory/output.log" >/dev/null; then
  echo "Existing-secret overlap value leaked to deploy logs." >&2
  exit 1
fi

case_directory="$test_directory/plain-internal-metrics-secret-overlap"
mkdir -p "$case_directory"
if env \
  AWS_REGION=test \
  CLUSTER=deploy-test \
  APP=deploy-test \
  IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  INTERNAL_METRICS_PARAMETER=/oxy/deploy-test/INTERNAL_METRICS_TOKEN \
  TASK_ENV_OVERRIDES_JSON='{"INTERNAL_METRICS_TOKEN":"do-not-print"}' \
  bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
  >"$case_directory/output.log" 2>&1; then
  echo "Expected plaintext/internal metrics secret overlap to fail." >&2
  exit 1
fi
grep -F 'must not override INTERNAL_METRICS_TOKEN' \
  "$case_directory/output.log" >/dev/null
if grep -F 'do-not-print' "$case_directory/output.log" >/dev/null; then
  echo "Internal metrics overlap value leaked to deploy logs." >&2
  exit 1
fi

# Phase A must publish the non-secret score validity horizon before operators
# can approve serving routes, but it must not activate the readiness gate in
# the same release. That separation leaves a safe authoring window between the
# additive schema/API rollout and serving enforcement.
workflow_file="$repository_root/.github/workflows/deploy-aws.yml"
grep -F 'TASK_ENV_OVERRIDES_JSON: >-' "$workflow_file" >/dev/null
grep -F '{"INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS":"3600","KAANA_BASE_URL":"https://kaana.ai","KAANA_EDGE_SIGNING_KEY_ID":"oxy-edge-2026-08-17","KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID":"oxy-credential-control-2026-09","INFERENCE_KAANA_EXECUTION":"disabled"}' \
  "$workflow_file" >/dev/null
grep -F 'TASK_REMOVE_NAMES_JSON: >-' "$workflow_file" >/dev/null
grep -F '["RELAY_BASE_URL","RELAY_EDGE_SIGNING_KEY_ID","RELAY_EDGE_SIGNING_PRIVATE_KEY"]' \
  "$workflow_file" >/dev/null
grep -F 'TASK_SECRET_OVERRIDES_JSON: >-' "$workflow_file" >/dev/null
grep -F '"KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY":"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY"' \
  "$workflow_file" >/dev/null
if grep -F 'PRE_DEPLOY_TASK_COMMAND_JSON:' "$workflow_file" >/dev/null; then
  echo "Phase A must not activate the inference routing readiness gate." >&2
  exit 1
fi

run_release reconciliation-failure false false false 1
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  tasklogs \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/reconciliation-failure/expected.log"
diff -u \
  "$test_directory/reconciliation-failure/expected.log" \
  "$test_directory/reconciliation-failure/aws.log"

run_release migration-failure false true false 1
printf '%s\n' \
  migration \
  tasklogs \
  >"$test_directory/migration-failure/expected.log"
diff -u \
  "$test_directory/migration-failure/expected.log" \
  "$test_directory/migration-failure/aws.log"
grep -F \
  "[migration] fixture failure" \
  "$test_directory/migration-failure/output.log" \
  >/dev/null
if grep -q '^service:' "$test_directory/migration-failure/aws.log"; then
  echo "Failed migration reached update-service." >&2
  exit 1
fi

run_release readiness-success true false false 0 false 1 healthy 0 \
  '["bun","run","packages/api/scripts/verify-inference-routing-readiness.ts"]'
printf '%s\n' \
  readiness \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/readiness-success/expected.log"
diff -u \
  "$test_directory/readiness-success/expected.log" \
  "$test_directory/readiness-success/aws.log"

run_release readiness-failure false false false 1 false 1 healthy 0 \
  '["bun","run","packages/api/scripts/verify-inference-routing-readiness.ts"]'
printf '%s\n' \
  readiness \
  tasklogs \
  >"$test_directory/readiness-failure/expected.log"
diff -u \
  "$test_directory/readiness-failure/expected.log" \
  "$test_directory/readiness-failure/aws.log"
if grep -q '^service:' "$test_directory/readiness-failure/aws.log"; then
  echo "Failed readiness check reached update-service." >&2
  exit 1
fi

run_release zero-desired-count false false false 0 false 0
grep -F \
  "must have a positive desiredCount before deployment (current: 0)" \
  "$test_directory/zero-desired-count/output.log" \
  >/dev/null
if [[ -s "$test_directory/zero-desired-count/aws.log" ]]; then
  echo "Zero-capacity service reached a mutating AWS call." >&2
  exit 1
fi

run_release transient-zero-deployment true false false 0 false 1 transient-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  smoke \
  reconcile \
  >"$test_directory/transient-zero-deployment/expected.log"
diff -u \
  "$test_directory/transient-zero-deployment/expected.log" \
  "$test_directory/transient-zero-deployment/aws.log"
grep -F \
  "has not assigned desired tasks" \
  "$test_directory/transient-zero-deployment/output.log" \
  >/dev/null

run_release zero-service-during-deploy false false false 0 false 1 zero-service-during-deploy
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/zero-service-during-deploy/expected.log"
diff -u \
  "$test_directory/zero-service-during-deploy/expected.log" \
  "$test_directory/zero-service-during-deploy/aws.log"
grep -F \
  "service deploy-test reached desiredCount=0 during the deployment rollout" \
  "$test_directory/zero-service-during-deploy/output.log" \
  >/dev/null

run_release completed-zero-deployment false false false 0 false 1 completed-zero-deployment
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/completed-zero-deployment/expected.log"
diff -u \
  "$test_directory/completed-zero-deployment/expected.log" \
  "$test_directory/completed-zero-deployment/aws.log"
grep -F \
  "completed at desiredCount=0; refusing to accept a zero-task steady state" \
  "$test_directory/completed-zero-deployment/output.log" \
  >/dev/null

run_release circuit-breaker-rollback false false false 0 false 1 circuit-breaker-rollback
printf '%s\n' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:2:desired=1' \
  'service:arn:aws:ecs:test:task-definition/deploy-test:1:desired=1' \
  >"$test_directory/circuit-breaker-rollback/expected.log"
diff -u \
  "$test_directory/circuit-breaker-rollback/expected.log" \
  "$test_directory/circuit-breaker-rollback/aws.log"
grep -F \
  "deployment ecs-deploy-test-2 is no longer on the service (rolled back or superseded)" \
  "$test_directory/circuit-breaker-rollback/output.log" \
  >/dev/null

# `extract_primary_deployment_id` RETURNS on stdout; its failure `::error::` must
# land on stderr so a caller's `$(...)` capture cannot swallow the reason.
case_directory="$test_directory/missing-primary-deployment-stderr"
mkdir -p "$case_directory"
DEPLOY_TEST_LOG="$case_directory/aws.log"
DEPLOY_TEST_MISSING_PRIMARY_DEPLOYMENT=true
export DEPLOY_TEST_LOG DEPLOY_TEST_MISSING_PRIMARY_DEPLOYMENT
smoke_script="$case_directory/smoke.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "smoke\n" >>"$DEPLOY_TEST_LOG"' \
  'exit 0' \
  >"$smoke_script"
if env \
  AWS_REGION=test \
  AWS_ACCOUNT_ID=123456789012 \
  CLUSTER=deploy-test \
  APP=deploy-test \
  CONTAINER_NAME=deploy-test \
  IMAGE_URI="example.invalid/deploy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  MAX_WAIT_SECS=5 \
  POLL_INTERVAL=1 \
  RUN_MIGRATIONS=false \
  POST_DEPLOY_SMOKE_SCRIPT="$smoke_script" \
  POST_DEPLOY_TASK_COMMAND_JSON='["reconcile"]' \
  bash "$repository_root/.github/scripts/deploy-ecs-image.sh" \
  >"$case_directory/stdout.log" \
  2>"$case_directory/stderr.log"; then
  echo "Expected missing-primary-deployment case to fail." >&2
  exit 1
fi
grep -F \
  '::error::ECS update-service returned no PRIMARY deployment id for deployment.' \
  "$case_directory/stderr.log" \
  >/dev/null
if grep -F \
  '::error::ECS update-service returned no PRIMARY deployment id for deployment.' \
  "$case_directory/stdout.log" \
  >/dev/null; then
  echo "Missing-primary deployment error leaked to stdout (would be swallowed by \$(...))." >&2
  exit 1
fi
DEPLOY_TEST_MISSING_PRIMARY_DEPLOYMENT=false
export DEPLOY_TEST_MISSING_PRIMARY_DEPLOYMENT

echo "Deployment script transaction tests passed."
