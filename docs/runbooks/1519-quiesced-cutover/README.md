# Quiesced Oxy cutover

This manual protected-main option keeps the normal deploy guard that rejects
zero capacity. It is a maintenance deployment with downtime, not an auth bypass.
The normal Forge/merge-queue image checks still run before the deployment. The
maintenance plan contains only IDs, digests and counts; never put secret values
in workflow inputs or the plan.

Root must review the exact operational plan before any service/scaler writes.
Capture live TD/config/image, every old task ID, target groups, previous desired
count, and scaler min/max. Suspend dynamic in/out and scheduled scaling, stop
admission and the exact affected callers/workers, set the API to zero, and prove
old tasks STOPPED and target groups empty. Do not infer STOPPED from counters or
from the desiredRUNNING task list. Preserve queued jobs and financial/history
rows. An application with zero offline grants may still make application-only
calls; this option creates no consent or grants.

Dispatch `deploy-aws.yml` with `quiesced_deploy_plan` and its exact byte SHA256 in
`quiesced_deploy_plan_sha256`. Do not combine it with `issuer_image_only`. The
input is rejected before AWS login unless it is manual/main, the committed policy
is ACTIVE, its source SHA equals the Actions source and its schema is exact.
The final image must equal the image selected by the ordinary workflow gate.
Config and secrets are inherited; GitHub-to-SSM sync, overrides and automatic
Inbox registration are skipped. Canonical pre-DDL and any planned post-DDL still
run. The schema142 and final queue compatibility rehearsals remain separate
acceptance evidence; mocked deploy tests do not prove production compatibility.

The plan has exactly these fields:

```json
{
  "schemaVersion": 1,
  "region": "us-west-2",
  "cluster": "oxy-cluster",
  "service": "oxy-api",
  "container": "oxy-api",
  "previousTaskDefinition": "<exact live ARN>",
  "previousImage": "<repository@sha256:digest>",
  "previousShapeSha256": "<canonical previous TD shape hash>",
  "finalImage": "<reviewed workflow image repository@sha256:digest>",
  "sourceSha": "<exact merged Actions source SHA>",
  "restoreCount": 2,
  "previousTasks": ["<all old task ARNs>"],
  "targetGroups": ["<exact service target-group ARNs>"],
  "scaler": {"min": 2, "max": 6}
}
```

`scaler` may be null only if AWS returns no scalable target for this service.
The previous shape hash uses `shapeHash` in the guard, excluding ECS registration
metadata and sorting object keys, retaining all arrays/config values. Only the
application image may change in the rendered and registered TD; both are checked.
The guard re-reads live API/scaler/task/TG state immediately before the one
`update-service` call that selects the new TD and restores the captured positive
count. AWS does not offer conditional update by previous TD: external serialized
operation and workflow concurrency are required. This is not an atomic preflight
CAS claim.

The canonical worker start/wait gates remain intact. The root operator watcher
must keep the asset worker at zero until migration has succeeded and the workflow
has selected its exact final TD/image/config, with all old tasks STOPPED. Only
then restore its captured count and set circuit-breaker rollback to false in the
same service update while scaling stays suspended. Canonical worker start sets
rollback true even at zero; the watcher must replace that value before starting
consumers so a failure cannot relaunch the old worker after migration. Use the
live captured count (currently four), never an assumed one. This lets normal
worker-start finish before the API producer is started. A separate reviewed
watcher plan and job compatibility gate are still required; this document does
not perform that operation or authorize an unverified worker restart.

Maintenance disables ECS automatic rollback to the old normal API bootstrap.
On failure after API activation, the helper accepts only its baseline/new TD,
holds desired count at zero, records old/new attempted task IDs (including
STOPPING tasks), and confirms every tracked task STOPPED, empty TGs and suspended
scalers. Missing tasks, foreign TD drift or unknown state fail closed; the log
must not claim cleanup success. Before cutover a migration/preflight failure
leaves API count0. An already restored worker must be stopped by the root watcher
failure handler before any rollback. Unused registered definitions and failed
one-shot cleanup must be read back and retired by the operator; the ordinary
helper reports unfinished tasks because the deploy role lacks `ecs:StopTask`.

AUTH-only recovery is separately reviewed/gated; neither this option nor its
failure handler starts TD692/old normal jobs. Keep affected admission/workers
paused until the new backend, final published SDK receivers, exact authority
prerequisites and canaries pass. Restore service groups individually and scalers
last. Keep Move background user delegation paused until its legitimate authority
flow is resolved; do not invent consent to make a smoke green.

Local validation: the real canonical shell is exercised against a mocked AWS
CLI for migration → worker → new API ordering, single TD/count restore, failure
hold0 without old bootstrap, normal count0 refusal and baseline drift refusal.
The pure guard tests additionally reject STOPPING/missing tasks, nonempty target
groups, scaler/scheduled drift, config/image drift and foreign recovery TDs.
These are local tests; no live AWS deployment was performed by them.
