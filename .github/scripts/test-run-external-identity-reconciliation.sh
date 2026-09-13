#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
export GITHUB_REF_PROTECTED=true GITHUB_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export GITHUB_REF=refs/heads/main EXPECTED_SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa DRY_RUN=true AFTER_CURSOR=''
export TEST_DIGEST="sha256:$(printf 'b%.0s' {1..64})" TEST_MODE=success TEST_EXIT=0
export TEST_LOG="$test_root/aws.log"
aws() {
  printf '%s\n' "$*" >> "$TEST_LOG"
  case "$1 $2" in
    'ecs describe-services') printf '%s\n' '{"failures":[],"services":[{"status":"ACTIVE","desiredCount":1,"runningCount":1,"pendingCount":0,"taskDefinition":"arn:aws:ecs:r:a:task-definition/api:1","deployments":[{"rolloutState":"COMPLETED"}],"networkConfiguration":{"awsvpcConfiguration":{"subnets":["subnet-a"],"securityGroups":["sg-a"],"assignPublicIp":"ENABLED"}}}]}' ;;
    'ecs describe-task-definition') printf '%s\n' '{"taskDefinitionArn":"arn:aws:ecs:r:a:task-definition/api:1","family":"api","taskRoleArn":"preserved-role","containerDefinitions":[{"name":"aws-otel-collector","image":"otel-image","essential":false},{"name":"oxy-api","image":"237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api:latest","secrets":[{"name":"DATABASE_URL","valueFrom":"preserved-secret-arn"}],"logConfiguration":{"options":{"awslogs-group":"logs","awslogs-stream-prefix":"ecs"}}}]}' ;;
    'ecr batch-get-image') echo "$TEST_DIGEST" ;;
    'ecs list-tasks') echo '{"taskArns":["arn:aws:ecs:r:a:task/live"]}' ;;
    'ecs describe-tasks')
      if [[ "$*" == *task/live* ]]; then
        local digest="$TEST_DIGEST"
        [[ "$TEST_MODE" != mismatch ]] || digest="sha256:$(printf 'c%.0s' {1..64})"
        jq -nc --arg digest "$digest" '{failures:[],tasks:[{taskDefinitionArn:"arn:aws:ecs:r:a:task-definition/api:1",lastStatus:"RUNNING",containers:[{name:"oxy-api",imageDigest:$digest}]}]}'
      else
        jq -nc --argjson code "$TEST_EXIT" '{failures:[],tasks:[{taskArn:"arn:aws:ecs:r:a:task/run",lastStatus:"STOPPED",containers:[{name:"oxy-api",exitCode:$code}]}]}'
      fi ;;
    'ecs register-task-definition')
      local next=false file=''
      for arg in "$@"; do
        if $next; then file="${arg#file://}"; break; fi
        [[ "$arg" != --cli-input-json ]] || next=true
      done
      jq -e --arg image "237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/oxy-api@$TEST_DIGEST" '.taskRoleArn == "preserved-role" and ([.containerDefinitions[] | select(.name == "oxy-api" and .image == $image and .secrets[0].valueFrom == "preserved-secret-arn" and .linuxParameters.initProcessEnabled == true)] | length == 1) and .containerDefinitions[0].image == "otel-image" and (has("taskDefinitionArn") | not)' "$file" >/dev/null || return 1
      echo 'arn:aws:ecs:r:a:task-definition/api:2' ;;
    'ecs run-task')
      local next=false override=''
      for arg in "$@"; do
        if $next; then override="$arg"; break; fi
        [[ "$arg" != --overrides ]] || next=true
      done
      if [[ "${OPERATION_MODE:-reconcile}" == inspect_cache ]]; then
        jq -e --arg actor "$ACTOR_URI" --arg canonical "$CANONICAL_ACCT" --arg transport "$TRANSPORT_ACCT" --arg sha "$EXPECTED_SOURCE_SHA" --arg digest "$TEST_DIGEST" '.containerOverrides | length == 1 and .[0].command == ["busybox","timeout","-s","TERM","-k","30","120","bun","run","packages/api/scripts/inspect-external-identity-cache.ts","--actor-uri="+$actor,"--canonical-acct="+$canonical,"--transport-acct="+$transport,"--source-sha="+$sha,"--image-digest="+$digest] and (.[0] | has("environment") | not)' <<< "$override" >/dev/null || return 1
      else
      jq -e --arg dry "$DRY_RUN" --arg cursor "$AFTER_CURSOR" '.containerOverrides | length == 1 and .[0].command == (["busybox","timeout","-s","TERM","-k","30","5400","bun","run","packages/api/scripts/reconcile-external-identities.ts"] + (if $dry == "false" then ["--apply"] else [] end) + (if $cursor != "" then ["--after="+$cursor] else [] end)) and (.[0] | has("environment") | not)' <<< "$override" >/dev/null || return 1
      fi
      if [[ "$TEST_MODE" == capacity && ! -f "$TEST_LOG.capacity" ]]; then
        touch "$TEST_LOG.capacity"
        echo '{"tasks":[],"failures":[{"reason":"RESOURCE:CPU"}]}'
      else echo '{"tasks":[{"taskArn":"arn:aws:ecs:r:a:task/run"}],"failures":[]}'; fi ;;
    'ecs wait')
      if [[ "$TEST_MODE" == cancel ]]; then kill -TERM "$BASHPID"; else :; fi ;;
    'ecs stop-task'|'ecs deregister-task-definition') echo '{}' ;;
    'logs get-log-events')
      if [[ "$*" == *--next-token* ]]; then echo '{"events":[],"nextForwardToken":"end"}'
      elif [[ "${OPERATION_MODE:-reconcile}" == inspect_cache && "$TEST_MODE" != wrong_summary ]]; then
        jq -nc --arg sha "$EXPECTED_SOURCE_SHA" --arg digest "$TEST_DIGEST" '{events:[{message:({operation:"inspect_cache",sourceSha:$sha,imageDigest:$digest,observedAt:"2026-09-13T00:00:00.000Z",counts:{users:0,registryActors:0,registryIdentities:0},absent:true}|tojson)}],nextForwardToken:"end"}'
      else echo '{"events":[{"message":"{\"visited\":1,\"refused\":0}"}],"nextForwardToken":"end"}'; fi ;;
    *) echo "Unexpected AWS call: $*" >&2; return 1 ;;
  esac
}
sleep() { :; }
export -f aws sleep
run_case() {
  mkdir -p "$test_root/$1"
  (cd "$test_root/$1"; bash "$root/.github/scripts/run-external-identity-reconciliation.sh")
}
for invalid in branch protection coherence sha dry cursor; do
  : > "$TEST_LOG"
  case "$invalid" in
    protection) if GITHUB_REF_PROTECTED=false run_case "$invalid"; then exit 1; fi ;;
    coherence) if GITHUB_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb run_case "$invalid"; then exit 1; fi ;;
    branch) if GITHUB_REF=refs/heads/evil run_case "$invalid"; then exit 1; fi ;;
    sha) if EXPECTED_SOURCE_SHA='latest' run_case "$invalid"; then exit 1; fi ;;
    dry) if DRY_RUN='false; touch /tmp/no' run_case "$invalid"; then exit 1; fi ;;
    cursor) if AFTER_CURSOR='https://actor/$(whoami)' run_case "$invalid"; then exit 1; fi ;;
  esac
  [[ ! -s "$TEST_LOG" ]]
done
: > "$TEST_LOG"
if TEST_MODE=mismatch run_case mismatch; then exit 1; fi
! grep -q 'register-task-definition\|run-task' "$TEST_LOG"
for mode in success capacity; do
  : > "$TEST_LOG"
  TEST_MODE="$mode" run_case "$mode"
  grep -q 'stop-task' "$TEST_LOG"
  grep -q 'deregister-task-definition' "$TEST_LOG"
  grep -q '"visited":1' "$test_root/$mode/identity-reconciliation-report/task.log"
done
: > "$TEST_LOG"
LAUNCH_ONLY=true run_case launch
jq -e '.taskDefinitionArn == "arn:aws:ecs:r:a:task-definition/api:2"' "$test_root/launch/identity-reconciliation-report/run.json" >/dev/null
! grep -Eq 'ecs wait|stop-task|deregister-task-definition|logs get-log-events' "$TEST_LOG"
DRY_RUN=false AFTER_CURSOR='https://bridge.example/users/person' run_case apply
: > "$TEST_LOG"
if TEST_EXIT=2 run_case refused; then exit 1; fi
grep -q 'stop-task' "$TEST_LOG"
grep -q 'deregister-task-definition' "$TEST_LOG"
: > "$TEST_LOG"
if TEST_MODE=cancel run_case canceled; then exit 1; fi
grep -q 'stop-task' "$TEST_LOG"
grep -q 'deregister-task-definition' "$TEST_LOG"
: > "$TEST_LOG"
if TEST_EXIT=124 run_case timedout; then exit 1; fi
grep -q 'stop-task' "$TEST_LOG"
grep -q 'deregister-task-definition' "$TEST_LOG"
! grep -q 'describe-images' "$TEST_LOG"
export ACTOR_URI=https://bird.makeup/users/example CANONICAL_ACCT=example@x.com TRANSPORT_ACCT=example@bird.makeup OPERATION_MODE=inspect_cache
: > "$TEST_LOG"
run_case inspected
grep -q 'inspect-external-identity-cache.ts' "$TEST_LOG"
! grep -q 'reconcile-external-identities.ts' "$TEST_LOG"
jq -e '.operation == "inspect_cache" and .absent == true' "$test_root/inspected/identity-reconciliation-report/summary.json" >/dev/null
for invalid in apply mixed unknown injection; do
  : > "$TEST_LOG"
  case "$invalid" in
    apply) if DRY_RUN=false run_case inspect-apply; then exit 1; fi ;;
    mixed) if AFTER_CURSOR=https://bird.makeup/users/a run_case inspect-mixed; then exit 1; fi ;;
    unknown) if OPERATION_MODE=arbitrary run_case inspect-unknown; then exit 1; fi ;;
    injection) if ACTOR_URI='https://evil/$(touch x)' run_case inspect-injection; then exit 1; fi ;;
  esac
  [[ ! -s "$TEST_LOG" ]]
done
if TEST_MODE=wrong_summary run_case wrong-summary; then exit 1; fi
echo 'Identity ECS reconciliation guards and lifecycle: passed'
