# Mongo → Postgres ports

What to verify before and while porting a domain from MongoDB to PostgreSQL. Storage semantics of the
destination: [postgres-and-drizzle.md](postgres-and-drizzle.md).

The destination is a clean PostgreSQL-only runtime. A dual-read or Mongo
fallback is a temporary measured migration mechanism, never the final state.
New code, services and scaffolds must not introduce MongoDB, Mongoose,
`MONGO_*`, `MONGODB_*` or a localhost Mongo fallback. A leftover source
reference is migration debt to inventory and remove, not an approved exception.

## Port checklist

- **Count MODEL imports, not driver imports** — `grep mongoose` is wrong both ways. Match the import PATH, enumerate importers, classify runtime/type-only/test; type-only importers often must keep their types. Blind to RELATIVE sibling imports.
- **A LIVE service with an empty catalogue has no more row-level verification than a parked one** — "serving" and "checkable" are different claims. Verifiable: 200-vs-500, 401-vs-404/502, a health-payload diff, running count holding steady.
- **Before deleting a BLOCK of config, grep every name in it** — a var commented as belonging to one system can be read by an unrelated one elsewhere (e.g. `REDIS_CA_CERT || CA_CERT`).
- **When the target store is EMPTY, there's no post-cutover verification available** — zero is what a correct read and a broken switch both return. Establish correctness claims in tests BEFORE the switch, with rows seeded by the migrator so zero means filtering, not emptiness.
- **A model declared INLINE beside its functions is usually — not always — one nobody could import** (good news for the port), but check every case; some are exported with real call sites. The hardest things to FIND are often the easiest to PORT.
- **The boundary question has TWO levels:** does a transaction span the slice (sizes it), and does a TABLE span files that would be ported separately (decides if it can be subdivided at all) — the mechanism of a coupling is often a FILE, not a transaction.
- **An importer census can't tell you how to SPLIT the port — only shared TRANSACTION boundaries can** (a Mongo `ClientSession` can't enlist a Postgres write). But atomicity binds the SWITCH, not repository CONSTRUCTION — land repositories and coverage as separate PRs of not-yet-called code; the welded component shrinks to one rewiring commit.
- **A WRITE followed by a READ-BACK of the same entity in one request is a coupling boundary** — a create-then-hydrate controller couples write to read; a "reads first, writes later" split is structurally blind to it. Files that commit and observe together switch together.
- **A hydration helper that LOADS its own related entities can't be seamed by adapting its argument type** — the seam is what it fetches, not what it accepts.
- **An edit list must be built from BINDINGS, not files, and print its RESIDUAL** — static-import censuses miss dynamic `await import(...)` and bare-string `mongoose.model('Name')` lookups with no import at all. A file scoring zero call sites can still have several; grep every model name repo-wide, including comments.
- **A list of EXEMPTIONS needs its own exact-count assertion**, not just a floor — an ever-growing list is the gate switching itself off one defensible line at a time.
- **A GREEN whose command never started looks exactly like a green** (e.g. a log dir that doesn't exist, failing the redirect before anything runs) — sanity-check duration/output volume, or assert a positive control the run must have produced.
- **Two COUNTS agreeing is not identity** — "N rows, N entries" reads the same whether current or superseded. Verify by content (hash, timestamp), not count equality.
- **A broken pattern prints a clean ZERO** — an unescaped regex character can error while a tidy `0` lands beside real numbers. Every pattern needs a positive control matching something known-present.
- **A chokepoint helper returning a DOCUMENT hides call sites below every census** — `doc.addCredits()`/`.save()` on a document from a helper import no model. Grep each model's `schema.methods`/`schema.statics` names repo-wide, plus `.save()` on variables holding such documents.
- **The two miss-classes are asymmetric** — a missed `Model.verb()` THROWS under `bufferCommands: false`; a missed document-shape read (`doc.credits.free` on a flattened column) silently returns `undefined`, and `undefined || 0` yields **0**.
- **A Model-STATIC census misses the hydrated-DOCUMENT surface by roughly 2x** wherever a helper hands back a live document to mutate and `save()` — and `save` is on `Model.prototype`, not `Document.prototype`, so deriving from `Document` alone misses it.
- **A model MODULE often carries co-located constants/types** — importers of those never touch the model, invisible to consumer and residual censuses, and break the instant the module is deleted. Grep its OTHER exports first.
- **A call-site pattern requiring `.method(` misses GENERIC calls** — a type argument (`Model.aggregate<{…}>(`) sits between name and paren. Drop the paren requirement.
- **A verb list derived from the DRIVER misses custom statics/instance methods** (`Schema.statics`, `.save()`) — add a second pass over model-file exports.
- **A census needs a positive control on its OUTPUT, not only its inputs** — an AST walk matching nothing prints the same "0 models" as a correct census. Assert a floor on what was FOUND.
- **Check the enlistment FORM the code actually uses** — a census grepping chained `.session(` can miss a package that enlists via `{ session }` options, a false alarm costing a redesign.
- **The two error directions of a coupling census are NOT symmetric** — over-linking costs extra work (safe); under-linking (a verb list from memory missing one verb) SPLITS A REAL TRANSACTION. Derive verb lists from the driver, never recall.
- **A mixed read path defeats a grep census in the PERMISSIVE direction** — a controller reading one table from Postgres, another from Mongo, reads as "still on Mongo". Date any mid-port census and say what's already moved.
- **"We cannot know" is a CLAIM needing evidence like any other** — check whether a measurement was ARCHIVED (e.g. a row-count dump in a backups bucket) before writing "unknowable".
- **State a rule's PRECONDITION out loud when invoking it** — a well-internalised rule fires on pattern match and skips its own preconditions (e.g. Mongo atomicity rules applied to a repo with no Mongo).
- **Count the rows before switching a domain** — state "source holds N rows, here's what happens to them" in every port PR. Enumerate the whole host (`listDatabases`) and name the target explicitly.
- **After the port, the ABSENCE of a table stops being a signal** — code inferring meaning from a missing collection silently becomes false in the permissive direction. Convert to a ROW COUNT.
- **A proof about the code as it stands is not a proof about the rows already in the table.** An agent nearly dropped two analytics columns on the grounds that today's only writer puts a placeholder in them — git history showed an EARLIER writer, 29 days of it, writing real values nowhere else recorded. Walk `git log -S` over the writers of a column, not just its current callers, before a drop; a column drop is not reversible.
- **Use the KNOWN-WRONG instrument's output as the positive control for the corrected one** — run the naive version once deliberately, use its phantom gaps to prove the corrected version does something.
- **Two ways a writer-vs-columns check goes wrong:** (a) `getTableConfig().columns[].name` is the TS property name not the SQL identifier — use `sqlColumnName`; (b) filtering Mongoose descriptors (`type`, `default`) must apply to the MODEL file only, not the writers, or a genuinely-set field hides a real gap.
- **A `pgTable` can OMIT a column its writer writes, and every gate stays green** — `tsc` doesn't object, a schema-independence test doesn't compare field sets. Diff the WRITER's field list against the table's columns, one grep per table, before porting.
- **AN INDEX IS THE ONE THING A FUNCTIONAL TEST CAN NEVER DETECT THE ABSENCE OF** — a missing compound index surfaces only as a slow query; a generated-column `DROP`+`ADD` can silently destroy a GIN index with zero functional symptom. Port indexes deliberately; assert existence post-migration.
- **Porting a duplicate-key CATCH as an exception handler answers "already done" to an infrastructure failure** — Postgres can't distinguish a duplicate from a dropped connection in a catch. Use `ON CONFLICT … DO NOTHING RETURNING` so a real failure still propagates.
- **A validator that never RAN must not become a constraint that does** — Mongoose validators don't run on `updateOne`/`findOneAndUpdate`. If it never fired, drop it and say so.
- **A ported table leaves readers in OTHER files silently answering ZERO** — grep the WHOLE repo for readers before porting, not just the batch being touched.
- **`$all: []` matches NOTHING in Mongo; `col @> '{}'` matches EVERYTHING in Postgres** — the obvious translation flips "no candidate qualifies" into "every row qualifies". Use an EXPLICIT branch, not a containment predicate; grep the tree for `$all`.
- **A LATENT port bug deserves more care than a live one** — it waits for someone else's unrelated change to make it reachable, then presents as normal operation. "Unreachable today" is what lets it survive review.
- **When nothing in the ITEM distinguishes new from old, put the distinction in the LIST** — a frozen historical record plus a working list asserted as its SUBSET; editing the working list can then only remove. Keep a size assertion too.
- **Evaluate every ported operator on the DEGENERATE input on both sides** (empty array/string, null, zero) — clause-by-clause translation is exactly what hides these.
- **`$set: { x: undefined }` is a NO-OP in Mongo; the same statement in Postgres writes NULL** — build the SET clause from defined keys only.
- **A `ref: 'X'` ObjectId column ported to `text` turns a CastError into a silent non-match** — Mongoose threw, Postgres just doesn't match. Needs a test.
- **Mongo reports `modifiedCount` AND `matchedCount`; Postgres reports only `rowCount` (behaves like `matchedCount`)** — read which count each caller consumes. `upsertedCount` needs `RETURNING (xmax = 0)`. A REPEATED call is the discriminator.
- **Mongoose hooks have no Postgres counterpart** — establish whether each hook RUNS AT ALL, then: database can express it ⇒ delete + handle the violation code; needs computation/crypto ⇒ re-express at ONE write chokepoint with a removal-fails test; enforced nothing ⇒ drop and say so.
- **A Mongoose SETTER is classified by what depends on it:** unique ⇒ a FUNCTIONAL index; secret ⇒ a column type; normalising only ⇒ an ordinary repository concern.
- **ENCRYPT WHAT IS ONLY EVER READ, NEVER WHAT IS MATCHED ON** — a randomized-IV scheme makes equality lookups silently 404. Use a deterministic keyed digest for lookups.
- **A field-level `get`/`set` decides what your BACKFILL copies** — `getters: true` yields plaintext, the raw driver yields ciphertext, same copy opposite outcome. Read through the RAW driver, copy verbatim, assert the ciphertext SHAPE.
- **The port is the moment to make an EXISTING invariant structural, not to INVENT one** — a lossy read-modify-write can safely GET a unique constraint; a service-layer uniqueness check should NOT (new constraint on unchecked rows).
- **Port a permission gate as a BOOLEAN, never as the row** — keeping "fetch a stranger's object and filter in the caller" makes a future leak a one-line mistake. An `EXISTS` returning true/false can't leak.
- **A Mongo sub-document array can't carry a unique constraint**, so "don't add it twice" was always a race — the port is the first chance to make it structural.
- **Flattening a discriminated union invites a WRONG biconditional CHECK** — read the WRITERS, not the columns; the correct form is usually a one-direction implication.
- **Keep the backfill's audit list in ONE place grouped by HOW EACH ITEM FAILS** — most fail loudly during backfill; the dangerous few look like a successful copy and fail later in production.

## MongoDB

**`sparse: true` on a UNIQUE index does not exclude a stored `null`** — the second explicit `null` fails with E11000. Use `partialFilterExpression: { <field>: { $type: '<type>' } }`.

**This trap is Mongo-only.** A Postgres unique index is `NULLS DISTINCT` by default, so a plain unique suffices there. Porting the partial predicate under the null-collision reasoning embeds a false belief about Postgres in the schema.
