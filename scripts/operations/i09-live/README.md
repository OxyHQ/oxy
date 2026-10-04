# I09 exact live admission and feed reconciliation

Prepared against Oxy TD693/image `b8d0d2f…` and Alia TD449/image `18d5c54…`.
Only root operates production. This source does not change either deployed image.
No inference has been executed by this preparation. It reuses the approved I09
caller and canonical API catalogue/feed services; it creates no key, grant,
price, catalogue row, or customer balance.

The private preparation is
`/home/nate/Oxy/.agent-evidence/i04-i09-runtime-693-alia449-20261004/operation-v3`.
Its plan SHA256 is `fe6670dc3557ec1258206a28ab65ea4dff3d3e18e8f209a704ff6a16f1574a17`.
The preliminary v1 directory records a local packaging assertion failure; it is
not executable. V2 is superseded by v3, whose source includes exact usage checks.

## Review and execute order

1. Revalidate service/task-definition/digest/config against the plan: sole
   COMPLETED deployment, Oxy693 healthy and Alia449 healthy, existing private
   network, and exact task/execution roles. The baseline and post tasks have no
   task role and only existing `DATABASE_URL` and
   `KAANA_EDGE_SIGNING_PRIVATE_KEY` references. No credential-control signing
   key is copied. The caller has the existing Alia task role and no SSM secrets.
2. Root reserves a fresh private directory and durable intent before each
   registration/RunTask, pins definition JSON SHA, and records the registered
   ARN plus normalized readback before RunTask. Use private file JSON input,
   never `/dev/stdin`. One task only. An uncertain ACK requires reconciliation
   by exact startedBy/TD/intent before any new attempt. No automatic redispatch.
3. Execute `baseline-definition.json` first. It verifies four installed module
   hashes, reads exact-key absence and owner-money digests in repeatable-read /
   read-only SQL, and calls the canonical signed Kaana **exact three-ID** query.
   It does not invoke inference. Three current identities must attest. Missing
   acceptedParameters stays unknown; this does not manufacture eligibility.
4. Retain the original task logs and run the decoder below. Check result kind,
   intent, packet digest, task exit0/image, and cleanup. Baseline money/key
   observations must be fresh immediately before the caller. Stop on drift.
5. After root accepts the complete definitions and replay source, execute
   `caller-definition.json` once. It stages unchanged Alia factory source from
   main3904331 compiled to ESM at an exclusive hash-named file, imports the real
   published OxyServer, and uses workload attestation. The existing bundled
   index.js is hash-checked but never imported. JWT signature/owner/app/exact
   workload credential/production/300s/inference scope are checked in memory.
   Only then send one 16-output-token request; after HTTP200, repeat the
   identical body/key once for canonical HTTP409. No token/generated text is
   logged. Timeout or refusal never allocates another key. The caller result
   may require inspecting its exact original SQL intent; it is not success.
6. Extract only the `OXY_INTERNAL_PILOT_CANARY` JSON result from that exact
   original task, with unique-line/intent validation, into private `canary.json`.
   Generate the post definition using the command below. Before running it,
   observe that the normal 60s feed has ingested the exact request. A missing
   attempt set is pending reconciliation, never permission for new inference.
7. The post task checks the exact settled internal operation, caller, model,
   admitted/final attribution, returned usage, same-key conflict, and unchanged
   owner-money digests. It reads the authenticated feed from the baseline
   cursor (20 pages ×500 maximum), selects only this request's events, and
   compares every canonical facts digest against already-ingested SQL rows.
   Only that exact existing event set is replayed through the canonical writer.
   Require inserted0, mismatches0, duplicates=eventCount, unchanged exact rows
   and money. Cursor advancement from other work is reported separately.
8. Root stops/readbacks any still-running **owned** task, then independently
   deregisters/readbacks each owned definition. Preserve STOPPED exit code,
   image digest, INACTIVE definitions and cleanup failures. A lost result does
   not mean the request was absent. Never remove ledger/feed history.

Root's existing one-shot ECS lifecycle protocol handles registration, exact
readback, task execution and cleanup; these definitions are inputs, not a new
service deploy workflow. Do not launch any phase from a workstation pretending
it has the Alia role. No local production DATABASE_URL is required.

## Local preparation / original-log reconciliation

```sh
python3 scripts/operations/i09-live/prepare-observation.py --output /new/private/operation
python3 scripts/operations/i09-live/decode-i09-result.py \
  --events /private/original-baseline-events.json \
  --intent oxy1519-i09-1791093169991-608bdb4f0ed0e8b0 \
  --kind i09-baseline-attestation-v1 --output /private/baseline.json
python3 scripts/operations/i09-live/prepare-observation.py \
  --operation /private/operation --baseline /private/baseline.json \
  --canary /private/canary.json --output /new/private/post
python3 scripts/operations/i09-live/decode-i09-result.py \
  --events /private/original-post-events.json \
  --intent oxy1519-i09-1791093169991-608bdb4f0ed0e8b0 \
  --kind i09-final-exact-reconciliation-v1 --output /private/reconciled.json
```

`OXY_I09_PREPARED_INPUTS` optionally selects a private directory of the reviewed
readiness/caller definition inputs. The generator makes no AWS call. Its default
points to the exact retained preparation above. All files are exclusive0600.
Root must bind the full generated definition before registration.

## Evidence and limits

Local controls cover SQL read-only isolation, exact owner rejection, digest
sensitivity, signed JWT audience/owner/workload/scope/TTL, bound HTTP intent,
exclusive staging and cleanup, attestation identities, feed bounds, and refusal
to replay mismatched/unseen events. They do not claim a real provider result.
The original observation fixture compared postgres Result to Array and failed
only on prototype equality; that log remains separate from four passing SQL
controls. Original staging-test cleanup order failure is also retained.

Unknown upstream cost remains NULL. One operation can involve several real
provider attempts; retain all of them. This does not certify all concurrency,
daily limits, prices, delegated users or every provider. Changes in unrelated
owner money require reconciliation, not automatic attribution to the canary.
