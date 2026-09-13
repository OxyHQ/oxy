#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
export GITHUB_REF=refs/heads/main GITHUB_REF_PROTECTED=true GITHUB_ACTOR=operator GITHUB_TRIGGERING_ACTOR=operator
export GITHUB_REPOSITORY=OxyHQ/oxy RECOVERY_RUN_ID=123
export EXPECTED_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export EXPECTED_IMAGE_DIGEST="sha256:$(printf 'b%.0s' {1..64})"
export TEST_TASK=arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/dfbd79710d3942268216b053231cbae3
export TEST_DEFINITION=arn:aws:ecs:us-west-2:237343248947:task-definition/oxy-api:123
export TEST_LOG="$test_root/aws.log" TEST_ARTIFACT="$test_root/artifact.json" TEST_MODE=success
# Exact five-field historical artifact from the credential-expired workflow.
jq -n --arg sha "$EXPECTED_SOURCE_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" --arg task "$TEST_TASK" \
  '{operation:"reconcile",expectedSourceSha:$sha,imageDigest:$digest,taskArn:$task,dryRun:false}' > "$TEST_ARTIFACT"
aws() {
  printf '%s\n' "$*" >> "$TEST_LOG"
  case "$1 $2" in
    'ecs describe-tasks')
      [[ "$*" == *"--tasks $TEST_TASK "* ]] || return 1
      local digest="$EXPECTED_IMAGE_DIGEST" state=STOPPED code=0 group=family:oxy-api
      [[ "$TEST_MODE" != service ]] || group=service:oxy-api
      [[ "$TEST_MODE" != completed && "$TEST_MODE" != stuck ]] || state=RUNNING
      [[ ! -f "$TEST_LOG.stopped" || "$TEST_MODE" == stuck ]] || state=STOPPED
      [[ "$TEST_MODE" != image ]] || digest="sha256:$(printf 'c%.0s' {1..64})"
      [[ "$TEST_MODE" != running ]] || state=RUNNING
      [[ "$TEST_MODE" != failed ]] || code=124
      jq -nc --arg task "$TEST_TASK" --arg definition "$TEST_DEFINITION" --arg digest "$digest" --arg state "$state" --arg group "$group" --arg mode "$TEST_MODE" --argjson code "$code" \
        '{failures:[],tasks:[{taskArn:$task,taskDefinitionArn:$definition,startedBy:"gh-identity-reconciliation",group:$group,overrides:{containerOverrides:[{name:"oxy-api",command:["busybox","timeout","-s","TERM","-k","30","5400","bun","run","packages/api/scripts/reconcile-external-identities.ts","--apply"]}]},lastStatus:$state,createdAt:"2026-09-14T06:17:34+00:00",startedAt:"2026-09-14T06:18:00+00:00",stoppingAt:"2026-09-14T07:48:00+00:00",stoppedAt:"2026-09-14T07:48:30+00:00",containers:[{name:"oxy-api",imageDigest:$digest,exitCode:$code}]}]} | if $mode == "cursor" then .tasks[0].overrides.containerOverrides[0].command += ["--after=https://bird.makeup/users/prior"] elif $mode == "wrong_started_by" then .tasks[0].startedBy = "service" else . end' ;;
    'ecs describe-task-definition')
      local digest="$EXPECTED_IMAGE_DIGEST"
      [[ "$TEST_MODE" != definition ]] || digest="sha256:$(printf 'c%.0s' {1..64})"
      jq -nc --arg definition "$TEST_DEFINITION" --arg digest "$digest" \
        '{taskDefinitionArn:$definition,containerDefinitions:[{name:"oxy-api",image:("237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@"+$digest),environment:[{name:"SECRET",value:"MUST_NOT_RETAIN"}],logConfiguration:{options:{"awslogs-group":"/oxy/ecs","awslogs-stream-prefix":"oxy-api"}}}]}' ;;
    'ecs describe-services')
      local definition=other-definition
      [[ "$TEST_MODE" != live_definition ]] || definition="$TEST_DEFINITION"
      jq -nc --arg definition "$definition" '{failures:[],services:[{taskDefinition:$definition,deployments:[{taskDefinition:$definition}]}]}' ;;
    'ecs stop-task')
      [[ "$*" == *"--task $TEST_TASK "* ]] || return 1
      touch "$TEST_LOG.stopped"
      jq -nc --arg task "$TEST_TASK" '{task:{taskArn:$task}}' ;;
    'logs get-log-events')
      [[ "$*" == *"--log-stream-name oxy-api/oxy-api/${TEST_TASK##*/} "* ]] || return 1
      if [[ "$*" == *'--next-token last '* ]]; then
        echo '{"events":[],"nextForwardToken":"last"}'
      elif [[ "$*" == *'--next-token second '* ]]; then
        if [[ "$TEST_MODE" == completed || "$TEST_MODE" == service || "$TEST_MODE" == live_definition || "$TEST_MODE" == cursor || "$TEST_MODE" == wrong_started_by || "$TEST_MODE" == stuck ]]; then
          echo '{"events":[{"message":"{\"actorUri\":\"https://bird.makeup/users/example\",\"state\":\"refused\"}"},{"message":"{\"apply\":true,\"visited\":1,\"changed\":0,\"refused\":1,\"pending\":0,\"after\":\"https://bird.makeup/users/example\"}"}],"nextForwardToken":"last"}'
        elif [[ "$TEST_MODE" == missing || "$TEST_MODE" == running ]]; then
          echo '{"events":[],"nextForwardToken":"last"}'
        else
          echo '{"events":[{"message":"{\"visited\":17,\"refused\":2}"}],"nextForwardToken":"last"}'
        fi
      else
        echo '{"events":[{"message":"first page evidence"}],"nextForwardToken":"second"}'
      fi ;;
    *) echo "Forbidden AWS call: $*" >&2; return 1 ;;
  esac
}
gh() {
  case "$1 $2" in
    'api repos/OxyHQ/oxy/actions/runs/123')
      local actor="$GITHUB_ACTOR" sha="$EXPECTED_SOURCE_SHA" path=.github/workflows/reconcile-external-identities.yml
      [[ "$TEST_MODE" != operator ]] || actor=other
      [[ "$TEST_MODE" != source ]] || sha=cccccccccccccccccccccccccccccccccccccccc
      [[ "$TEST_MODE" != workflow ]] || path=.github/workflows/arbitrary.yml
      jq -nc --arg actor "$actor" --arg sha "$sha" --arg path "$path" --arg repo "$GITHUB_REPOSITORY" \
        '{id:123,repository:{full_name:$repo},head_repository:{full_name:$repo},head_sha:$sha,head_branch:"main",event:"workflow_dispatch",path:$path,actor:{login:$actor},triggering_actor:{login:$actor},status:"completed"}' ;;
    'run download')
      local directory='' next=false
      for arg in "$@"; do
        if $next; then directory="$arg"; break; fi
        [[ "$arg" != --dir ]] || next=true
      done
      mkdir -p "$directory"
      cp "$TEST_ARTIFACT" "$directory/run.json"
      if [[ "$TEST_MODE" == artifact ]]; then
        jq '.imageDigest = "sha256:bad"' "$directory/run.json" > "$directory/changed.json"
        mv "$directory/changed.json" "$directory/run.json"
      fi ;;
    *) return 1 ;;
  esac
}
# Advance Bash's phase clock without waiting or contacting AWS.
sleep() { SECONDS=$((SECONDS + 2101)); }
export -f aws gh sleep
prepare() {
  mkdir -p "$test_root/$1"
  (cd "$test_root/$1"; bash "$root/.github/scripts/prepare-external-identity-recovery.sh")
}
collect() {
  (cd "$test_root/$1"; GITHUB_OUTPUT="$test_root/$1/output" bash "$root/.github/scripts/collect-external-identity-task.sh")
}
prepare success
collect success
jq -e '.visited == 17 and .refused == 2' "$test_root/success/identity-reconciliation-report/summary.json" >/dev/null
grep -q 'first page evidence' "$test_root/success/identity-reconciliation-report/task.log"
grep -q 'stopped=true' "$test_root/success/output"
jq -e '.tasks[0] | .createdAt == "2026-09-14T06:17:34+00:00" and .startedAt == "2026-09-14T06:18:00+00:00" and .stoppingAt == "2026-09-14T07:48:00+00:00" and .stoppedAt == "2026-09-14T07:48:30+00:00"' "$test_root/success/identity-reconciliation-report/result.json" >/dev/null
! grep -R -q MUST_NOT_RETAIN "$test_root/success/identity-reconciliation-report"
for invalid in operator source workflow artifact; do
  : > "$TEST_LOG"
  if TEST_MODE="$invalid" prepare "$invalid"; then echo "Accepted invalid $invalid" >&2; exit 1; fi
  [[ ! -s "$TEST_LOG" ]]
done
for invalid in image definition; do
  prepare "$invalid"
  : > "$TEST_LOG"
  if TEST_MODE="$invalid" collect "$invalid"; then exit 1; fi
  ! grep -q 'logs get-log-events' "$TEST_LOG"
done
prepare pending
TEST_MODE=running collect pending
grep -q stopped=false "$test_root/pending/output"
[[ ! -f "$test_root/pending/identity-reconciliation-report/task.log" ]]
# Resume the same saved selector after credential refresh; never relaunch.
collect pending
grep -q stopped=true "$test_root/pending/output"
prepare snapshot
COLLECTION_MODE=snapshot TEST_MODE=running collect snapshot
grep -q 'first page evidence' "$test_root/snapshot/identity-reconciliation-report/task.log"
jq -e '.tasks[0].lastStatus == "RUNNING"' "$test_root/snapshot/identity-reconciliation-report/result.json" >/dev/null
for failed in failed missing; do
  prepare "$failed"
  if TEST_MODE="$failed" collect "$failed"; then exit 1; fi
  [[ -s "$test_root/$failed/identity-reconciliation-report/result.json" ]]
  grep -q 'first page evidence' "$test_root/$failed/identity-reconciliation-report/task.log"
done
! grep -Eq 'run-task|stop-task|register-task-definition|deregister-task-definition' "$TEST_LOG"
echo 'Identity recovery provenance, bounded polling, full logs and read-only controls: passed'

prepare completed
: > "$TEST_LOG"
COLLECTION_MODE=stop_completed TEST_MODE=completed collect completed
[[ $(grep -c 'ecs stop-task' "$TEST_LOG") == 1 ]]
jq -e '.operation == "stop_completed" and .stopRequested' "$test_root/completed/identity-reconciliation-report/stop.json" >/dev/null
for invalid in service live_definition missing cursor wrong_started_by; do
  prepare "stop-$invalid"
  : > "$TEST_LOG"
  if COLLECTION_MODE=stop_completed TEST_MODE="$invalid" collect "stop-$invalid"; then echo "Unsafe stop accepted: $invalid" >&2; exit 1; fi
  ! grep -q 'ecs stop-task' "$TEST_LOG"
done
echo 'Exact completed-task stop guards: passed'

prepare stuck
: > "$TEST_LOG"
if COLLECTION_MODE=stop_completed TEST_MODE=stuck collect stuck; then echo 'Unconfirmed stop reported success' >&2; exit 1; fi
[[ $(grep -c 'ecs stop-task' "$TEST_LOG") == 1 ]]
jq -e '.tasks[0].lastStatus == "RUNNING"' "$test_root/stuck/identity-reconciliation-report/result.json" >/dev/null
