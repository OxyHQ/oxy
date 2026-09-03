# MongoDB → PostgreSQL migration — historical binding contract

> The port is complete and the API runtime is PostgreSQL-only. This file records
> the constraints that governed the port and remains useful when auditing the
> resulting schema; it is not a current Mongo operating or rollback runbook.

Read this before auditing a port decision or changing the resulting schema. It
lives in the repo on purpose: an earlier copy sat in a session scratchpad,
evaporated when that session ended, and seven agents were handed a path to a file
that no longer existed.

Stack: Drizzle ORM over **`postgres.js`** (`drizzle-orm/postgres-js`), migrations
applied by `src/db/migrate.ts` (never `drizzle-kit migrate` in production — the
CLI cannot reach the runtime image). Package manager: bun only.

## Prime directive

Nate's two hard constraints, in his words:

1. **"no quiero perder los vínculos relacionales de nada"** — no relational link may be lost.
2. **"no quiero tricky things, no arrastrar cosas porque sí, todo limpio, eficiente y bien
   estructurado sin cosas innecesarias"** — no Mongo baggage carried into Postgres.

When they conflict, STOP and escalate rather than resolving it silently.

## Design as if Postgres were the original choice

Not a transliteration. Ported-but-wrong is worse than not ported.

**Forbidden:** a compatibility layer that mimics the Mongoose API so call sites can
stay unchanged; embedded id arrays as `jsonb` instead of junction tables; `jsonb`
as a dumping ground for anything that had a known shape; `__v`; dead collections;
denormalized counters inherited only because Mongo could not JOIN.

**Required:** real FK constraints with an explicit `ON DELETE` decided per relation;
junction tables for many-to-many; `NOT NULL` where the data is actually always
present; partial unique indexes where Mongo had sparse/partial unique; an explicit
expiry column plus a documented sweep where Mongo had a TTL; `tsvector` + GIN where
Mongo had a text index.

Standing repo rules apply: no `as any`, no `@ts-ignore`, no `!`, no `any` in
signatures, no silent `catch {}`, no TODO/FIXME, no `console.log`.

## IDs — decided, do not relitigate

Existing 24-char ObjectId hex strings are preserved **verbatim** in `text` columns.
The backfill copies `_id` as-is: zero remapping, so every FK survives by
construction. Remapping to uuid would need an old→new table applied across ~620
collections, and any id NOT declared as a schema `ref` — a loose string id, an id
inside a subdocument, an id in a `Mixed` field — would silently fail to remap and
dangle. Ids are also published externally (DIDs, the signing input of every signed
record, printed Oxy ID QRs, `cloud.oxy.so/<fileId>` URLs cached by remote fediverse
instances), so changing them is unfixable from our side.

New rows post-cutover: **uuid v7**, generated in the application (PG17 has no native
`uuidv7()`).

**`isValidObjectId` / `ObjectId.isValid` guards are DELETED** where they only
prevented a Mongoose `CastError` — Postgres text ids simply match no rows, so the
guard has no reason to exist. Keep explicit validation only where a 400 is a real
documented contract; otherwise a malformed id now returns 404. Review each site:
some branch on the result rather than merely rejecting. The `new Types.ObjectId(...)`
sites are driver artifacts and disappear; they are not ported.

**SECURITY GATE:** `mediaPrivacyService.ts:96-101` and `:122-126` must lose their
`/^[0-9a-f]{24}$/` guards BEFORE any non-hex id exists. They return `false` on a
non-match, and `false` there means NOT BLOCKED / NOT RESTRICTED — a fail-open
bypass of block and restrict enforcement on media, with no error and no log.

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
  GiST index — never a separately-written geo column, because the original Mongo
  defect was a coordinate-ordering mistake and a generated column makes the swap
  unrepresentable. Any spatial test must verify ORDERING against an independently
  checkable real-world distance: a lat/lon swap yields a plausible point in the wrong
  hemisphere, so a test asserting only "a row came back" passes against the exact bug.
- **The transactions fallback is deleted, not translated.** The `withTransaction`
  helpers string-match the "no replica set" error and re-run SESSION-LESS, so those
  paths currently run non-atomically.
- **`select: false` is now `protectedColumns.ts`.** Drizzle enumerates columns
  explicitly, so a naive port makes hidden columns leak.

## Historical production safety during the port

During code-porting, production MongoDB was not touched: it stayed live until a
separately approved cutover, while local data was disposable and agents ran no
production backfill. That was a migration constraint, not the current
architecture. The API now opens only PostgreSQL; do not add a Mongo connection,
URI, model or fallback as a rollback path.

### Every migration declares which side of a deploy it runs on

One line, in the `.sql` file, no default:

```sql
-- oxy:deploy-phase=pre    additive; correct against BOTH the image serving and the one arriving
-- oxy:deploy-phase=post   drops/renames/narrows; only correct once the new image is live
```

The deploy applies them itself — `pre` before the rollout, `post` after — so the
ordering is not something anyone has to remember. `scripts/check-migration-phases.mjs`
fails the pull request when a migration omits the marker or when the deploy stops
applying migrations; `@oxyhq/db`'s `migrate/phases.ts` carries the full reasoning.

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
