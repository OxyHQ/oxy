# Database contract — binding invariants

The API's only database is PostgreSQL. This file records the invariants the
schema and its migrations must hold. Read it before changing the schema or
auditing a schema decision. `schema/CONVENTIONS.md` holds the per-table
conventions that follow from it.

Stack: Drizzle ORM over **`postgres.js`** (`drizzle-orm/postgres-js`), migrations
applied by `src/db/migrate.ts` (never `drizzle-kit migrate` in production — the
CLI cannot reach the runtime image). Package manager: bun only.

## Prime directive

Nate's two hard constraints, in his words:

1. **"no quiero perder los vínculos relacionales de nada"** — no relational link may be lost.
2. **"no quiero tricky things, no arrastrar cosas porque sí, todo limpio, eficiente y bien
   estructurado sin cosas innecesarias"** — nothing carried along without a reason.

When they conflict, STOP and escalate rather than resolving it silently.

## Design the schema as Postgres

**Forbidden:** a compatibility layer that mimics another data-access API so call
sites can stay unchanged; embedded id arrays as `jsonb` instead of junction
tables; `jsonb` as a dumping ground for anything that has a known shape; a
document version counter (`__v`); dead tables; denormalized counters a JOIN can
answer.

**Required:** real FK constraints with an explicit `ON DELETE` decided per relation;
junction tables for many-to-many; `NOT NULL` where the data is actually always
present; partial unique indexes for "unique when present"; an explicit expiry
column plus a documented sweep for time-based retention; `tsvector` + GIN for
full-text search.

Standing repo rules apply: no `as any`, no `@ts-ignore`, no `!`, no `any` in
signatures, no silent `catch {}`, no TODO/FIXME, no `console.log`.

## IDs — decided, do not relitigate

Legacy 24-char hex ids are kept **verbatim** in `text` columns, so every FK holds
by construction. Ids are also published externally (DIDs, the signing input of
every signed record, printed Oxy ID QRs, `cloud.oxy.so/<fileId>` URLs cached by
remote fediverse instances), so changing them is unfixable from our side.

New rows: **uuid v7**, generated in the application (PG17 has no native
`uuidv7()`).

**No `isValidObjectId` guard where it only screens an id's shape** — a `text` id
that matches no row is simply not found, so the guard has no reason to exist.
Keep explicit validation only where a 400 is a real documented contract;
otherwise a malformed id returns 404. Any guard written for the 24-hex shape
alone rejects uuid v7 ids.

**SECURITY:** `mediaPrivacyService.ts` must never gate block/restrict checks on
a 24-hex shape. There, `false` means NOT BLOCKED / NOT RESTRICTED, so a
shape guard that rejects a uuid v7 id is a fail-open bypass of block and
restrict enforcement on media, with no error and no log.

## Settled decisions

- **`signed_records.envelope`, `validation_votes.envelope`, `validation_requests.payload`
  are `jsonb`.** Verification re-canonicalizes from the PARSED value
  (`packages/protocol/src/envelope/canonicalJson.ts` sorts keys at every level), so
  jsonb's reordering, duplicate-key collapse, number reformatting and unicode
  unescaping are representation-only. Measured, not reasoned. One hazard, and it is
  the correct failure mode: a NUL byte in any string fails the INSERT loudly.
- **`users.following[]` / `followers[]` are deleted** — `user_follows` is the single
  authority for the social graph.
- **PostGIS is adopted** (Nate's explicit decision). `user_locations` keeps written
  `latitude`/`longitude` columns and the spatial column is
  `GENERATED ALWAYS AS (ST_MakePoint(longitude, latitude)::geography) STORED` plus a
  GiST index — never a separately-written geo column, because a coordinate-ordering
  mistake is the defect to prevent and a generated column makes the swap
  unrepresentable. Any spatial test must verify ORDERING against an independently
  checkable real-world distance: a lat/lon swap yields a plausible point in the wrong
  hemisphere, so a test asserting only "a row came back" passes against the exact bug.
- **There is no non-transactional fallback.** Multi-write paths run in a real
  transaction in every deployment.
- **Hidden columns are `protectedColumns.ts`.** Drizzle enumerates columns
  explicitly, so a bare `select()` would leak them.

## Every migration declares which side of a deploy it runs on

One line, in the `.sql` file, no default:

```sql
-- oxy:deploy-phase=pre    additive; correct against BOTH the image serving and the one arriving
-- oxy:deploy-phase=post   drops/renames/narrows; only correct once the new image is live
```

The deploy applies them itself — `pre` before the rollout, `post` after — so the
ordering is not something anyone has to remember. `scripts/check-migration-phases.mjs`
fails the pull request when a migration omits the marker or when the deploy stops
applying migrations; `@oxy.so/db`'s `migrate/phases.ts` carries the full reasoning.

Two rules follow, and both bite:

- **Split expand and contract into separate migrations.** A file that adds a column
  and drops another has no single correct side. `0013_users_account_categories` is
  the model: it adds and carries the data, and leaves the drop of
  `organization_category` to its own later migration.
- **A `pre` migration must never land behind an unapplied `post` one.** The ledger
  records progress as a high-water mark and cannot skip an entry, so the migrator
  REFUSES that pending list rather than picking a half that breaks one of the two
  images. Land such a pair in separate releases.

Do NOT edit an already-applied migration to change its SQL. Adding the phase marker
to the fourteen that predate it was safe only because drizzle stores the file hash
but never compares it — pendingness is `created_at` versus the journal's `when`
(verified in `drizzle-orm@0.45.2`, `pg-core/dialect.cjs`).

## Verification — evidence, not assertion

Run each package's OWN `bun run test`; `bun run build` must be run from
`packages/api`, not the repo root (the root has no `build` script and reports a
misleading `error: Script not found "build"`).

**The API wire format must not change.** Every ecosystem app consumes oxy-api and
will not be rebuilt for weeks. Prove response parity for endpoints you touch.

Mutation-test load-bearing assertions: break the thing the test guards, confirm the
test goes red AND names the offending path, then restore the file **in place** and
verify byte-identical. `node_modules` is hardlinked and shared machine-wide — never
leave a mutation live.

Report gaps explicitly. A stated gap is worth more than a confident summary.
