# PostgreSQL, Drizzle and the storage traps

Rules for every Oxy service on PostgreSQL through [`@oxy.so/db`](../packages/db) (Drizzle over
postgres.js). Shared mechanism lives in that package; each app keeps its own table conventions
(Mention: `packages/backend/src/db/schema/CONVENTIONS.md`). Porting a domain off MongoDB:
[mongo-to-postgres-ports.md](mongo-to-postgres-ports.md).

## Entity ids: two shapes, one predicate

A primary key built with `generatedId()` (`packages/db/src/columns.ts`) is `text` holding one of two
shapes, both live at once and permanently:

- a **24-character hex ObjectId** for every row ported from MongoDB (kept verbatim, because those ids
  are published: DIDs, signed records, ActivityPub ids, cached URLs), or
- a **uuid v7** (`uuidv7()`, generated in the application) for every row created since.

Rules:

- **`isLiveEntityId` is the only place that decides whether a string has an entity-id shape.** It is
  exported from the root of `@oxy.so/db` (`packages/db/src/ids.ts`, re-exported by
  `packages/db/src/index.ts`). Never re-implement the regex or a length/charset check in an app, and
  never write a guard for the 24-hex shape alone: it rejects every uuid v7 id, and where `false`
  means "not blocked" it becomes a fail-open bypass. No schema built on these helpers uses a `uuid`
  column type, so this predicate is where both shapes are spelled out.
- **It answers "is this not obviously malformed", never "does this row exist".** Use it only for a
  documented 400 at an API boundary (a route param, a cursor token you are about to turn into a
  keyset bound). Do not use it as a precondition on a lookup: a `text` id that matches no row is
  already "not found" for free, and a shape guard turns an id of a shape it was not taught into
  "it no longer exists".
- **Protocol keys are not entity ids and can still be row ids.** A bridged row may keep an AT-URI,
  an rkey or a remote ActivityPub URL as its `id`, which `isLiveEntityId` correctly rejects. Never
  build a cursor, keyset bound or any key that must be a live entity id from such a column. Page on
  a unique, always-live column instead: Mention's likes list pages on `(created_at, user_id)` for a
  post's likers and `(created_at, post_id)` for a user's likes, because `likes.id` is an AT-URI for
  bridged likes and encoding it threw (OxyHQ/Mention#1951). Mention's one chronological cursor,
  `packages/backend/src/utils/chronoCursor.ts`, calls `isLiveEntityId` on every id it encodes or
  decodes and refuses anything else.
- **Id order is not insertion order**, and the two shapes do not sort together (`'0' < '6'`, so under
  the database collation every uuid v7 sorts below every ObjectId hex). Keyset on `(created_at, id)`
  with the id only as the tiebreak, as in the cursor above.
- A discriminator that asks "is this value *our* kind of id" (for example whether something is an
  Oxy file id or a raw federated URL) is a different question owned by the system that issues the
  id; it must not widen just because another service mints uuid v7.

## PostgreSQL semantics

- **Extracting a sub-document array into a CHILD TABLE turns one atomic `$set` into DELETE-then-INSERT, and the gap between is a real state** — a crash mid-gap can leave an exclusion link briefly absent with no error. The replace needs a transaction handle + runtime `requireTransaction`; an untransacted caller's patch+replace are now one logical write.
- **A TRANSACTION gives atomicity, not SERIALIZATION — a Mongo document replacement gave both.** DELETE+INSERT under READ COMMITTED can let two concurrent "replace" writers each miss the other's inserts, leaving the UNION of both, invisible to tests run one at a time. Restore the serialization point with `SELECT … FOR UPDATE` on the parent row at transaction start.
- **Two ways a lock-wait probe reports the comfortable answer:** predicating on `relation` when the wait queues on the holder's `transactionid`; expecting the waiter's pid to differ from the pool's, which legitimately reuses connections. Scope `pg_locks` to the holder's pid.
- **`Promise.all` does NOT force statements to interleave, so the intuitive CAS race test is VACUOUS** — each transaction can finish before the loop returns to the other. Force interleaving: `SELECT … FOR UPDATE`, let the contender block on `UPDATE`, mutate underneath it, commit. **The wait must assert its own precondition** — poll `pg_locks` (not `pg_stat_activity`, blank across role splits) scoped to the holder's pid and THROW if the block never appears. A `Promise.all` test going red only proves the mutant yielded; green there is meaningless.
- **`array_length(col,1)` is NULL on an empty array and a CHECK rejects only FALSE**, so `>= 1` ADMITS `{}` — use `cardinality()`. Membership and cardinality are always two constraints.
- **One failed statement aborts the WHOLE transaction (`25P02`)** — Mongo's read-back-after-duplicate-key recovery doesn't port. Prefer `ON CONFLICT … DO NOTHING RETURNING *` so no statement fails; else a nested drizzle transaction. Test against a real server.
- **A drizzle error's SQLSTATE lives on `cause`, never `error.code`** — a ported `err.code === '23505'` matches nothing. Use `@oxy.so/db`'s `isUniqueViolation`/`constraintNameOf` against a REAL error.
- **Row-level security: the table OWNER bypasses it**, so plain `ENABLE` under a one-role model enforces NOTHING — use `FORCE ROW LEVEL SECURITY` plus a migrator/app role split; under `FORCE` the migrator's own writes silently return 0 rows without a permissive `FOR ALL TO <migrator_role> USING (true) WITH CHECK (true)` policy.
- **PostGIS is privileged** — `CREATE EXTENSION postgis` is refused even to the owner, and `IF NOT EXISTS` short-circuits before the check (silent no-op). Install once per database as `rds_superuser`, with the rehearsal database owned by the SAME role as production.
- **`@oxy.so/db`'s uuid v7 PK is NOT monotonic within a millisecond** (48 bits of `Date.now()` then random bits, measured ~50% inversion) — any ordering test must write EXPLICIT timestamps.
- **Migrations must keep their locks short — one shared RDS serves every app.** drizzle's `migrate()` runs ALL pending migrations in ONE transaction, so the first ACCESS EXCLUSIVE lock is held until the last commits (one incident held an ACCESS EXCLUSIVE lock on `applications` for 93 s and 503'd every app). `@oxy.so/db`'s migrator commits each migration on its own under `lock_timeout` 3 s + backoff retry and `statement_timeout` 120 s (raise per file: `-- oxy:statement-timeout=600s`). Authors: FKs onto existing tables `NOT VALID` then `VALIDATE CONSTRAINT` in a later migration; hot-table DDL alone in its migration (no backfill/index build beside it); indexes on existing large/hot tables built `CONCURRENTLY` out of band first, migration = `CREATE INDEX IF NOT EXISTS` (CONCURRENTLY cannot run inside drizzle's transaction). oxy enforces it with `scripts/check-migration-locks.mjs`; every app runs the same rules from `@oxy.so/db` as a CI step: `oxy-db-check-migration-locks --migrations=<drizzle dir> --after=<last migration before adoption> --hot-tables=<per-request tables>` (no `--hot-tables` = no table is hot; waiver `-- oxy:lock-review=<reason>`). oxy's own invariants: `packages/api/src/db/MIGRATION-CONTRACT.md`.
- **A connection that dies silently (no FIN/RST) hangs its next query ~15 min** (TCP retransmission; keepalive never probes while a write is unacknowledged, and postgres.js has no query timeout). `@oxy.so/db` builds every postgres.js client through `openPostgresClient` (`createDatabase`, the migrator, `testing`, oxy-api's pool and lock client): `statement_timeout` = `statementTimeoutMs` (default 300 s, sent at connect) + a client **query deadline** `queryDeadlineMs` (default `max(statementTimeoutMs, 300 s) + 30 s` = 330 s) that destroys a connection the server sent nothing on after a request (`QueryDeadlineError`, `code: 'QUERY_DEADLINE_EXCEEDED'`; the pool replaces it, never reuses it) + keepalive 30 s + `connect_timeout` 10 s. **Long one-shots/backfills/index builds raise `statementTimeoutMs`** (the deadline follows; `0` = no limit and no deadline) — oxy-api via `PG_STATEMENT_TIMEOUT_MS`/`PG_QUERY_DEADLINE_MS` on the task, Mention via `PG_SCRIPT_STATEMENT_TIMEOUT_MS`. A `SET LOCAL statement_timeout` above 300 s needs the pool's `statementTimeoutMs` raised too, and set it with `statementTimeoutMs`, never `client.connection.statement_timeout` (only the former moves the deadline). Migrator unchanged: 120 s + per-file markers, deadline from the longest marker. `bun-sql` gets the statement timeout only (no socket hook). Never build a pool with bare `postgres()`.
- **`@oxy.so/db`'s migrator takes NO lock** — the interlock is the caller's; for a GitHub deploy that's a workflow `concurrency` group with `cancel-in-progress: false`.
- **A migration's identity in `@oxy.so/db` is the `when` TIMESTAMP in `_journal.json`, not its idx or filename.** Renumbering two colliding migrations by renaming files is NOT sufficient — `when` must also be newer, so a renumber touches the `.sql` filename, the journal entry's idx AND tag AND when, the `meta/NNNN_snapshot.json` filename, and its `prevId` chain. The hazard is invisible on a database migrated from empty (the migrator reads the ledger once and applies the whole journal) and only strands a migration on a database already partway through — i.e. it passes CI and fails in production. The `oxy-db-check-migration-locks` gate fails all of this in the PR (number, idx, `when`, snapshot `prevId` chain, unlisted `.sql`, after the app's `--after` baseline), and `oxy-db-rebase-migrations --onto=origin/main --generate="<the app's drizzle-kit generate>"` fixes it after a `git merge origin/main` (renumbers, chains, regenerates the last snapshot, keeps the hand-written SQL; Mention: `bun run --cwd packages/backend db:rebase-migrations`).
- **Vitest's default sequencer orders files by SIZE**, so any new test file reshuffles run order and can fail an unrelated order-dependent test — diagnose by instrumenting the value at point of use, not by comparing pass rates.
- **Any realdb assertion that AGGREGATES must be scoped to ids the file owns** — an unscoped `count(*)` reads correctly until a sibling file seeds more rows into the shared database. Scope to owned ids; never just rename fixtures.
- **An EQUALITY between two counts is vacuous at zero** — pair it with a non-zero FLOOR, retired only when the count legitimately reaches zero.
- **Postgres test databases contend under parallel vitest files** — `FAIL x.test.ts` with `Tests 0 failed` is a load failure, not a regression. Baseline on the base revision under the SAME parallel conditions — isolation is the variable under test, not a control to hold constant.
- **A hardcoded ABSOLUTE date in a committed fixture is a time bomb that detonates in a SIBLING file** — a past-pinned `expiresAt` can collide with another file's expiry sweep against the shared database. Write fixture instants RELATIVE to `now`.

## Drizzle `sql` templates — binding traps

- **A bare array renders as a ROW CONSTRUCTOR.** Use `inArray`/`notInArray` for membership; `sql.param([...])` + `any(...)` for array operators (`&&`, `@>`).
- **A bare `Date` fails at SERIALISATION in the driver** (not the server), with or without a range constructor. Bind ISO strings with an explicit cast: `` sql`${iso}::timestamptz` ``.
- **A value interpolated into a `check()` becomes the literal `$1` in the generated migration** and fails at APPLY time. Use `sql.raw` for the constant side. Gate: fail the build on any `$<digit>` in a generated migration.
- **`excluded.<col>` must be spelled out** — interpolating the column object emits the JS PROPERTY name, so camelCase becomes `excluded.deviceid` → `42703` at runtime. `@oxy.so/db` ships `sqlColumnName`.
- **postgres.js decodes `bigint`/`int8` as a STRING**, including `max()`/`sum()` results, while drizzle types it `number` — so `max + 1` is string concatenation. Coerce at the boundary or cast in the query. A test that performs the operation ONCE cannot catch it.
- **`mode: 'number'` is applied by the RESULT MAPPER, so it does not apply to a raw `db.execute`** — the same column returns `number` from the query builder and `string` from raw SQL, typed `number` either way.
- **A foreign key must target `unique()` or a PRIMARY KEY, never `uniqueIndex()`** — drizzle-kit emits every FK before every `CREATE UNIQUE INDEX`, so the target does not exist yet (`42830` at apply time).
- **Verify any self- or circular FK against the GENERATED SQL and `pg_constraint`**, never the declaration — a column-level circular reference has been silently dropped from both the migration and the snapshot. Mutation-test that guard by DELETING the `ADD CONSTRAINT`.

## Tests against a real database

A Postgres-backed suite refuses to run without a server, deliberately: a skipped row-level-security
test is a green run that gated nothing. Point each repo's test URL variable (`TEST_DATABASE_URL` in
oxy and Mention) at a server you can create databases on; the harness creates and disposes its own.
