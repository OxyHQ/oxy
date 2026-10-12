#!/usr/bin/env bash
#
# Drives deploy-asset-variant-worker.sh `start` against a fake aws CLI.
#
# The running revision may name `node` or `bun` (the API image is Bun's, and
# `node` there is a symlink to bun); both must deploy, the registered revision
# must name `bun`, and any other command must still be refused before anything
# is registered.

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_directory="$(mktemp -d)"
temporary_root="$(realpath "${TMPDIR:-/tmp}")"
test_directory="$(realpath "$test_directory")"

cleanup_test_directory() {
  if [[ "$test_directory" == "$temporary_root/"* && -d "$test_directory" ]]; then
    rm -rf -- "$test_directory"
  else
    echo "Refusing to remove unexpected test directory: $test_directory" >&2
  fi
}
trap cleanup_test_directory EXIT

mkdir -p "$test_directory/bin"

# The fake serves the running revision with FAKE_COMMAND, records what is
# registered, and reports the new revision as fully replaced once registered.
cat >"$test_directory/bin/aws" <<'FAKE_AWS'
#!/usr/bin/env bash
set -euo pipefail
old_arn="arn:aws:ecs:us-west-2:1:task-definition/oxy-oxy-asset-variant-worker:7"
new_arn="arn:aws:ecs:us-west-2:1:task-definition/oxy-oxy-asset-variant-worker:8"
case "$1 $2" in
  "ecs describe-services")
    if [[ -f "$FAKE_STATE/registered.json" ]]; then
      printf '{"failures":[],"services":[{"status":"ACTIVE","taskDefinition":"%s","deployments":[{"status":"PRIMARY","taskDefinition":"%s","desiredCount":1,"runningCount":1,"rolloutState":"IN_PROGRESS"}]}]}' "$new_arn" "$new_arn"
    else
      printf '{"failures":[],"services":[{"status":"ACTIVE","taskDefinition":"%s","deployments":[]}]}' "$old_arn"
    fi
    ;;
  "ecs describe-task-definition")
    jq -n --argjson command "$FAKE_COMMAND" --arg arn "$old_arn" '{
      taskDefinitionArn: $arn, revision: 7, status: "ACTIVE", family: "oxy-oxy-asset-variant-worker",
      containerDefinitions: [{name: "oxy-asset-variant-worker", image: "old", command: $command, secrets: []}]
    }'
    ;;
  "ecs register-task-definition")
    shift 2
    while (($# > 0)); do
      case "$1" in
        --cli-input-json) printf '%s' "$2" >"$FAKE_STATE/registered.json"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '%s\n' "$new_arn"
    ;;
  "ecs update-service") ;;
  *) echo "Unexpected fake aws call: $*" >&2; exit 2 ;;
esac
FAKE_AWS
chmod +x "$test_directory/bin/aws"

failures=0
cases=0

run_case() {
  local expectation="$1" label="$2" command_json="$3"
  local state="$test_directory/state-$cases" exit_code=0
  cases=$((cases + 1))
  mkdir -p "$state"
  PATH="$test_directory/bin:$PATH" \
    FAKE_STATE="$state" \
    FAKE_COMMAND="$command_json" \
    AWS_REGION=us-west-2 CLUSTER=oxy IMAGE_URI=registry/oxy-api@sha256:new \
    WORKER_ROLLOUT_ATTEMPTS=1 WORKER_ROLLOUT_POLL_SECONDS=0 \
    bash "$repository_root/.github/scripts/deploy-asset-variant-worker.sh" start \
    >"$state/out.log" 2>&1 || exit_code=$?

  if [[ "$expectation" == pass ]]; then
    if [[ "$exit_code" != 0 ]]; then
      echo "FAIL ($label): expected success, got exit $exit_code"; cat "$state/out.log"
      failures=$((failures + 1)); return
    fi
    local registered
    registered="$(jq -c '.containerDefinitions[0].command' "$state/registered.json")"
    if [[ "$registered" != '["bun","packages/api/dist/asset-variant-worker.js"]' ]]; then
      echo "FAIL ($label): registered command $registered, expected bun (the image's runtime)"
      failures=$((failures + 1)); return
    fi
    if [[ "$(jq -r '.containerDefinitions[0].image' "$state/registered.json")" != registry/oxy-api@sha256:new ]]; then
      echo "FAIL ($label): the registered revision does not carry the deploying image"
      failures=$((failures + 1)); return
    fi
  else
    if [[ "$exit_code" == 0 ]]; then
      echo "FAIL ($label): expected refusal, got success"; cat "$state/out.log"
      failures=$((failures + 1)); return
    fi
    if ! grep -q 'unexpected command' "$state/out.log"; then
      echo "FAIL ($label): refused, but not for the command"; cat "$state/out.log"
      failures=$((failures + 1)); return
    fi
    if [[ -e "$state/registered.json" ]]; then
      echo "FAIL ($label): a revision was registered before the refusal"
      failures=$((failures + 1)); return
    fi
  fi
  echo "ok   $label"
}

run_case pass 'bun command' '["bun","packages/api/dist/asset-variant-worker.js"]'
run_case pass 'node command' '["node","packages/api/dist/asset-variant-worker.js"]'
run_case fail 'the API server instead of the worker' '["bun","packages/api/dist/server.js"]'
run_case fail 'an extra argument' '["bun","packages/api/dist/asset-variant-worker.js","--x"]'
run_case fail 'a shell wrapper' '["sh","-c","bun packages/api/dist/asset-variant-worker.js"]'
run_case fail 'no command at all' 'null'

if ((failures > 0)); then
  echo "deploy-asset-variant-worker.sh: $failures of $cases case(s) failed"
  exit 1
fi
echo "deploy-asset-variant-worker.sh behaves: $cases cases"
