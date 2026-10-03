# Root-operated consumer promotion

This external helper is not part of the Oxy image. No live preparation,
registration, migration, update, smoke or scaler restoration has been performed
by its author. Root reviews final source/images, actual authority and each
consumer's restore gate before preparing its exact hashed plan. It is not an
API, autonomous deployment controller or substitute for those reviews.

The input recipe file is `execution/lots.json` from the accepted consumer rollout
preflight. It has 17 repositories and 21 image build recipes, but **only 20
service promotions** are permitted here. `tnp-dns` remains independent and is
build/publication-only. `move`, `relay` and `relay-publisher` stay paused until
their separate root restore gates are met; this helper neither substitutes an
image nor silently restores them. Atlas has no ECS recipe.

`consumer-promotion.py` reuses the exact `fleet-quiescence.py` source. Both file
hashes are included in each plan. Fleet capture/readback logic and AWS transport
remain separate from the final product source/freeze. An actual root readonly
fleet capture has confirmed the 33-service/25-affected protocol; this is not a
receipt of completed quiescence. A fresh completed quiescence operation is still
required before promotion.

## Input configuration and trust boundary

Root supplies a JSON with exactly these keys:

- `service`: one of the 20 affected recipe names.
- `lots`: `{path, sha256}` of the accepted recipe JSON.
- `fleetPlan`, `quiescenceReceipt`, `quiescenceReadback`: byte-bound references to
  the actual completed fleet operation. Plan, receipt and readback canonical
  hashes must agree, and the selected service must have been stopped.
- `container`: the exact container name from its live descriptor, not an alias
  inferred from the service. Clarity API/worker can share a digest while keeping
  distinct commands; Homiio's separate targets and SearXNG sidecar are retained.
- `imageVerification`: byte-bound external root verification JSON described below.
- `migration`: an explicit `mode` (`required`, `not-required` or `bootstrap-managed`) and a
  byte-bound `verification` record, described below.
- `smoke`: an exact script path, file `sha256`, interpreter (`python3`, `node`
  or `bash`), public-handle `arguments`, and `timeoutSeconds` (1–300).

Every reference is `{ "path": "/private/...json", "sha256": "64 hex" }`.
Private inputs/output must be outside this helper checkout. No bearer, provider
key or secret value may appear in arguments/config/receipts. The reviewed smoke
script obtains any legitimate authority only by its existing approved mechanism
and holds material in memory. It receives a minimal local environment, not an
implicit service identity. A zero exit is meaningful only for the actual script
root has reviewed; the helper does not infer business parity from a noop check.

The image verification record has exactly `kind` (value
`root-consumer-image-verification-v1`), `service`, `repository`, `sourceSha`,
`sourceTreeSha`, `imageUri`, `manifestSha256`, `configSha256`, `platform`
(`linux/arm64`), `dockerfileSha256`, `target`, and `evidence` (1–20 byte-bound JSON
references). These external records must contain root's authenticated
build/config/label/source/security inspection. The helper checks their bytes,
recipe identity, a fresh authenticated GitHub commit/tree and Dockerfile, and a
fresh ECR single-platform manifest/config digest. **It does not recreate the
image inspection/security gate or treat an `approved:true` field as authority.**
Root's exact plan review is the trust boundary for the external inspection;
GitHub login identity alone does not establish a human decision.

A migration record has exactly `kind` (value
`root-consumer-migration-verification-v1`), `service`, `sourceSha`, `imageUri`,
`mode` and `evidence` (1–20 byte-bound JSON references). `required` means root has
executed and verified the recipe's actual migration under the exact image, while
paused, before promotion; `not-required` contains the reviewed recipe/source
reason. Omission or a mismatched image/source is denied. This helper **does not
run a migration or derive "no migration" from an empty command field**. It is
root's responsibility to establish and review that external prerequisite before
business tasks can start.

`bootstrap-managed` is allowed only for `tnp-api` and `website-api`. Their
canonical startup performs migration before the corresponding readiness gate
can succeed. The external record binds that exact startup/migrator source and
the reviewed smoke must assert **post-bootstrap** readiness; liveness alone is
insufficient. This mode does not claim that migration ran during preparation or
that no migration is required. The actual completed bootstrap/readiness receipt
is produced after promotion and before scaler restoration. A failed bootstrap
therefore holds the service at zero and never restores its scaler.

## Operations

Default preparation performs only reads and writes a new private plan. It checks
fresh selected-service count0, suspended scaler, drained targets and both task
censuses, then renders one image change in memory. The completed root quiescence
receipt already proved the original task ARNs stopped; immutable ECS task ARNs
cannot restart. Historical tombstones are therefore not re-described forever;
all tasks in the **fresh** RUNNING/STOPPED censuses must still be actual STOPPED.
This does not treat a missing task as stopped before the initial fleet receipt.

```bash
python3 -B scripts/operations/consumer-promotion.py \
  --config /private/reviewed-consumer.json --plan /private/consumer-plan.json
```

After root checks the fresh plan and its output byte hash:

```bash
python3 -B scripts/operations/consumer-promotion.py \
  --promote --plan /private/consumer-plan.json \
  --plan-file-sha256 <reviewed-byte-sha256> --output /private/consumer-attempt
```

Each operation requires the exact reviewed plan **file byte** SHA-256; a
missing or different hash fails before any operation. This is distinct from
the canonical object hash retained in receipts. Write plans expire after 30 minutes. The helper revalidates input/source/image and
migration evidence immediately before the update. Registration receives JSON
through stdin; it does not put environment values in argv or persistent intent
files. AWS readonly fields and reserved `aws:` tags are omitted; empty tags are
omitted. Existing writable tags, roles, commands, sidecars and all other writable
TD fields remain unchanged. Environment and secret arrays are normalized by
name, duplicates denied, and complete values compared on registered readback.
Positive registration ACK is retained before that independent readback.

A single service update installs the new TD and the **captured count together**.
The deployment configuration preserves all fields/defaults and changes only the
circuit breaker to enabled with `rollback:false`. Scalers stay suspended. The
helper waits for the exact new primary deployment, actual task census/digests and
healthy targets, runs the pinned smoke once, and rechecks rollout. Raw smoke
output is withheld; only exit/hash/size is retained. New/observed task IDs are
recorded, including old-definition tasks unexpectedly still active.

An ordinary rollout/smoke failure attempts a bounded hold at count0 without
changing the TD to an old image. The hold requires exact current baseline/new TD
and configuration, drains targets, examines both censuses and explicitly
confirms every remembered attempted task STOPPED. FAILED/multiple zero-count
deployments do not prevent a safe hold. Configuration drift, missing readback,
interruption or unknown ACK prevents a success claim. There is no automatic
retry, scaler restoration or fallback business bootstrap. SIGKILL cannot run a
finally block; durable intents/ACKs/registration/task records require root's
external reconciliation.

After a lost update ACK, root first reconciles the exact intent and AWS state.
An independent hold is then available using the positive registered readback
record. It revalidates the actual TD/config; stopping does not depend on GitHub
being available at that moment:

```bash
python3 -B scripts/operations/consumer-promotion.py \
  --hold --plan /private/consumer-plan.json \
  --plan-file-sha256 <reviewed-byte-sha256> \
  --registered-receipt /private/consumer-attempt/registered.json \
  --output /private/consumer-hold
```

Unknown **registration** ACK is different: no verified registered record exists,
so root must locate/reconcile the exact family/config/creator/registration-time
operation before retrying or supplying any later plan. A TD can exist without
having started a task. Deregistration alone would not prove absence of tasks.

Only after `promoted.json` records this plan's successful smoke may root restore
that service's original scaler:

```bash
python3 -B scripts/operations/consumer-promotion.py \
  --restore-scalers --plan /private/consumer-plan.json \
  --plan-file-sha256 <reviewed-byte-sha256> \
  --promotion-receipt /private/consumer-attempt/promoted.json \
  --output /private/consumer-scaler-restore
```

A fresh rollout check precedes restoration. Min/max/role and all original
suspension flags must be restored exactly; an unknown ACK blocks retry. A
service with no original scaler does not gain one. No other service is restored
by this command. Failed attempt resumption requires a separately reviewed
operation, not replaying registration/update blindly.

## Offline evidence

```bash
python3 -B scripts/operations/tests/test-consumer-promotion.py
python3 -B scripts/operations/consumer-promotion.py --help
```

The tests use synthetic external receipts/GitHub/ECR/AWS records, real local
file intents, a real stdin-only AWS **stub executable**, and a real failing smoke
child. They prove the bounded protocol and fail-closed behavior; they do not
prove actual IAM, migrations, image publication, consumer behavior, live AWS
rollout or smoke success. No product files/image/final policy changes are part
of this external helper delivery.

The concrete source-derived migration/smoke map is in [service-gates.md](service-gates.md). Worker startup, customer authorization and business acceptance have separate meanings there.
