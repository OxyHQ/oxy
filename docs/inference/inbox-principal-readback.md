# Inbox principal and ledger readback

A read-only proof that the credential selected by `INBOX_APPLICATION_KEY`
resolves to the exact Inbox application `6a37b3e61ddfd195b656819b`, carries an
effective `inference:invoke`, and that the application's owner account has
granted USD credit left after every reserve. It is step 5 of the
[Inbox production bootstrap](inbox-point-inference.md#production-bootstrap).

| Piece | Path |
|---|---|
| Command | `packages/api/scripts/readback-inbox-principal.ts` |
| Pure validator | `packages/api/src/scripts/inboxPrincipalReadback.ts` |
| Isolated task builder | `packages/api/scripts/build-inbox-principal-readback-task.ts` → `packages/api/src/scripts/inboxPrincipalReadbackTask.ts` |
| Tests | `packages/api/src/scripts/__tests__/inboxPrincipalReadback*.test.ts` |

## Operator scope

Inbox is a separate production application. This readback is permitted to
READ its metadata and nothing else:

- It does not authorize a canary, a Kaana dispatch, a smoke inference or any
  other use of the Inbox credential. A `ready` result is evidence for review,
  not a grant.
- It never repurposes, exports or copies the Inbox credential into another
  application, and grants no persistent access.
- It makes no change to Inbox identity, behavior, balance or scopes. The
  credential's public identifier is used only as the exact join key and is
  never printed; no secret, hash or token is selected.
- For Oxy/Kaana work that needs a principal, prefer the intended Kaana/Oxy
  principal when its authority is established separately; do not borrow
  Inbox's because this proof passed.

## What it proves

All reads run inside one PostgreSQL transaction whose FIRST statement is
`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`, issued before any
read. `SHOW transaction_read_only` must return `on` and
`SHOW transaction_isolation` must return `repeatable read`, or the command
fails closed before reading data. REPEATABLE READ matters: under the READ
COMMITTED default each statement takes its own snapshot, so the credential,
application, owner, profile, balance and journal could come from different
commits. The command reads only `DATABASE_URL` and `INBOX_APPLICATION_KEY`,
makes no HTTP call, mints no token and runs no inference.

- **Credential**: exactly one `application_credentials` row for the exact
  public key, of the Inbox application, `type = 'service'`, `status = 'active'`,
  and unexpired by both PostgreSQL's `now()` and `isCredentialUsable`.
- **Authority**: the Inbox application is `active` and
  `intersectScopes(credential.scopes, application.scopes)` includes
  `inference:invoke` — the rule `inboxInference.service.ts` applies at runtime.
- **Owner**: the exact `applications.owner_account_id` account exists and is
  `active`.
- **Funds (conservative)**: the owner's OWN `billing_profiles` row is active
  and USD; its `account_balances` projection is reproduced exactly by the
  `billing_ledger_postings` journal for purchased, promotional and reserved
  funds; at least one `promotional_grant` entry exists; and
  `promotional − reserved ≥ 0.01 USD`. The whole reserve is charged against the
  grant and purchased money is reported separately and never counted. A
  negative bucket is refused as a corrupt read.

Only the owner's own profile is examined. Runtime spending may draw on an
ancestor's profile (`resolveBillingAccount`); this proof does not follow that
relation. **`billing_profile_missing` means "no own profile" and does NOT prove
the owner has no inherited funds.**

## Result

One line on stdout, `INBOX_PRINCIPAL_READBACK_RESULT=<json>`, carrying only:
`schemaVersion`, `status` (`ready` | `blocked`), typed `blockedReasons`,
`database` (`transactionReadOnly: true`,
`transactionIsolation: "repeatable read"`, `writes: 0`), opaque `credentialId`,
`applicationId` and `ownerAccountId`, `effectiveInferenceInvoke`, and
`billing` (`provisioned`, `accountMode`, `currency`, USD amounts,
`minimumPromotionalUsd`, `ledgerReconciled`).

Blocked reasons: `credential_missing`, `credential_ambiguous`,
`credential_wrong_application`, `credential_not_service`,
`credential_inactive`, `credential_expired`, `application_missing`,
`application_inactive`, `effective_invoke_missing`, `owner_missing`,
`owner_inactive`, `billing_profile_missing`, `billing_profile_inactive`,
`billing_currency_not_usd`, `balance_missing`, `ledger_projection_mismatch`,
`promotional_grant_missing`, `missing_funds`.

Exit codes: `0` ready, `2` blocked (result printed), `1` failure (fixed
message on stderr, no result, the underlying error is never printed).

## Isolated task

The builder takes the EXACT live `oxy-api` task definition and emits a
one-off definition (family `oxy-oxy-api-inbox-principal-readback`) rebuilt from
an allowlist. Sidecars may exist in the live definition and are dropped. It
drops the task role, every environment value, every secret except the two
exact bindings below, port mappings, health check, `dependsOn`, mount points,
`volumesFrom` and volumes. It keeps the live execution role and the live
`awslogs` destination (without `awslogs-create-group` or `secretOptions`), so
it needs no new permission. Entry point `/usr/local/bin/bun`, command
`run packages/api/scripts/readback-inbox-principal.ts`, working directory
`/app`: the image's default server `CMD` and the base entrypoint never run, so
no server or migration starts.

| Secret | Exact SSM parameter |
|---|---|
| `DATABASE_URL` | `arn:aws:ssm:us-west-2:237343248947:parameter/oxy/oxy-api/DATABASE_URL` |
| `INBOX_APPLICATION_KEY` | `arn:aws:ssm:us-west-2:237343248947:parameter/oxy/inbox/OXY_APPLICATION_KEY` |

The builder refuses a definition that is not the exact reviewed ARN, not
`ACTIVE`, not `awsvpc`/Fargate, whose image is not an immutable production
digest, that lacks exactly one of each binding from its exact parameter, that
also carries either name as plain environment, or that does not log through
`awslogs` in `us-west-2`.

## Run path (operator, manual)

There is no workflow for this readback; the earlier routing-profile workflow is
not a template for it. Run from a reviewed checkout of `main`, with the
`oxy-github-deploy`-equivalent operator role, only after the live `oxy-api`
image was built from a commit that contains the command. Do not print
anything from the task's log stream except the result line.

```bash
set -euo pipefail
umask 077
CLUSTER=oxy-cluster SERVICE=oxy-api CONTAINER=oxy-api

# 1. The live service must be at one completed deployment; record its exact ARN.
service_json=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0]' --output json)
jq -e '.status == "ACTIVE" and (.deployments | length) == 1 and
       .deployments[0].rolloutState == "COMPLETED" and .runningCount == .desiredCount' \
  <<<"$service_json" >/dev/null
LIVE_ARN=$(jq -er '.taskDefinition' <<<"$service_json")
NETWORK=$(jq -ec '.networkConfiguration' <<<"$service_json")

# 2. Build and REVIEW the isolated definition (no AWS call in the builder).
aws ecs describe-task-definition --task-definition "$LIVE_ARN" \
  --query taskDefinition --output json > live-task.json
bun run packages/api/scripts/build-inbox-principal-readback-task.ts \
  "$LIVE_ARN" live-task.json > readback-task.json
jq . readback-task.json   # review: one container, two secrets, no task role

# 3. Register, run once, and always deregister.
READBACK_ARN=$(aws ecs register-task-definition --cli-input-json file://readback-task.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)
trap 'aws ecs deregister-task-definition --task-definition "$READBACK_ARN" >/dev/null' EXIT
TASK_ARN=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$READBACK_ARN" \
  --launch-type FARGATE --network-configuration "$NETWORK" \
  --started-by inbox-principal-readback --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query "tasks[0].containers[?name=='$CONTAINER'].exitCode" --output text

# 4. Read ONLY the result line.
LOG_GROUP=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-group"]' readback-task.json)
LOG_PREFIX=$(jq -er '.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]' readback-task.json)
aws logs get-log-events --log-group-name "$LOG_GROUP" \
  --log-stream-name "$LOG_PREFIX/$CONTAINER/${TASK_ARN##*/}" --start-from-head \
  --query 'events[].message' --output json |
  jq -r '.[] | select(startswith("INBOX_PRINCIPAL_READBACK_RESULT="))'
rm -f live-task.json readback-task.json
```
