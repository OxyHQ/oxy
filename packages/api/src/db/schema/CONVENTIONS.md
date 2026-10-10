# Postgres schema conventions

Binding for every table in this schema. Decision + reason, nothing else.
The prime directives live in the migration contract: **no relational link may be
lost**, and **every rule the schema can enforce, it enforces**.

Several of these are enforced by tests, not by discipline — see the bottom.

---

## Naming

**Tables: explicit snake_case, plural.** `push_tokens`, not a derived
`pushtokens`. A `pluralize()`-derived name is an artifact, not a design
(`appaffinityeventseens` is not a word); name every table explicitly.

**Columns: camelCase in TypeScript, snake_case in SQL**, derived by drizzle. Do
not pass an explicit column name unless the SQL name genuinely differs from the
property.

**`@oxy.so/db`'s casing module is the naming authority.** `DATABASE_CASING` is read by
`drizzle()` (what queries reference), by `drizzle.config.ts` (what the DDL
creates), and by `sqlColumnName`. One setting, not three copies.

> **Trap:** `column.name` on a drizzle column is the TypeScript **property** name
> (`expiresAt`), never the SQL name (`expires_at`) — casing is applied when SQL
> is built. Using it in hand-written SQL throws `column "expiresAt" does not
> exist`; using it in a catalogue query or a `endsWith('_id')` filter silently
> matches nothing and the check passes vacuously. Always `sqlColumnName(column)`,
> or interpolate the Column itself into `sql` and let drizzle render it.

> **Trap, second guise — the one that costs data, not a crash:** a drizzle column
> interpolated into `sql` renders **bare** when its table is not in that
> statement's `FROM`. In a correlated subquery,
> `where ${userLinkMetadata.userId} = ${users.id}` renders
> `where "user_id" = "id"` — both names then resolve against the SUBQUERY's own
> table, the predicate compares two of its columns to each other, and the query
> returns `[]` **with no error at all**. This shipped silently: `linksMetadata`
> and both follow counts read empty/zero on every public profile until a test
> caught it. Qualify every correlated reference (`qualified(column)` in
> `src/utils/profileQuery.ts`, built on `sqlColumnName`), and treat "a correlated
> subquery returned nothing" as a bug in the SQL until proven otherwise — the
> failure mode is an empty result, not an exception.
>
> Related: `${col} <> all(${jsArray})` binds a TUPLE, not an array, and Postgres
> raises `op ANY/ALL (array) requires array on right side`. Use `notInArray`.

**Reserved words are fine.** `labels.order` stays `order`; drizzle quotes every
identifier it emits. Hand-written SQL must quote it too. Renaming it would put a
gratuitous divergence between the schema and the wire contract.

## Primary keys

`text`, holding the 24-char ObjectId hex verbatim for pre-cutover rows and a
**uuid v7** for new ones. Decided in the contract — the column type is uniform,
the value format is mixed, and that is data rather than debt only while nothing
parses an id.

**v7 is generated in the application** (`generatedId()` in `columns.ts`, via
`$defaultFn`), not by a database `DEFAULT`. Postgres 17 has no native `uuidv7()`
(it lands in 18); the alternatives are the `pg_uuidv7` extension or a
hand-maintained plpgsql function, either of which must be installed identically
in dev, CI and RDS before the first migration can run. Generating in the
application also means the id is known before the insert round-trip. Rows
inserted by raw SQL get no id — intended: the backfill supplies `_id` verbatim,
which is how every existing foreign key survives.

A table whose id is content-addressed says so by using a plain
`text().primaryKey()` with no generator.

## Closed value sets

**`text` + a CHECK constraint. Never a pg `enum` type.**

- `text({ enum: [...] })` gives drizzle the same literal-union TypeScript type an
  enum would, so the enum type buys nothing at compile time.
- Adding a value to a pg enum is easy; **removing or renaming one is not
  possible** — you create a new type, alter every column, drop the old. A CHECK
  is ordinary `DROP CONSTRAINT` / `ADD CONSTRAINT`, reviewable in the generated
  SQL, and symmetric for add and remove.
- Declare the values once as a `const` tuple and derive both the column type and
  the CHECK from it, so they cannot drift.

A CHECK also removes a legacy branch from every reader. `auth_challenges.purpose`
is `NOT NULL DEFAULT 'signin'` with a CHECK, so no reader has to treat a missing
purpose as `'signin'`.

## Timestamps

Always `timestamptz`, always `mode: 'date'` (`timestamptz()` in `columns.ts`).
`timestamp` without a time zone reinterprets the value in the session's
`TimeZone` on every read, silently changing what a stored instant means.

| Table kind | Columns |
|---|---|
| Mutable rows | `created_at` + `updated_at`, both `NOT NULL DEFAULT now()` |
| Append-only rows | `created_at` only — the ABSENCE of `updated_at` is the append-only contract |

**`updated_at` is maintained by the application** (`$onUpdate`). Deliberately
not a trigger: a trigger is invisible in the schema file, and it would fire
during backfill and maintenance writes and overwrite the historical value those
writes exist to preserve.

## Foreign keys

Every relation gets a real constraint with an **explicitly decided `ON DELETE`**.
Postgres enforces referential integrity; do not waste it.

A table can land before its parent, and drizzle cannot express a forward
reference. Such a foreign key goes in `DEFERRED_FOREIGN_KEYS`
(`deferredForeignKeys.ts`) **as data, with its `ON DELETE` and reason already
decided** — and the test turns it into a gate: the moment the parent table
appears in the barrel, the run goes red naming every column that must now
reference it. An empty ledger is the finish line.

`ID_COLUMNS_WITHOUT_FOREIGN_KEY` is the permanent counterpart: `*_id` columns
that will never carry a constraint (a cross-service id like `bookmarks.post_id`,
or an id-shaped value that is not a row id at all). Between the two lists and the
real constraints, every id-shaped column is classified, which is what lets a NEW
unclassified one fail.

**`ON DELETE SET NULL` needs care where NULL already means something.**
`push_tokens.application_id` is `CASCADE`, not `SET NULL`, because NULL there
means "not scoped to any application" — `SET NULL` would promote a dead app's
install into the unscoped delivery set instead of retiring it.

`ON UPDATE` is never declared: ids are immutable.

## Expiry

Postgres has no TTL index. The mechanism is defined once in
`@oxy.so/db/expiry`; this schema's own registry lives in `db/expiry.ts`, and a
table adds an entry there rather than its own cleanup path. An entry is
`{ table, column, retentionSeconds }` → `delete where column <= now() - N`, and it
covers three shapes:

| Shape | Registry entry |
|---|---|
| a deadline column | the column IS the deadline, `retentionSeconds: 0` |
| a retention window | retention window on a birth column (`created_at`) |
| a deadline plus grace | same shape, different column — the row deliberately outlives its own deadline so a read can answer "expired" rather than "never existed" |

Every registered column MUST have a supporting btree index (the sweep's predicate
is a range scan). Deletion is batched via `ctid` so a backlog cannot hold one
long transaction open.

**Coexistence with reads — the part that must not be lost.** A sweep lags one
interval. Two classes of read path exist and they are not interchangeable:

- **(A) Reads that filter on expiry themselves** (`expires_at > now()`). For
  these the sweep is pure housekeeping. **Every such filter stays.** Dropping one
  because "the sweep handles it" turns a bounded lag into a live credential.
- **(B) Reads that do NOT filter and rely on the row already being gone.** There
  the sweep is a CORRECTNESS mechanism and the interval is how stale a served
  value can be. Do not write one: add the read-side filter and keep the read in
  class (A), so no table's correctness depends on a job running.

## Unique constraints

A uniqueness rule is a `UNIQUE` constraint, or a partial unique index
(`uniqueIndex().where(...)`) when it applies to a subset of rows.

**A nullable unique column needs no workaround.** Postgres unique indexes treat
NULLs as DISTINCT by default, so a plain `UNIQUE` on a nullable column
(`device_sessions.secret_hash`, `auth_sessions.authorize_code`) is already correct.
And it must **never** become `''` — an empty string is a VALUE, so it collides
for real, converting a non-problem into a live bug.

**Case-insensitive unique: a unique index on `lower(name)`, not `citext`.**
`labels` names are unique per user regardless of case.

- `citext` is an extension: `CREATE EXTENSION` would have to run in dev, CI and
  RDS before the first migration, an ordering dependency in every environment for
  one column. (Since PostGIS was adopted there IS now a mechanism for that —
  `@oxy.so/db/migrate`'s `ensureExtensions`, fed this schema's own registry in
  `db/extensions.ts`, see below — but a mechanism is not a reason: the two
  objections that follow are what decide `citext`, and both stand.)
- `citext` changes behaviour for EVERY comparison on that column, including ones
  the author never considered.
- An expression index makes the case-insensitivity visible AT the constraint and
  leaves the stored value exactly as the user typed it.

The cost, and it is real: **every lookup must be written
`where user_id = $1 and lower(name) = lower($2)`.** A plain `name = $2` is
correct-looking, case-sensitive, and will not use the index.

**The same expression-index shape is how `trim`/`lowercase` survives on an
IDENTIFIER.** `users.username`, `users.email` and `users.public_key` are unique
on `lower(btrim(...))`. For `email` and `public_key` the stored value is
already trimmed and lower-cased, and the index additionally survives a call site
that forgets to normalize.

For `username` the index is what makes the case-insensitive lookup sound: every
lookup matches case-insensitively, so `Nate` and `nate` must not be able to
coexist, and the expression index lets that lookup use a b-tree.

`btrim` is in the expression and not just `lower` because `hashed_email` is
canonicalized with `lower(btrim(...))`: two rows that hash to the same
contact-discovery token must not be able to exist as separate accounts.

This is deliberately NOT applied to every trimmed/lower-cased column — only where
the value is an IDENTITY the system resolves an account by. Everything else
re-applies normalization at the call site, per the section above.

## Arrays and objects

- A scalar array (`transports: [String]`) → a native `type[]`. Postgres arrays
  are first-class; a child table for ≤5 values never queried by element is
  over-normalization.
- An array of IDS or entities → a real junction table with real foreign keys.
  Never a `jsonb` id array: it cannot be joined, constrained, or usefully
  indexed.
- A `Mixed`/`Map`/nested object with a known shape → real columns or a child
  table. `jsonb` is for genuinely shape-less data only.
- `default: undefined` on an array means "absent", which is a nullable column
  with NO default — not `'{}'`, which is a different value.

## Normalization that lives at the call site

Trimming, lower-casing and setter-style defaults are APPLICATION behaviour, not
schema, and skipping them silently changes what gets stored (`push_tokens.token`
is trimmed; `sender_avatars.email` is lower-cased). **Apply each one at the call
site.** They are deliberately NOT encoded as CHECK constraints here: a CHECK
would reject existing production rows and convert a silent normalization into a
500.

Drizzle enumerates columns explicitly, so `db.select().from(t)` returns
EVERYTHING. Reads that feed a client DTO must select columns explicitly. The
GLOBAL mechanism for the columns where that leak is a security failure rather
than a privacy smell is the next section.

Two derivations DO live in the schema on `users`, and both are better there than
as application code — see "Generated columns" and the identifier indexes under
"Unique constraints".

## Protected columns — the `select: false` replacement

**Binding on every table and every repo. Decided once, in
`protectedColumns.ts`; do not invent a second mechanism.**

Eleven columns across `User` and `Message` were `select: false`, and two of them
(`hashedEmail`, `hashedPhone`) had a SECOND guard — a `delete` in both `toJSON`
transforms. A naive drizzle port keeps NEITHER: `db.select().from(users)` returns
the raw phone number, the contact-discovery hashes and the refresh token, without
naming any of them.

Four parts, and the third is the one a convention could not give you:

1. **The registry is data.** `PROTECTED_COLUMNS_BY_TABLE` (machine-readable) plus
   `PROTECTED_COLUMNS` (the same set with a reason per column). Same shape as
   `DEFERRED_FOREIGN_KEYS`, for the same reason.
2. **`publicColumns(table)` is the sanctioned read.**
   `db.select(publicColumns(users)).from(users)`.
3. **The exclusion is at the TYPE level.** The resulting row type has no `phone`
   property, so a serializer that reads one fails `tsc` rather than shipping it.
4. **Opting in is explicit and greppable.** A server-only path names the column:
   `db.select({ id: users.id, phone: users.phone }).from(users)`. There is
   deliberately no helper for this — it must read differently from an ordinary
   select.

`publicColumns` cannot defend against not being called, so
`__tests__/protectedColumns.test.ts` scans `src/` for the two shapes that return
every column IMPLICITLY — a bare `select()` and the relational `db.query.<table>`
API — against any table in the registry, and fails naming the `file:line`.

This restores the FIRST of the two guards. The `toJSON` transform is the API
RESPONSE contract (`ret.id = _id`, then `delete` of `password`, `_id`,
`hashedEmail`, `hashedPhone`) and must be reproduced at the serializer.

## Generated columns

Where a value is derived from other columns, the derivation belongs in the schema —
not because it is tidier, but because a hook is bypassable and a
`GENERATED ALWAYS ... STORED` column is not. No write path (route, service,
backfill, `psql`) can produce a row whose derived value disagrees with its
source, and the column is not writable at all: an attempt fails with SQLSTATE
`428C9`.

Two on `users`/`user_locations`:

- `hashed_email` / `hashed_phone`, replacing the `pre('validate')`
  `syncContactHashes` hook whose own doc comment called it the single source of
  truth "precisely because bypassing it is the known failure mode".
- `user_locations.search_vector`, the location text-search vector.

**The trap: the expression must be IMMUTABLE, and the obvious spellings are not.**

| Want | Rejected | Use |
|---|---|---|
| UTF-8 bytes of a text value | `convert_to(x, 'UTF8')` — STABLE | `decode(replace(x, '\', '\\'), 'escape')` |
| a `tsvector` | `to_tsvector(x)` — STABLE, reads `default_text_search_config` | `to_tsvector('english', x)` with a LITERAL config |

The backslash doubling is what makes `decode(…, 'escape')` an exact inverse
rather than an approximate one — `decode` interprets `\nnn` and `\\`, so
pre-doubling every backslash round-trips any input byte for byte. Verified
against `convert_to` over ASCII, multibyte UTF-8, literal backslashes and
octal-looking sequences.

The alternative — an `IMMUTABLE` SQL wrapper function — was rejected: it is DDL
`drizzle-kit generate` cannot emit from a schema file, so it would need a
hand-written migration ordered before every table that uses it, in every
environment. The same objection as an extension.

A generated column is what `sha256(bytea)` forces; note core Postgres marks
`md5(text)` IMMUTABLE while `convert_to` is STABLE, so the labelling is a
conservatism about the server encoding rather than a semantic difference.

**Known boundary, accepted:** `lower()` applies simple case mapping, JS
`toLowerCase()` applies full Unicode case mapping. They differ for a handful of
codepoints (U+0130 `İ` is the classic), so an email local part containing one
would hash differently on the client and in the database. Non-ASCII local parts
are vanishingly rare; hashing in application code to avoid it would reintroduce
the bypassable hook this replaces. The agreement is pinned by test over a
realistic corpus.

## Text search

Full-text search is a `tsvector` GENERATED column plus a GIN index — never
`LIKE '%…%'`, which is not a text index but a table scan wearing one's clothes.
The language is the `to_tsvector` configuration; `user_locations` uses
`'english'`.

## PostGIS — adopted, and the point is GENERATED

`findLocationsNear` is a real nearest-within-distance query, so
`user_locations` carries a `geography` point column (WGS 84 / SRID 4326) with a
GiST index.
No `earthdistance`/`cube` stand-in and no bounding box dressed up as a distance
— a wrong "nearby" is worse than an absent one, and a query that looks like a
distance search while answering a narrower question is the failure mode to
avoid.

**The column is `GENERATED ALWAYS AS (ST_MakePoint(longitude, latitude)::geography) STORED`,
never written.** That shape is the decision, not the type. A hand-written geo
column and the two coordinate columns are two representations of one fact, so
they can disagree — and the classic failure is a coordinate-ordering mistake: a
`{ lat, lon }` pair read POSITIONALLY as `[longitude, latitude]` transposes every
point. Generating the point makes
divergence unrepresentable (a write fails with SQLSTATE `428C9`) and states the
`(longitude, latitude)` order in ONE place, once. NAMED coordinate columns
remain the other half of the same fix: there is no ordering left to get wrong at
the call site either.

The expression is legal in a generated column only because every part of it is
IMMUTABLE, which is a property of the PostGIS version and is therefore MEASURED
rather than assumed — `st_makepoint(double precision, double precision)` and the
`geometry → geography` cast both report `provolatile = 'i'` (PostGIS 3.5.2 /
PostgreSQL 17.5). Same trap as the `to_tsvector`/`convert_to` row in "Generated
columns" above.

**The extension is a precondition of the MIGRATOR, not a migration.** This file
refused `citext` partly over "an install-ordering dependency in every
environment"; that objection is answered rather than ignored. `db/extensions.ts`
declares the requirement as data, and `@oxy.so/db/migrate`'s `ensureExtensions`
runs it before applying any migration, so the ordering cannot be got wrong by
renumbering, squashing or regenerating the sequence — which matters because
migrations here are regenerated centrally from schema TS.
`docker-compose.dev.yml` and the CI service container both run
`postgis/postgis:17-3.5`. A managed database needs `CREATE EXTENSION postgis`
run once by a privileged role; after that the migration role's
`CREATE EXTENSION IF NOT EXISTS` short-circuits before the privilege check and
is a no-op.

**drizzle-kit cannot emit the `(Point,4326)` typmod.** Its `parseType` quotes any
type name outside a hardcoded list (`geometry` is on it, `geography` is not — as
of drizzle-kit 0.31.10), so `geography(Point,4326)` becomes an unresolvable
identifier. The column is declared as bare `geography`; the typmod would only
constrain WRITES, and there are none. That the stored value really is a Point at
SRID 4326 is asserted against real rows in `db/__tests__/postgis.test.ts`.

The location DATA is live independently of the spatial index — people search
matches on `name`, `city` and `country` (`utils/profileQuery.ts:97-102`) — so
the non-spatial indexes stay.

## Indexes

Keep the indexes that earn their keep, drop the ones that do not, add the ones
a real query needs. Examples of each:

- **Dropped as redundant:** a standalone `{userId: 1}` alongside a compound
  unique that already leads with `user_id` — a btree serves any leading prefix.
- **Dropped as redundant:** `auth_challenges` `{publicKey, challenge}`, when
  every read is keyed on the high-entropy `challenge` the unique index answers.
- **Added for a real query:** `blocks(blocked_id)`. `graphExclusion.ts` and
  `user.service.ts` both query that direction, which the `(user_id, blocked_id)`
  index cannot serve.
- **Added because the table had none:** `bookmarks(user_id)`.

Do not add an index speculatively. `labels` gets none for its `order, name` sort:
a user holds a few dozen labels and sorting them is free.

---

## What is enforced by a test

Not by discipline — these fail the build.

| Convention | Test |
|---|---|
| Deferred FK becomes mandatory when its parent lands | `schema/__tests__/foreignKeys.test.ts` |
| Every id-shaped column is classified | same |
| snake_case tables and columns; every table has a PK | `schema/__tests__/schemaInvariants.test.ts` |
| Every timestamp is `timestamptz` | same |
| No `''` default; no `__v` / `_id` | same |
| Case-insensitive unique, compound unique, CHECK sets, bytea round-trip, id format and ordering, `updated_at` maintenance | `schema/__tests__/constraints.test.ts` |
| Sweep semantics, batching, and the index each swept column requires | `db/__tests__/expiry.test.ts` |
| Protected-column registry, `publicColumns` filter, and no implicit whole-row read anywhere in `src/` | `schema/__tests__/protectedColumns.test.ts` |
| Generated contact hashes match `contactHash.ts` byte for byte; identifier uniqueness; closed value sets and value CHECKs on `users` | `schema/__tests__/users.test.ts` |
| Child-table relations, the coordinate fix, the search vector, ancestor-path ordering, and what deleting an account actually does | `schema/__tests__/userChildTables.test.ts` |
| Every required extension is installed before migration and re-runnable unprivileged; `geo` is generated/stored/GiST-indexed and built as `(longitude, latitude)` | `db/__tests__/postgis.test.ts` |
| Both halves of the `device_sessions` ⇄ `device_account_contexts` CYCLE reached `pg_constraint`; what each `ON DELETE` on a principal, a context and a device actually does; that one account under two principals is now storable | `schema/__tests__/devicePrincipals.test.ts` |
| Migration 0028's backfill, executed VERBATIM out of the migration file against a seeded corpus — one device per class, with the two structurally-impossible conflict classes given a positive control | `schema/__tests__/devicePrincipalsBackfill.test.ts` |

All of them run against a real Postgres through the application's own pool. Each
has been mutation-tested: break the thing it guards and it goes red naming the
offending table and column.
