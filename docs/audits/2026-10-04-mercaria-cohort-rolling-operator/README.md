# Closed Mercaria cohort rolling promotion

This external ROOT-operated helper is not an Oxy product/image change. It reuses
the reviewed consumer image/TD verifier at `afda79f31` (helper SHA6498df24).
Preparation performs only metadata/source/ECR reads. No live plan or mutation
was produced by the author. The approved two-store JSON and serving attestation
hash are fixed to Mercaria PR1047, merged main `80291a89328f999aa1c3ed4241ba0f6f84b0c687`.

Baseline is serving `oxy-mercaria:60`, digest635ddbf7, steady desired/running
within original 1..4, no pending tasks, one COMPLETED deployment. It must have
minimumHealthyPercent100, maximumPercent200 and disabled automatic rollback.
The update preserves all service configuration/count/scalers and all TD fields,
sidecars, environment, existing secret references and custom tags. Only the
selected `mercaria` image, exact `MERCHANT_BILLING_PEABLE_COHORT` and two Peable
credential aliases are added. Aliases use the existing OXY_APPLICATION_KEY and
OXY_APPLICATION_SECRET SSM references. General Stripe and new billing actions
must stay false, including when absent/default false. No other namespace,
merchant, store, price, key, grant, IAM or database change is permitted.

ROOT creates an external config containing exactly three `{path,sha256}` refs:

- `imageVerification`: complete `root-consumer-image-verification-v1` for the
  actual new Mercaria ARM image, authenticated source/tree/Dockerfile/ECR bytes
  and independent inspection/security evidence. Placeholder images are refused.
- `migrationVerification`: canonical `root-consumer-migration-verification-v1`,
  service mercaria, actual source/image, mode not-required and hash-bound evidence
  proving unchanged 158-entry SQL/journal and accepted live reconciliation
  (135 historical comment-only hash differences, 23 unchanged, zero pending).
- `acceptedPrerequisites`: ROOT receipt `root-mercaria-cohort-prerequisites-v1`
  with exactly `kind`, `cohort` (fixed six-field configuration in this helper),
  `merchantPortalAccepted`, `storesAccepted`, `peableCohortAccepted`,
  `canonical135Unchanged`, `shippingSdkVerified` (all true) and `evidence` refs.
  The legacy `canonical135Unchanged` field names the accepted 135 historical
  comment-only reconciliations; the complete unchanged journal has 158 entries.
  ROOT independently verifies these meanings; the helper authenticates every
  referenced file's bytes and the exact namespace, without synthesizing evidence.

The plan records actor ARN, source hashes, full fresh TD/service/task snapshots,
source/image identity and the exact registration body. Fifteen-minute expiry,
actor/source/evidence/TD/service/deployment checks repeat before mutation. Writes
have private O_EXCL/fsync intents and one attempt each. AWS registration uses a
private JSON file (not a large command argument); readback validates writable
fields with environment/secret ordering normalized and reserved tags excluded.
Then update-service changes only taskDefinition. No desired-count write.

```bash
python3 -B scripts/operations/mercaria-cohort-promotion.py prepare \
  --config /ABS/ROOT/reviewed-config.json --output /ABS/ROOT/fresh-plan.json
sha256sum /ABS/ROOT/fresh-plan.json
# ROOT reviews the fresh concrete plan; only ROOT runs this mutation:
python3 -B scripts/operations/mercaria-cohort-promotion.py execute \
  --plan /ABS/ROOT/fresh-plan.json --sha256 ACTUAL_PLAN_FILE_SHA256 \
  --output /ABS/ROOT/execution --execute
```

Acceptance requires all serving tasks RUNNING on the actual new TD/digest,
steady desired/running counts, exact healthy ALB targets and every new task's
own fresh log stream containing:

- msg `Merchant billing cohort registered`
- cohortSha256 `a7ed9819eb8aa2e8360a430c907092e0af2059a8f9539bafc8eb780771046ed3`
- mode live, environment production, storeCount2

Any `Merchant billing registration failed` or mismatched positive line rejects
acceptance. Initial/unhealthy targets and missing positive logs can wait within
the same bounded monitor; only known previous task targets may drain, and they
must disappear before acceptance. Public /health and /health/ready must return200 with
no redirects/cookies. No HTTP200 alone is registration proof. Startup readiness
cannot prove asynchronous provider installation.

Availability: confirmed failure STOPS the helper and leaves desired count and
scalers unchanged. It records exact baseline60/image/config/count and intended
new TD for ROOT's fresh reconciliation and explicit TD-only rollback if needed.
There is no automatic hold0, scaler operation or automatic old-image rollback.
Unknown registration/update ACK is not retried and needs reconciliation by
saved intent before any next mutation. The disabled circuit-breaker rollback
setting is preserved, not interpreted as permission to cause an outage.

Tests exercise exact config deltas, historical store IDs, source/namespace
failure, AWS environment order/tags/attachments, all-task positive evidence,
initial/unhealthy/draining/foreign targets, file transport and fsynced intents,
unknown ACK and confirmed failure without count/rollback writes. AWS/HTTP are
mocked in these operational tests; separate Mercaria SQL/SDK fixtures and CI
remain the product proof. The initial test fake wrongly put tags inside the TD
object; that local setup failure is preserved and excluded from PASS.

The initial actual TD61 rollout emitted the exact cohort attestation and reached
steady1/1 COMPLETED, then the external helper failed on the nonexistent /ready
URL. ROOT reconciles the same deployment using canonical /health/ready; no
registration/update replay is needed. A real loopback HTTP routing fixture
reproduces that 404 with the old helper and passes with the corrected path.
The fixture models canonical route topology; it does not boot the product server.
