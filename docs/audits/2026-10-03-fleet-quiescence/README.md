# External fleet quiescence preparation

This helper is delivered separately from the final Oxy image. It has not
performed an AWS capture or mutation. Its tests isolate AWS responses; the
JavaScript export control imports the actual final deployment guard from Git.
Root operates the reviewed plan only after final image/CI/provenance acceptance.

The fixed scope is the 33 services in the root fleet preparation. The 23
consumers are `crowdsource`, `move`, `mention`, `mention-mcp`,
`alia-integrations`, `allo`, `tnp-api`, `relay`, `clarity-api`, `noted`, `moovo`,
`clarity-worker`, `homiio-worker`, `alia`, `relay-publisher`, `willo`, `peable`,
`syra`, `mercaria`, `website-api`, `nilo`, `goway`, and `homiio`. They stop before
`oxy-api`, then `oxy-asset-variant-worker`. The other eight services remain
outside the mutation scope: `gwj-mcp`, `allo-matrix`, `kaana`, `goway-routing`,
`kaana-publisher`, `tnp-relay`, `gwj-backend`, and `tnp-dns`.

Capture requires the exact current 33-service set, a completed stable deployment
for each affected service, digest-bearing running containers, both desired
RUNNING and STOPPED task censuses, full explicit task readbacks, all current/live
TD configuration hashes, scaling targets and scheduled actions, Scheduler and
EventBridge metadata, service configuration, network, target groups, and target
health. Environment values are hashed in memory, not included in snapshots.
Parameter references are metadata; no secret is retrieved. Active standalone
tasks, scheduled startup/scaling, missing task readbacks, mixed live TDs, changed
configuration, or incomplete pagination block advancement.

The source and file hashes of a clean deployment checkout are bound into the
private plan. The guard must be exactly
`83f0c0129e07cef65f433e2439a307ee683d447cb7533c2d0c2b0c51b760cc92`
and `deploy-aws.yml` must be exactly
`0a1ca1132d65459be53a7e7d846a8dc19400d495173943474cd0f887e5556ca8`.
These are the reviewed final guard/workflow in `8c8163755`; a later declaration
commit can be used only when these and the other pinned deployment files remain
identical. This binding does not itself authenticate an image or replace the
image's independent security gate.

Before the first write, capture is repeated and compared with the plan. Existing
scalers retain min/max/role and receive all three suspension flags; no new
scaler is created. All scaler writes precede any desired-count write. Every
mutation has an exclusive private fsynced intent before one dispatch and an ACK
record after confirmation. An exception, timeout, interrupt, or unknown ACK
stops advancement without retry or restoration. Reads may poll for stopping and
drain; writes are never retried automatically. Reconcile an unknown intent by
fresh AWS observations before any deliberate new operation.

Both task censuses are retained throughout. Zero desired/running/pending counts
are insufficient: all remembered live task IDs must have explicit actual and
desired STOPPED readbacks, every deployment must have zero counts, and target
groups must be empty. A disappeared task is not proof of stopping. Final
readback also checks excluded services and rejects affected/standalone active
tasks in the cluster. Poll deadlines leave the fleet paused for operator review.
There is no cross-service atomicity or guaranteed AWS snapshot; drift blocks
advancement, and the canonical deployment guard repeats live checks before DDL
and before installing the final API TD.

## Operator commands

Run from this separate helper checkout. Output must be outside it, in a private
operator directory. The deployment checkout must be clean, including untracked
files; preserve existing work rather than deleting it to satisfy that check.
The following arguments are placeholders for root's exact verified handles.
Default invocation performs only a fresh read-only capture and writes a plan:

```bash
python3 -B scripts/operations/fleet-quiescence.py \
  --plan /private/fleet-plan.json \
  --deployment-checkout /private/verified-final-checkout \
  --deployment-source FINAL_SOURCE_SHA \
  --final-image FINAL_VERIFIED_ECR_DIGEST_URI
```

Root reviews the private plan, helper hash, exact image/source pins, operator,
current counts, task IDs, target groups, scaler state, and config hashes. The
write plan expires 30 minutes after preparation. Execution never migrates,
publishes, registers a TD, launches a task, or restores consumers/scalers:

```bash
python3 -B scripts/operations/fleet-quiescence.py \
  --execute --plan /private/fleet-plan.json --output /private/fleet-operation
python3 -B scripts/operations/fleet-quiescence.py \
  --observe --plan /private/fleet-plan.json --output /private/fleet-readback.json
```

After successful quiescence, `quiesced-deploy-plan.json` is checked by the exact
canonical guard's `validatePlan` and recorded in `receipt.json`.
`deployPlanCanonicalSha256` hashes the sorted canonical JSON object;
`deployPlanFileSha256` hashes the actual pretty-printed file bytes. The workflow
requires the **file byte hash**, not the canonical object hash. Supply the exact
bytes, including the final newline, as `QUIESCED_DEPLOY_PLAN_JSON` and their
`deployPlanFileSha256` as `QUIESCED_DEPLOY_PLAN_SHA256`; do not use shell command
substitution that removes the final newline. Use the workflow's structured input
mechanism (or JSON serialize `Path.read_text()` as the input value) to preserve
bytes. Independent confirmation:

```bash
sha256sum /private/fleet-operation/quiesced-deploy-plan.json
```

## Failure hold

`--hold-api` takes the original fleet plan and a reviewed attempt JSON with
exactly `newTaskDefinition` and `attemptedTasks`. The new TD must contain the
exact final API image, with all other TD configuration unchanged. The current
API may use the baseline or new TD. All service configuration except deployment
configuration must remain identical. Deployment configuration may be the exact
baseline, or the exact canonical maintenance update: circuit breaker enabled,
rollback disabled, min healthy 100, max percent 200 (pinned workflow), preserving
AWS defaults such as reset-on-healthy, threshold, strategy and bake time. Any
other delta is rejected. The hold changes only API desired count to zero.

```bash
python3 -B scripts/operations/fleet-quiescence.py \
  --hold-api --plan /private/fleet-plan.json \
  --attempt /private/reviewed-attempt.json --output /private/api-hold
```

It remembers both old and attempted/new tasks, checks missing and STOPPING tasks
rather than discarding them, and confirms zero counts/TG drain/suspension. Zero
FAILED/multiple deployments may be held once every count/task is stopped; an
active ambiguous service is not admitted. `held-api.json` explicitly states that
no recovery was launched. Other services require their own quiescence proof.
There is no automatic old-image rollback. Root's separately registered
`oxy-oxy-api-auth-only-recovery:1` and immutable AUTH-only image require their own
reviewed recovery admission; the ordinary old `:692` bootstrap starts writers
and must not be restored as recovery. A later final-TD switch also requires
explicit root control, not reusing this hold as permission to run business work.

## Validation and limits

```bash
python3 -B scripts/operations/tests/test-fleet-quiescence.py
python3 -B scripts/operations/fleet-quiescence.py --help
```

Tests check the protocol with synthetic AWS records and actual local filesystem
intent/ACK writes. They do not demonstrate AWS IAM permission, stopping a live
fleet, scaler restoration, the AUTH-only recovery window, or rollout success.
The pure guard comparison uses the exact Git blob, including safe hash parity;
no AWS call runs through that JavaScript import. No DB or product source changes
are part of this delivery. Root's previous metadata snapshots are context, not a
replacement for the required fresh capture.
