import type { SQL } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DATABASE_CASING } from './casing';

/**
 * The narrowest thing a mechanism in this package needs: something that can run
 * a drizzle SQL chunk and hand back rows.
 *
 * Declared structurally rather than as `PostgresJsDatabase<typeof schema>`,
 * because that type names the CONSUMER's schema and nothing in a shared package
 * may. A transaction handle satisfies it as readily as a pool does, which is
 * what lets a sweep or a gate run inside one — verified directly: both a real
 * `PostgresJsDatabase` and the `tx` handle inside `db.transaction(cb)` type-check
 * as `SqlExecutor` (see `__tests__/database.test.ts`).
 *
 * ## Why `migrate/*` does NOT take one of these
 *
 * Everything under `migrate/` takes a raw `postgres.Sql` instead, and that is a
 * decision rather than an oversight — do not "unify" the two. Migration-time
 * code needs capabilities this interface deliberately does not carry:
 * `readAppliedMillis` builds its query with tagged templates and identifier
 * interpolation (`client(MIGRATIONS_SCHEMA)`), and `ensureExtensions` needs
 * `unsafe()` for DDL that cannot take a bound parameter. Narrowing those to
 * `execute(query: SQL)` would mean rewriting them through drizzle for no gain,
 * on the one code path that must work before a drizzle handle over the
 * caller's schema is meaningful at all. `SqlExecutor` exists so a sweep or a
 * gate can run inside a caller's TRANSACTION; a migrator owns its own
 * single-use connection and has no such requirement.
 *
 * `execute` is deliberately NOT generic on this method. drizzle's own
 * `PgDatabase.execute<TRow>()` returns `PgRaw<PgQueryResultKind<...>>` — a
 * concrete class with private fields, not a plain `Promise<TRow[]>` — so no
 * hand-written `execute<T>(query): Promise<T[]>` can ever structurally match
 * it: TypeScript rejects the assignment on `T` alone (`'T' could be
 * instantiated with an arbitrary type`), and constraining `T` to
 * `Record<string, unknown>` does not fix this, because a generic-method
 * comparison also fails once the source's `T` and the target's `T` are
 * required to unify as arbitrary-but-matching subtypes rather than the exact
 * same type. Fixing the return type to `Record<string, unknown>[]` (still a
 * plain array — `postgres.js`'s `RowList<T>` is `T & Iterable<...> &
 * ResultQueryMeta<...>`, so it structurally IS a `T[]`) removes the
 * conflict entirely: no generic left to disagree over. Row typing at the call
 * site is recovered via {@link executeRows}, a generic FUNCTION rather than a
 * generic METHOD — the shape drizzle's own `execute<TRow>` uses is simply not
 * reachable from a plain interface, but a caller-side assertion is, and it's
 * the same trust boundary drizzle's own generic already relies on (nothing
 * validates `TRow` against the query at runtime, on either side).
 */
export interface SqlExecutor {
  execute(query: SQL): Promise<Record<string, unknown>[]>;
}

/**
 * Run a query through an executor and assert the row shape the caller already
 * knows the query returns — the same trust boundary drizzle's own
 * `db.execute<TRow>()` relies on, recovered here because {@link SqlExecutor}
 * cannot carry a generic method (see its doc comment for why). Nothing here
 * validates `TRow` against the query; a caller asking for the wrong shape gets
 * a wrong TYPE, not a caught error.
 */
export async function executeRows<TRow extends Record<string, unknown>>(
  executor: SqlExecutor,
  query: SQL
): Promise<TRow[]> {
  return (await executor.execute(query)) as TRow[];
}

/**
 * A drizzle handle over the consumer's own schema. Drizzle's own `drizzle()`
 * factory returns `PostgresJsDatabase<TSchema> & { $client: TClient }` (see
 * `drizzle-orm/postgres-js/driver.d.ts`) — the `$client` escape hatch back to
 * the underlying postgres.js client is really there at runtime, so the type
 * alias has to carry it too, or `createDatabase`'s declared return type lies
 * about what callers actually get back.
 */
export type OxyDatabase<TSchema extends Record<string, unknown>> = PostgresJsDatabase<TSchema> & {
  $client: postgres.Sql;
};

export interface CreateDatabaseOptions<TSchema extends Record<string, unknown>> {
  /**
   * Connection string for the database this handle talks to.
   *
   * Named `databaseUrl` to match `RunMigrationsOptions.databaseUrl`, so one
   * concept has one name across the package. (`CreateTestDatabaseOptions.adminUrl`
   * is genuinely a different thing — a MAINTENANCE-database URL a throwaway
   * database is created on — and keeps its own name for that reason.)
   */
  readonly databaseUrl: string;
  readonly schema: TSchema;
  /** postgres.js pool options. The caller owns pool sizing and timeouts. */
  readonly client?: postgres.Options<Record<string, never>>;
}

/**
 * Build a drizzle handle and the client underneath it.
 *
 * Deliberately NOT a singleton: process lifecycle, health checks and shutdown
 * ordering differ per application, so each one keeps its own. What this
 * guarantees is the part that must NOT differ — that the handle is built with
 * `DATABASE_CASING`, so the SQL queries reference matches the SQL migrations
 * created.
 *
 * ## No consumer calls this yet, and that is not an oversight
 *
 * It is here for a consumer that has not landed. The application already on
 * this package builds its handle inline, in a `connectPostgres()` that also
 * owns a boot round-trip, pool sizing from its own configuration, and shutdown
 * ordering — it shares the load-bearing part (`DATABASE_CASING`, imported from
 * here) and adopting this would be a refactor of that function rather than a
 * fix to anything. Do not delete this as dead code, and do not read its
 * unused-ness as evidence the guarantee above is unwanted; the guarantee is
 * exactly what a NEW consumer, wiring up drizzle for the first time, is most
 * likely to get wrong.
 */
export function createDatabase<TSchema extends Record<string, unknown>>(
  options: CreateDatabaseOptions<TSchema>
): { db: OxyDatabase<TSchema>; client: postgres.Sql } {
  const client = postgres(options.databaseUrl, options.client);
  return {
    db: drizzle(client, { schema: options.schema, casing: DATABASE_CASING }),
    client,
  };
}
