# First-party workload environment preflight

This is stage one of the authority rollout. It adds a nullable `environment`
column to `application_workload_identities`, plus a CHECK allowing development,
staging and production. It changes no issuer, middleware, scope, SDK default,
application grant or UI behavior. The existing API continues serving while the
additive migration runs.

The generated migration is `0215_workload_environment_preflight`, following the
upstream `0214` snapshot, and is marked `oxy:deploy-phase=pre`. It contains only
registry DDL; it does not mix an UPDATE into the hot-table lock. Existing rows
remain NULL until the separately invoked provisioning script runs. Existing
writers may still insert NULL at this stage.

## Ordered rollout

1. Merge/deploy this preparation stage. Verify the migration ledger, intended
   image digest and completed ECS rollout. Do not deploy the new issuer yet.
2. Run the inventory dry-run on that image:

   ```sh
   bun run packages/api/scripts/provision-workload-environments.ts --environment production
   ```

3. Review the exact 27 rows recorded in
   `packages/api/src/config/legacyWorkloadTransition.ts`. The inventory names
   binding ID, application ID, provider and canonical subject; its header records
   the observation task and evidence hash. Review `outsideCohort` as well: it
   reports newer/current rows using only those fields and environment. No
   credential values, scopes, account owners or secrets are printed.
4. Apply the reviewed cohort:

   ```sh
   bun run packages/api/scripts/provision-workload-environments.ts --environment production --apply
   ```

5. Run the dry-run again. All reviewed rows must be `unchanged` with
   `cohortEnvironmentReady: true`. Preserve both reports with the rollout receipt.
   This is a cohort backfill receipt, **not fleet readiness**: the script always
   reports `fleetReadiness: not_assessed`. Any `outsideCohort` rows require separate
   review and environment provisioning before their new callers ship.
6. Only after this receipt, merge/deploy the issuer/readers and publish the
   transitional SDK. Rebase and regenerate any pending combined migrations on
   top of this stage; never deploy a combined first-party migration first.
   Migrate the receiver/consumer groups before retiring the finite v1 bridge.

## Drift and failure behavior

The script locks and validates all 27 exact identities and their active trusted
applications before writing. Missing, replaced, expired or differently bound
rows abort the whole transaction. Only NULL environments change to production;
already-production rows are left untouched. A staging/development value is never
overwritten. Writes compare ID, application, provider, subject and NULL environment.
No new row is added to the write cohort based on a role name or application brand.

New identities do not block this additive DDL or get silently backfilled by the
script. They appear in the report for review. Repeat runs are idempotent and
concurrent runs serialize on the same cohort. No scopes, owners, credentials or
other authority fields are changed.

If the script fails, stop the subsequent issuer rollout and inspect the reported
identity drift. Keep the additive column and old API live; no destructive rollback
is required. Do not mass-default unknown workloads to production or widen the
reviewed inventory without examining their provenance.


## Recorded production completion — 2026-10-23

The [migration ledger](../architecture/first-party-integration-migration.md#verified-deployment-checkpoint-oxy-environment-preflight-2026-10-23)
records PR #1937, the deployed image and the verified immutable `0215` ledger
hash. The exact-cohort dry run found 27 unbound environments; compare-and-set
provisioned 27; a separate read found 27 unchanged and zero outside-cohort
workloads. The diagnostic task definition was deregistered. The operator
receipt is
`/home/nate/Oxy/.scratch/first-party-root/oxy-environment-preflight-20261023.json`.

The reader-first release may proceed after its own source and release checks.
This receipt covers environment provisioning only; repeat inventory review
before the finite legacy bridge is removed and do not infer fleet readiness.
