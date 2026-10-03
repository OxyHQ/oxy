# Mercaria authority CAS through a database-only ECS task

This transport runs the existing compiled `mercariaBillingAuthority.service`
from the reviewed, deployed API image. It adds no API endpoint, runtime export,
schema, grant, credential, or image build. The three allowed operations are
`prepare`, `apply`, and `rollback`, for the exact existing Mercaria application,
production service credential, and owner named in the runner.

The operator executes AWS CLI locally. STS account/ARN/UserId and the reviewed
request are retained in private receipts. The task has no task role, AWS CLI,
HTTP listener, mounts, provider secrets, or credential material. Its only secret
reference is the deployed API's exact `DATABASE_URL`; execution role, network,
log destination, architecture, and digest are copied from the verified live
API. Node loads no dotenv file. The attribution inside the task is a trusted
launcher assertion, not an independent AWS authentication or a user grant.

The runner is embedded verbatim in the task definition and hashed in the plan.
It validates the request/hash before importing the fixed compiled service.
The existing service owns account/key ownership, closure checks, row locks,
xmin/timestamp CAS, and the two-row transaction. The result contains only
scopes, versions, timestamps, the fixed IDs, and attribution. All errors from
runtime/database execution are replaced with one fixed diagnostic.

## Operator sequence

Root is the only live operator. These are command shapes, not evidence of a
production execution. First verify the final API image/source and receiver
readiness. The current inventory helper requires a steady, nonzero API service;
this operation follows the final backend promotion, not the paused interval.
Set `OPERATOR_ARN` to the independently reviewed current STS ARN and `API_TD` to
the exact final revision. Use a new private parent directory owned by the
operator. Never reuse an execution directory.

```sh
python3 scripts/auth/mercaria-billing-authority-ecs.py \
  --mode prepare --definition "$API_TD" --expected-operator-arn "$OPERATOR_ARN" \
  --plan "$PRIVATE_ROOT/prepare-plan/plan.json" --output "$PRIVATE_ROOT/prepare-plan"
```

Review the plan, its byte SHA256, runner/launcher/common transport hashes, exact
image digest/configuration, attribution, and the DB-only task definition.
Plans expire after 30 minutes. Then root executes that exact plan:

```sh
python3 scripts/auth/mercaria-billing-authority-ecs.py --execute \
  --plan "$PRIVATE_ROOT/prepare-plan/plan.json" --plan-sha256 "$PLAN_SHA256" \
  --output "$PRIVATE_ROOT/prepare-execution"
```

This first task only obtains the canonical read-only CAS plan. Prepare an
`apply` transport plan with `--input` pointing to that execution's
`result.private.json`, plus its exact `--input-sha256`, fresh STS and final TD.
Review before executing. A rollback plan instead consumes the exact successful
apply `result.private.json` and uses `--mode rollback`; the original service
refuses rollback after any intervening row change. Each phase has its own
plan/nonce and new output directory. This transport does not create or enlarge
user grants and does not enable a billing cohort.

## Uncertain completion and cleanup

Before register/run, reserve the attempt and result files (0600 in 0700 owned
parent), with no overwrite or symlink. Before RunTask, retain the registered TD,
startedBy, and deterministic client token. There is exactly one dispatch in an
execution; no automatic retry. Output receipt validation binds mode, nonce,
operator receipt hash, exact target, before-state, and operation.

If registration, launch acknowledgement, DB commit, or receipt collection is
uncertain, an empty reserved result is **not** success. Stop and reconcile the
original AWS task/CloudTrail and its exact log stream using the retained nonce,
TD, startedBy, and client token. A committed result can be recovered from that
stream and validated with `decode`; do not fabricate a receipt from scopes or
issue a new intent. If logs cannot establish completion, obtain an independently
reviewed read-only snapshot of the exact two rows before deciding recovery. A
rollback needs the original apply receipt with its exact resulting xmin; there
is no blind rollback mode.

Cleanup independently verifies owned task STOPPED and TD INACTIVE. Failure to
stop does not skip deregistration, and incomplete cleanup remains a failure.
Deregistering a TD does not itself stop a task. A missing RunTask acknowledgement
may require manual reconciliation because the launcher has no returned ARN.
No claim is made that this local test proves live IAM permissions; root reviews
the current role, plan and readbacks before dispatch.

## Local validation

Source API service is unchanged from `20013421a4cc07545a7685931db68f4ee55f1773`.
The package's `bun run build` passed. Offline Python tests cover DB-only payload,
strict input, source/configuration/operator drift, expiry, lost receipt, one
dispatch, no overwrite, and independent cleanup (12 PASS).

The Node test executes the **same eval command** with the compiled production
service and real SQL in a new database created by the canonical migration
harness (4 PASS). It covers prepare/apply/rollback, unrelated fields/public
credential, replay refusal, separate-process xmin ABA, closure fence, wrong
owner, extra payload and input hash. STS is synthetic in this local fixture;
no AWS, HTTP provider, customer, grants or financial effects occur.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/auth/test-mercaria-billing-authority-ecs.py
# Only an owned loopback PostgreSQL server; the fixture refuses other hosts.
AUTHORITY_TEST_ADMIN_URL=postgres://nate@127.0.0.1:5595/postgres \
  node --test scripts/auth/test-mercaria-billing-authority.mjs
```

PG17 belonged to this worktree's test evidence directory, UID1000, loopback5595.
The final test verifies its DB disappears after teardown; the final census has
zero `oxy_test_*` databases, and this owned PG server was stopped. Two earlier
fixture failures (missing required credential name, then omitted drop argument)
are retained as setup/teardown errors, not product REDs. Their two owned databases
were explicitly removed using the guarded canonical drop helper before the
final run. No shared PostgreSQL instance was stopped.

Production apply, live readbacks, ephemeral development credential, technical
merchant namespace and exact provider/store cohort remain separate reviewed
operations. This handoff completes only the missing transport.
