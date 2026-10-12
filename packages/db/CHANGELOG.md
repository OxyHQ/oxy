# Changelog: `@oxy.so/db`

## Unreleased

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
