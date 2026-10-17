/**
 * Which Postgres client library this package drives a connection through.
 *
 * ## Two drivers, one default
 *
 * `postgres-js` (the `postgres` package) is the default everywhere and is the
 * only driver that runs under Node. `bun-sql` is Bun's built-in client
 * (`Bun.SQL`, driven by `drizzle-orm/bun-sql`) and is strictly OPT-IN: a caller
 * names it explicitly, on `createDatabase`, `runMigrations`,
 * `ensureExtensions` and the `@oxy.so/db/testing` harness. Nothing switches on
 * `typeof Bun` by itself — a Bun process that does not ask for `bun-sql` keeps
 * running postgres.js exactly as before, so adopting a new driver is a
 * decision each application makes and can roll back, not a side effect of
 * upgrading this package.
 *
 * ## Why nothing here imports `bun` or `drizzle-orm/bun-sql` at the top level
 *
 * `drizzle-orm/bun-sql` imports `{ SQL } from "bun"` at module load, which
 * Node cannot resolve. A static import anywhere on this package's import graph
 * would make `import('@oxy.so/db')` throw under Node for every consumer,
 * including the ones that never asked for Bun. So the Bun modules are loaded
 * only inside the `bun-sql` branch, after {@link requireBunRuntime} has proven
 * the process is Bun — and `Bun.SQL` itself is read off `globalThis` rather
 * than imported.
 *
 * The load is a synchronous `require()`, which Bun provides in ES modules as
 * well as in CommonJS. Synchronous on purpose: `createDatabase` has always
 * returned its handle synchronously, and a driver option that silently turned
 * it into a Promise would change the shape of the one call a consumer makes at
 * module scope.
 *
 * ## Why the Bun types are declared here rather than imported from `bun`
 *
 * This package's published declarations must typecheck for a Node consumer
 * that has no `@types/bun`. Every Bun-facing type below is therefore a
 * structural SUBSET of `Bun.SQL` written out by hand — a real `Bun.SQL`
 * instance satisfies it, and nothing in `dist/types` names the `bun` module.
 */

import type { SQL } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';

/** The Postgres client a connection is driven through. See this module's header. */
export type DatabaseDriver = 'postgres-js' | 'bun-sql';

/** Every {@link DatabaseDriver}, for a caller validating a configured value. */
export const DATABASE_DRIVERS: readonly DatabaseDriver[] = ['postgres-js', 'bun-sql'];

/** The driver used whenever a caller does not name one. */
export const DEFAULT_DATABASE_DRIVER: DatabaseDriver = 'postgres-js';

/**
 * The one capability every query under `migrate/` and `testing` needs: run a
 * statement with NO bound parameters and get its rows back.
 *
 * Both drivers' clients satisfy it as they are — postgres.js's `Sql.unsafe`
 * and `Bun.SQL#unsafe` — which is what lets `readAppliedMillis`,
 * `assertMigrationTarget`, `assertPostgresMigrationsCurrent` and the rest take
 * either one. Every statement issued through it is built from this package's
 * own constants, never from caller input, so there is nothing to bind.
 */
export interface RawSqlClient {
  unsafe(query: string): PromiseLike<unknown>;
}

/**
 * The part of a `Bun.SQL` instance this package's types expose: tagged-template
 * queries, `unsafe`, and shutdown. A real `Bun.SQL` satisfies it; a consumer
 * with `@types/bun` who needs the rest of the API can annotate the client as
 * `Bun.SQL` at its own call site.
 */
export interface BunSqlClient extends RawSqlClient {
  <T = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<T>;
  unsafe<T = Record<string, unknown>[]>(query: string, values?: unknown[]): PromiseLike<T>;
  /** Close every pooled connection, waiting up to `timeout` SECONDS for in-flight queries. */
  close(options?: { timeout?: number }): Promise<void>;
}

/**
 * The `Bun.SQL` pool options a caller may set, under Bun's own names.
 *
 * The postgres.js option each one corresponds to is named on it, so a handle
 * moved from one driver to the other can keep the same pool behaviour. All
 * durations are in SECONDS in both drivers. A `?sslmode=` in the connection
 * string is honoured by both drivers as well.
 */
export interface BunSqlClientOptions {
  /** Pool size. postgres.js: `max`. Bun's default is 10, the same as postgres.js's. */
  readonly max?: number;
  /** Seconds a connection may sit idle before it is closed; 0 = never. postgres.js: `idle_timeout`. */
  readonly idleTimeout?: number;
  /** Seconds a connection may live before it is recycled; 0 = forever. postgres.js: `max_lifetime`. */
  readonly maxLifetime?: number;
  /** Seconds to wait while establishing a connection. postgres.js: `connect_timeout`. */
  readonly connectionTimeout?: number;
  /**
   * TLS. An SSL mode string, `true`, or a TLS options object (e.g. `{ ca }`).
   * postgres.js: `ssl`, which takes the same mode strings.
   */
  readonly tls?:
    | boolean
    | 'disable'
    | 'allow'
    | 'prefer'
    | 'require'
    | 'verify-ca'
    | 'verify-full'
    | Readonly<Record<string, unknown>>;
  /**
   * Named prepared statements. **Always off on `bun-sql`**: omit it or pass
   * `false`; `true` is refused (a type error here, and a thrown error at
   * runtime for an untyped caller).
   *
   * Why: drizzle's `jsonb()`/`json()` columns `JSON.stringify` a value before
   * binding it, and on a PREPARED statement `Bun.SQL` (1.4.3) learns from the
   * server that the parameter is `jsonb` and JSON-encodes that string again.
   * Every jsonb write then lands as a jsonb STRING holding the JSON text
   * (`jsonb_typeof` = `'string'`), which drizzle's reader `JSON.parse`s back,
   * so reads through drizzle look right while `->`, `@>` and every index on
   * the column see a string. Unprepared, `Bun.SQL` sends the text untyped and
   * the server parses it as JSON, as postgres.js does. The cost is a re-plan
   * per statement, which is also what a transaction-pooling proxy forces.
   *
   * Side effect for raw `client` queries: unprepared, `Bun.SQL` does not
   * JSON-encode an OBJECT bound to a jsonb parameter (it sends
   * `[object Object]`, which the server rejects loudly). Bind
   * `JSON.stringify(value)` instead, as drizzle does.
   *
   * postgres.js: `prepare` (default `true` there, where it is safe: drizzle
   * makes postgres.js pass jsonb text through untouched).
   */
  readonly prepare?: false;
  /** Server runtime parameters sent at connect (`statement_timeout`, ...). postgres.js: `connection`. */
  readonly connection?: Readonly<Record<string, string | boolean | number>>;
}

/**
 * Drizzle's result kind for `drizzle-orm/bun-sql`, restated so this package's
 * declarations need not import that module (whose own declarations import
 * `bun`). Identical to drizzle's `BunSQLQueryResultHKT`; the type test in
 * `database.typetest.ts` holds the two together.
 */
export interface OxyBunSqlQueryResultHKT extends PgQueryResultHKT {
  type: this['row'] extends Record<string, unknown>[] ? this['row'] : Record<string, unknown>[];
}

/** A drizzle handle over the consumer's schema, driven by `Bun.SQL`. */
export type OxyBunSqlDatabase<TSchema extends Record<string, unknown>> = PgDatabase<
  OxyBunSqlQueryResultHKT,
  TSchema
> & {
  $client: BunSqlClient;
};

/** The `Bun` global, to the extent this module reads it. */
interface BunRuntime {
  SQL: new (url: string, options: Record<string, unknown>) => BunSqlClient;
}

/**
 * The `Bun` global, or a refusal that names the option that asked for it.
 *
 * Checked BEFORE anything Bun-specific is loaded, so a Node process configured
 * with `bun-sql` fails with a sentence about its configuration rather than a
 * module-resolution error about a package it never imported.
 */
function requireBunRuntime(): BunRuntime {
  const runtime: unknown = Reflect.get(globalThis, 'Bun');
  if (typeof runtime !== 'object' || runtime === null || !('SQL' in runtime)) {
    throw new Error(
      "@oxy.so/db: driver 'bun-sql' needs the Bun runtime (Bun.SQL), and this process " +
        "is not running on Bun. Use driver 'postgres-js' (the default) under Node.",
    );
  }
  return runtime as BunRuntime;
}

/**
 * Open a `Bun.SQL` pool on `databaseUrl`. `adapter` is pinned to `postgres`
 * so a URL with another scheme fails instead of silently selecting MySQL, and
 * `prepare` is pinned to `false` so a drizzle `jsonb()` write is stored as the
 * value it is rather than as a jsonb string of it (see
 * {@link BunSqlClientOptions.prepare}). `Bun.SQL`'s own default is `true`, so
 * leaving the option out is NOT enough: it is set here on every client, the
 * migrator's and the test harness's included. A URL cannot turn it back on:
 * `Bun.SQL` forwards an unknown `?prepare=` to the server as a runtime
 * parameter, which the server refuses at connect.
 */
export function openBunSqlClient(
  databaseUrl: string,
  options: BunSqlClientOptions = {},
): BunSqlClient {
  const { SQL } = requireBunRuntime();
  // The type forbids `true`; this catches an untyped or cast caller, before any
  // connection is opened, rather than letting it corrupt jsonb writes.
  if ((options.prepare as boolean | undefined) === true) {
    throw new Error(
      "@oxy.so/db: driver 'bun-sql' refuses prepare: true. On a prepared statement " +
        'Bun.SQL JSON-encodes the text drizzle already serialised for a jsonb column, so ' +
        "every jsonb write is stored as a jsonb string (jsonb_typeof = 'string'). Omit " +
        '`prepare` (it defaults to false on this driver) or pass false.',
    );
  }
  return new SQL(databaseUrl, { ...options, adapter: 'postgres', prepare: false });
}

/** What `drizzle-orm/bun-sql` exports, to the extent this package calls it. */
interface BunSqlDrizzleModule {
  drizzle(client: BunSqlClient, config?: Record<string, unknown>): unknown;
}

/**
 * Load `drizzle-orm/bun-sql` synchronously — Bun only.
 *
 * Kept to literal specifiers so a Bun bundler (`bun build --target=bun`) can
 * still see and include them; a Node bundler that follows them must mark
 * `bun` external. See this module's header for why this is a `require()` and
 * why it is never reached under Node.
 */
function loadBunSqlDrizzle(): BunSqlDrizzleModule {
  requireBunRuntime();
  return require('drizzle-orm/bun-sql') as BunSqlDrizzleModule;
}

/** `drizzle(client, config)` from `drizzle-orm/bun-sql`. */
export function bunSqlDrizzle(client: BunSqlClient, config: Record<string, unknown>): unknown {
  return loadBunSqlDrizzle().drizzle(client, config);
}

/**
 * Run a parameterless statement through either driver and return its rows.
 *
 * Both drivers answer `unsafe()` with an array of row objects (with result
 * metadata attached as extra properties); anything else is a driver this
 * package does not understand, refused here rather than read as "no rows".
 */
export async function queryRows<TRow extends Record<string, unknown>>(
  client: RawSqlClient,
  query: string,
): Promise<TRow[]> {
  const result = await client.unsafe(query);
  if (!Array.isArray(result)) {
    throw new Error(
      `@oxy.so/db: the SQL client returned ${typeof result} rather than a row array for: ${query}`,
    );
  }
  return result as TRow[];
}

/** Run one parameterless statement through either driver, discarding its result. */
export async function executeStatement(client: RawSqlClient, statement: string): Promise<void> {
  await client.unsafe(statement);
}

/**
 * A short-lived, single-connection client this package opens and closes
 * itself — a migration run, an extension check, a throwaway database's admin
 * connection. Exactly one of `postgres` / `bunSql` is set, matching `driver`,
 * for the one caller (the migrator) that must hand the typed client to drizzle.
 */
export type OwnedConnection =
  | {
      readonly driver: 'postgres-js';
      readonly client: postgres.Sql;
      close(timeoutSeconds: number): Promise<void>;
    }
  | {
      readonly driver: 'bun-sql';
      readonly client: BunSqlClient;
      close(timeoutSeconds: number): Promise<void>;
    };

/**
 * The two drizzle calls the migrator applies a migration with. Both drivers'
 * drizzle databases have them, and both are public API (`execute` and
 * `transaction` on `PgDatabase`).
 */
export interface MigrationDatabase {
  execute(query: SQL): PromiseLike<unknown>;
  transaction<T>(
    run: (tx: { execute(query: SQL): PromiseLike<unknown> }) => Promise<T>,
  ): Promise<T>;
}

/** A drizzle database over an owned connection, for {@link MigrationDatabase}'s two calls. */
export function migrationDatabase(connection: OwnedConnection): MigrationDatabase {
  if (connection.driver === 'bun-sql') {
    return loadBunSqlDrizzle().drizzle(connection.client) as MigrationDatabase;
  }
  return drizzlePostgres(connection.client);
}

/**
 * Open a one-connection client on `databaseUrl` through `driver`.
 *
 * The postgres.js branch is the call this package always made
 * (`postgres(url, { max: 1 })`, plus `onnotice` and `connection` when the
 * caller passes them).
 * `Bun.SQL` has no notice hook, so a bun-sql run does not log server NOTICEs.
 */
export function openOwnedConnection(
  databaseUrl: string,
  driver: DatabaseDriver,
  onnotice?: (message: string) => void,
  /**
   * Server runtime parameters sent in the startup packet (`lock_timeout`,
   * `statement_timeout`, ...), so they hold for the connection's whole life,
   * a transparent reconnect included. Omitted, the call is unchanged.
   */
  runtimeParameters?: Readonly<Record<string, string>>,
): OwnedConnection {
  const connection = runtimeParameters ? { connection: { ...runtimeParameters } } : {};
  if (driver === 'bun-sql') {
    const client = openBunSqlClient(databaseUrl, { max: 1, ...connection });
    return { driver, client, close: (timeout) => client.close({ timeout }) };
  }
  const client = onnotice
    ? postgres(databaseUrl, {
        max: 1,
        ...connection,
        onnotice: (notice) => onnotice(notice.message),
      })
    : postgres(databaseUrl, { max: 1, ...connection });
  return { driver, client, close: (timeout) => client.end({ timeout }) };
}

/**
 * Double-quote a Postgres identifier for a statement built from this
 * package's own constants (schema and table names, extension names, throwaway
 * database names) — `unsafe()` takes no identifier helper.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quote a Postgres string literal built from this package's own constants. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
