/**
 * The schema barrel — drizzle-kit's input AND the `drizzle()` schema object.
 *
 * Two consumers must see the same set of tables:
 *
 *  - `drizzle.config.ts` points drizzle-kit's `schema` here, so `bun run
 *    db:generate` diffs what this module exports against `drizzle/` and emits
 *    DDL for the difference.
 *  - `src/db/postgres.ts` imports it as `* as schema` and hands it to
 *    `createDatabase({ schema })`, which is what gives queries their row types.
 *
 * **A table not exported here gets neither a migration nor typed queries.** That
 * is not a partial failure that surfaces as a type error somewhere: a table in a
 * module nobody re-exports does not exist as far as either tool is concerned,
 * `db:generate` reports nothing to do, and the first evidence is a
 * `relation "…" does not exist` at runtime. Add the `export *` line in the same
 * change as the table.
 */

export * from './notes';
