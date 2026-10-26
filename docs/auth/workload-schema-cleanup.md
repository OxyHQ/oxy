# Historical workload scope column — compatible removal

ADR 0049 and the verified protocol-v1 retirement removed scope-based workload
authority. `application_workload_identities.scopes` remains historical storage.
The external `applications.scopes`, `application_credentials.scopes` and OAuth
grant columns remain active and are outside this migration.

## Why two releases

The deployed retirement source `dc1c21186` uses explicit workload projections in
the mint, live principal resolver and binding administration. However, its
ordinary Drizzle binding INSERT names every modeled column, including `scopes`
as DEFAULT even when `.values()` omits it. Dropping the column would break that
image's binding creation. The three operator inventories under `scripts/auth`,
`scripts/agency` and `scripts/inference` also explicitly selected it.

The normal deployment runs additive migrations, rolls the worker and API, then
runs post tasks. A later post task can fail after a successful DDL commit and
trigger automatic rollback. Declaring the new image a rollback floor in prose
would not make the previous image compatible with that already-applied DROP.

### Release 1: rollback-compatible binding writer and inventories

This change keeps the database, ORM field, constraint and migration snapshots
unchanged. Binding creation temporarily uses an explicit-column, parameterized
INSERT without `scopes`, within the same transaction as attribution creation.
It returns the id and reads the existing named projection with Drizzle's date
mappers. The shared unique-violation helper recognizes a concurrent identical
bind through Drizzle's wrapped driver error; only the exact provider/subject
constraint is treated as that race. Identity repointing remains refused.

The three current readback operators project the binding's `environment` instead
of historical scope data. Their application and external credential scope
projections remain unchanged. No binding, application or grant data is rewritten.

`workloadScopeColumnCompatibility.db.test.ts` removes the column in a disposable,
fully migrated PostgreSQL database and exercises the real binding service, live
resolver and all three Node operator modules. It covers concurrent provisioning,
attribution, typed timestamps, idempotence, environment drift, identity repointing
and expiry. It restores the test database's historical column and values before
other suites use that worker. This is compatibility evidence, not production DDL.

### Release 2: physical removal

Prepare a separate reviewed migration after Release 1 is deployed. Remove only
the workload binding's ORM field and its check, generate the matching Drizzle
SQL/snapshot/journal through `bun run db:generate`, and mark the DROP as `post`.
Restore ordinary ORM insertion once its schema no longer names the column.
Do not edit or renumber published historical migrations. Preserve the
compatibility regression: it also runs when the migrated schema has no column.

Before approving that release, the coordinator records:

- Exact Release 1 API and asset-worker source/digests at healthy steady state,
  with prior processes drained. The immediate rollback definitions must point
  to this compatible bridge, not retirement image 1080/545 or earlier.
- The actual deployed schema: column and check present, no unexpected view,
  function, trigger or other dependency on that column. The generated DROP must
  not use CASCADE or change any binding id, attribution FK or external scope.
- Current operator invocations use the new readback source and the bridge/current
  binding script. Archived pre-retirement issuers and unsupported old operator
  images are not rollback paths. Preserve historical evidence without running it.
- Fresh-install and upgrade tests pass with the generated migration; replay the
  bridge writer/readers against the post-DROP schema as the automatic-rollback
  check. Confirm the deployment still runs post migrations only after worker and
  API steady state, and record the reviewed migration hash.

The production post migration needs a short lock timeout and a bounded statement
timeout. A lock failure aborts instead of waiting indefinitely; normal deployment
failure handling may return to the compatible bridge. A later unrelated post-task
failure may do the same after the DROP committed. Neither case restores scopes
or changes authority. The final readback verifies column/check absence, unchanged
binding/attribution identities and working scope-free mint/live resolution.

No production column drop is authorized by this document or by Release 1. Its
separate migration review and exact deployment evidence are the activation gate.
