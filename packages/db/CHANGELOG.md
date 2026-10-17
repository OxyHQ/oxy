# Changelog: `@oxy.so/db`

## 1.3.0

### The migration lock gate ships with the package: `oxy-db-check-migration-locks`

1.2.0 bounds a lock to one migration; the gate that keeps that one migration
short lived only in oxy's `scripts/`. It is now in the package, so every app
runs the same rules oxy-api does:

- **`oxy-db-check-migration-locks`** (bin): `--migrations=<drizzle folder>`
  (default `drizzle`), `--after=<n>` (required: migrations numbered at or below
  it are already applied and not checked), `--hot-tables=a,b` (the tables read
  on nearly every request). Exits 1 listing every problem. Rules: a foreign key
  onto an existing table is `NOT VALID` (validated later); a migration that
  takes ACCESS EXCLUSIVE on a hot table does no backfill or index build in the
  same file; an index on a hot table is `IF NOT EXISTS`; statement-timeout
  markers are legible. Waiver: `-- oxy:lock-review=<reason>` in the file.
- New exports from `@oxy.so/db/migrate`: `checkMigrationLocks`,
  `migrationLockProblems`, `LOCK_REVIEW_WAIVER`. Node builtins only, so a gate
  can import the source before `bun install`.

## 1.2.0

### `runMigrations` commits each migration on its own, under `lock_timeout`

On 2026-10-16 oxy-api applied seven migrations in ONE transaction (drizzle's
`migrate()` wraps every pending migration in a single `BEGIN … COMMIT`). The
first took an ACCESS EXCLUSIVE lock on `applications` and held it for the 93
seconds the others spent backfilling `files`; every per-request read of
`applications` queued behind it (16 AAS on the shared RDS, 503s in every
product that calls Oxy fail-closed).

- **One transaction per migration.** The runner hands drizzle a folder ending
  at the next pending migration, one at a time, so a migration's locks are
  released when it commits. Ledger rows are byte-for-byte what a whole-folder
  run writes. A failure leaves the earlier migrations of the run applied (they
  were committed) — every migration must already stand on its own.
- **`lock_timeout`** (default 3 s, `lockTimeoutMs`) on every statement, so a
  migration that cannot get its lock gives up instead of queueing every reader
  of the table behind its wait.
- **Retry with backoff.** A lock timeout (`55P03`) or deadlock (`40P01`) rolls
  the migration back and retries it from the top: up to 8 attempts, full jitter
  over 1 s doubling to a 30 s ceiling (`lockRetry`). Out of attempts, the run
  fails naming the migration.
- **`statement_timeout`** (default 120 s, `statementTimeoutMs`). A migration
  that needs longer declares it in its own file:
  `-- oxy:statement-timeout=600s` (whole seconds, at most 3600). An illegible
  marker is refused before any connection is opened.
- New exports from `@oxy.so/db/migrate`: `readMigrationStatementTimeouts`,
  `isLockContention`, `lockRetryDelayMs`, the defaults.
- `openOwnedConnection` takes optional server runtime parameters.

## 1.1.1

### Fix: `driver: 'bun-sql'` stored every drizzle `jsonb()` write as a jsonb string

**Data-corrupting on 1.1.0 for any caller that left `prepare` at `Bun.SQL`'s
default (`true`) or passed `prepare: true`.** drizzle's `jsonb()` (and
`json()`) column `JSON.stringify`s the value before binding it; on a PREPARED
statement `Bun.SQL` 1.4.3 learns from the server that the parameter is `jsonb`
and JSON-encodes that string again. `{"a":1}` was stored as the jsonb string
`"{\"a\":1}"`: `jsonb_typeof` returns `'string'`, and `->`, `@>` and any index
on the column see a string. drizzle's reader `JSON.parse`s the string back, so
every read through drizzle looked right and a drizzle-only round-trip test
passes. postgres.js was never affected.

- Every `Bun.SQL` client this package opens (`createDatabase`, the migrator,
  `ensureExtensions`, the test harness) is now opened with `prepare: false`,
  whatever the caller passed. Unprepared, `Bun.SQL` sends the text untyped and
  the server parses it as JSON, exactly as on postgres.js. The cost is a
  re-plan per statement, the same as behind a transaction-pooling proxy.
- `BunSqlClientOptions.prepare` is narrowed from `boolean` to `false`, and
  `prepare: true` throws before any connection is opened (for an untyped or
  cast caller). **A caller passing `prepare: true` no longer typechecks**:
  delete the option or pass `false`. This narrowing is deliberate in a patch
  release; the combination it removes corrupts data. A `?prepare=` in the
  connection string cannot turn it back on (`Bun.SQL` forwards it to the
  server as a runtime parameter, which the server refuses at connect).
- Raw queries on the returned `Bun.SQL` `client` are unprepared too: bind
  `JSON.stringify(value)` (with `::jsonb`) for a jsonb parameter. An object
  bound directly is sent as `[object Object]` and refused loudly by the server.
- New live suite `jsonb.live.test.ts` asks the SERVER (`jsonb_typeof`, `->`,
  `->>`, `@>`) what each driver stored for an object, an array, a string, a
  string that is JSON text, a number and NULL, on insert and on update, and
  pins the reason: raw prepared `Bun.SQL` still double-encodes.

**Repairing rows a 1.1.0 bun-sql handle wrote.** Only rows written through a
prepared `bun-sql` handle are affected; a genuine jsonb string value cannot be
told apart from a double-encoded one by type alone, so check the column's
expected shape first. For a column that never legitimately holds a top-level
string, this is idempotent:
`UPDATE t SET col = (col #>> '{}')::jsonb WHERE jsonb_typeof(col) = 'string';`

## 1.1.0

### Opt-in Bun SQL driver (`driver: 'bun-sql'`)

Bun-run applications can drive this package through Bun's built-in client
(`Bun.SQL`, via `drizzle-orm/bun-sql`) instead of postgres.js. postgres.js stays
the default and its path is unchanged; nothing switches on `typeof Bun` by
itself, and the package still loads under Node (`import('@oxy.so/db')`), which
never loads a Bun module.

- `createDatabase({ databaseUrl, schema, driver: 'bun-sql', client })` returns
  `{ db: OxyBunSqlDatabase<TSchema>, client: BunSqlClient }`, synchronously, like
  the default. `client` takes `BunSqlClientOptions` (Bun's names: `max`,
  `idleTimeout`, `maxLifetime`, `connectionTimeout`, `tls`, `prepare`,
  `connection`; each names its postgres.js equivalent). Shut it down with
  `client.close({ timeout })`. No postgres.js type appears on this overload.
- `runMigrations({ ..., driver: 'bun-sql' })` runs the same steps in the same
  order — target-database guard first, then the ledger checks, phase planning,
  extensions, apply and the post-apply re-read — through `Bun.SQL` and
  `drizzle-orm/bun-sql/migrator`, which writes the same ledger table and rows.
  A database half-migrated by one driver is finished correctly by the other.
  `Bun.SQL` has no NOTICE hook, so `logger.debug` gets no server notices there.
- `ensureExtensions(url, extensions, { driver })`,
  `createTestDatabase({ ..., driver })` and `dropTestDatabase(url, { driver })`.
- **Widened, not changed:** `readAppliedMillis`, `readLastAppliedMillis`,
  `assertPostgresMigrationsCurrent`, `readAppliedRows`, `verifyMigrationLedger`
  and `assertMigrationTarget` now take a `RawSqlClient` (anything with
  `unsafe(query)`), which a postgres.js `Sql` and a `Bun.SQL` both satisfy.
  Existing calls typecheck unchanged.
- **Fix that bun-sql needed:** `sqlStateOf`, `constraintNameOf` and the
  `is*Violation` predicates read `Bun.SQL`'s error shape (SQLSTATE in `errno`,
  constraint in `constraint`, `code` always `ERR_POSTGRES_SERVER_ERROR`).
  Without it every bun-sql constraint failure read as "not a violation".
- Running under Node with `driver: 'bun-sql'` throws a clear error naming the
  option. New exports: `DatabaseDriver`, `DATABASE_DRIVERS`,
  `DEFAULT_DATABASE_DRIVER`, `RawSqlClient`, `BunSqlClient`,
  `BunSqlClientOptions`, `OxyBunSqlDatabase`, `CreateBunSqlDatabaseOptions`,
  `EnsureExtensionsOptions` (from `/migrate`), `DropTestDatabaseOptions` (from
  `/testing`).

### Also in this release (merged after 1.0.0)

- `runMigrations` takes an optional `requiredAppliedTags`: named journal entries
  that must already be in the ledger with their exact SQL hashes before
  planning. `assertAppliedMigrations` (from `/migrate`) is the check on its own.
- `findSchemaInvariantViolations` no longer reports `mongoose_artifact` (an
  `_id` or `__v` column). `check` stays typed `string`, so no consumer's types
  change, but a schema gate that relied on that check no longer fails on those
  columns.

## 0.2.0

### Licence: this package moves to the Breathe License 1.0

**Breaking, and a genuine narrowing rather than paperwork.** `@oxy.so/db` is now
licensed under the Breathe License 1.0, identifier `LicenseRef-Breathe-1.0`. The
code, the API surface and the behaviour are unchanged in this release; it exists
to carry the licence change.

What changes for you:

- **Non commercial use stays free**, perpetually and irrevocably while you comply.
- **Commercial use now requires a paid licence.** The trigger is revenue, and it
  includes purely internal use inside a business that earns revenue.
- **If you deploy it, you publish the corresponding source.** That binds everyone,
  including paying customers, and cannot be bought out of.
- **Attribution is required of everyone** and cannot be waived.
- **Cooperatives, nonprofits, educational institutions, public bodies and worker
  owned businesses pay no fee.**

This is **source available, not open source**. It fails clause 6 of the Open
Source Definition because commercial use is conditional on payment. Automated
licence scanners report it as unknown, and GitHub shows it as "Other".

**Nothing here is retroactive, and it could not be.** `@oxy.so/db@0.1.0` was published
under AGPL-3.0-only and stays AGPL-3.0-only forever for anyone who has it. They may keep
using it, commercially, at no charge, indefinitely, and may fork it. A licence
change binds future versions only.

`@oxy.so/db` is below 1.0.0, where semver puts the breaking position in the minor and
`^0.1.2` does not accept `0.2.0`. Bumping the minor is the same signal a major
gives a 1.x package: nobody picks this up without editing their manifest.

### Added

- A `LICENSE` carrying the full Breathe License text with its Parameters filled
  in, and a `NOTICE`.

### Still outstanding

- The Licensor's jurisdiction of incorporation, registration number and the
  governing law are **visible placeholders**. They are not guesses, and must be
  filled in before the commercial arm can invoice.
