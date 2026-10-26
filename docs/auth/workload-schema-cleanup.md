# Historical workload scope column — compatible removal

ADR 0049 and the verified protocol-v1 retirement removed scope-based workload
authority. Release 2 removes the inert `application_workload_identities.scopes`
column and its check. Until that separate post migration is deployed, the
column remains historical storage.
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

The bridge release keeps the database, ORM field, constraint and migration snapshots
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

The separately reviewed `0220_drop_workload_scope_column.sql` removes only the
workload binding column/check. Its ORM, snapshot and journal were generated
through `bun run db:generate`; its phase is `post`. Ordinary ORM insertion is
restored because its schema no longer names the removed column. Enqueue this
release only after the exact Release 1 deployment is verified.
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
  check. Confirm the API health gate and worker replacement start still precede
  post migrations, and record the reviewed migration hash. Worker steady-state
  verification happens after post tasks: any retiring old worker must therefore
  also be the compatible bridge, not an earlier image.

The production post migration needs a short lock timeout and a bounded statement
timeout. A lock failure aborts instead of waiting indefinitely; normal deployment
failure handling may return to the compatible bridge. A later unrelated post-task
failure may do the same after the DROP committed. Neither case restores scopes
or changes authority. The final readback verifies column/check absence, unchanged
binding/attribution identities and working scope-free mint/live resolution.

No production column drop is authorized by this document or by Release 1. Its
separate migration review and exact deployment evidence are the activation gate.

## Bounded production pre/post evidence

The coordinator uses `scripts/auth/read-workload-schema-cleanup.mjs` from the
reviewed source in a DB-only one-shot task. Importing it performs no connection;
call `readWorkloadSchemaCleanup(process.env.DATABASE_URL)` from `packages/api`
and serialize the returned receipt. Do not start the application, supply
workload credentials, or invoke any binding writer for this check. Keep the
same database, reviewed operator source and UTC settings for both snapshots.

The operator uses a repeatable-read, read-only transaction, 15-second statement
and 3-second lock limits, a 30-second idle limit and 1,000-row bounds. It returns
counts and SHA-256 digests of explicitly selected binding/attribution metadata,
relations, triggers, views, routine references and the external scope columns
and checks. It never returns scope values, credentials, routine bodies or row
contents. `pg_depend` reports unexpected registered column dependencies; routine
source and attached trigger functions are separately scanned for textual scope
references. Computed dynamic SQL identifiers cannot be ruled out by this scan:
the source/operator inventory remains a separate required review. Investigate
nonzero routine, trigger or view counts even when they do not name `scopes`.

Keep the pre-receipt before deployment and the post-receipt after successful
DDL. `compareWorkloadSchemaCleanup(before, after)` requires column/check removal,
no unexpected registered or textual scope dependency, and identical counts and
digests for every preserved category. Concurrent legitimate binding changes can
make comparison refuse; reconcile those changes rather than accepting a changed
hash. Neither the reader nor comparator changes data or executes the DROP.

The disposable PostgreSQL regression executes the actual generated migration,
proves before/after digest equality and external scope preservation, and rejects
an unexpected view, a `NEW.scopes` trigger and changed preservation digests.
Fresh-install migrations and the bridge's present/absent-column regressions are
separate gates. Production execution and its receipts remain pending until the
coordinator records the exact bridge deployment and approves the second release.
