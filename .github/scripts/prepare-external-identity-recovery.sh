#!/usr/bin/env bash
# Authenticate the prior run before AWS credentials; no task ARN is accepted as input.
set -euo pipefail
[[ "${GITHUB_REF:-}" == refs/heads/main && "${GITHUB_REF_PROTECTED:-}" == true ]] || exit 1
[[ "${GITHUB_ACTOR:-}" != '' && "${GITHUB_TRIGGERING_ACTOR:-}" == "$GITHUB_ACTOR" ]] || exit 1
[[ "${RECOVERY_RUN_ID:-}" =~ ^[0-9]+$ ]] || exit 1
[[ "${EXPECTED_SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${EXPECTED_IMAGE_DIGEST:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RECOVERY_RUN_ID" > "$scratch/prior.json"
jq -e --arg actor "$GITHUB_ACTOR" --arg sha "$EXPECTED_SOURCE_SHA" --arg repo "$GITHUB_REPOSITORY" --argjson id "$RECOVERY_RUN_ID" '
  .id == $id and .repository.full_name == $repo and .head_repository.full_name == $repo
  and .head_sha == $sha and .head_branch == "main" and .event == "workflow_dispatch"
  and .path == ".github/workflows/reconcile-external-identities.yml"
  and .actor.login == $actor and .triggering_actor.login == $actor
  and .status == "completed"
' "$scratch/prior.json" >/dev/null
gh run download "$RECOVERY_RUN_ID" --repo "$GITHUB_REPOSITORY" \
  --name "external-identity-reconciliation-$RECOVERY_RUN_ID" --dir "$scratch/artifact"
jq -e --arg sha "$EXPECTED_SOURCE_SHA" --arg digest "$EXPECTED_IMAGE_DIGEST" '
  .expectedSourceSha == $sha and .imageDigest == $digest
  and (.operation == "reconcile" or .operation == "inspect_cache")
  and (.dryRun | type == "boolean")
  and (.taskArn | test("^arn:aws:ecs:us-west-2:237343248947:task/oxy-cluster/[0-9a-f]{32}$"))
' "$scratch/artifact/run.json" >/dev/null
mkdir -p identity-reconciliation-report
# Copy only known report fields, never execute or source anything in the artifact.
jq '{operation,expectedSourceSha,imageDigest,taskArn,dryRun} + (if has("identifiers") then {identifiers:{actorUri:.identifiers.actorUri,canonicalAcct:.identifiers.canonicalAcct,transportAcct:.identifiers.transportAcct}} else {} end)' \
  "$scratch/artifact/run.json" > identity-reconciliation-report/run.json
jq '{id,head_sha,head_branch,event,path,actor:{login:.actor.login},triggering_actor:{login:.triggering_actor.login}}' "$scratch/prior.json" > identity-reconciliation-report/prior-run.json
