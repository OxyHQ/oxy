import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import type { BunSQLQueryResultHKT } from 'drizzle-orm/bun-sql/session';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { type SqlExecutor, createDatabase } from './database';
import type {
  BunSqlClient,
  OxyBunSqlDatabase,
  OxyBunSqlQueryResultHKT,
  RawSqlClient,
} from './driver';

/**
 * Compile-time-only regression check: NOT excluded from `tsconfig.json`
 * (unlike `__tests__`, which it does exclude), but excluded from every BUILD
 * tsconfig (`tsconfig.cjs.json`/`tsconfig.esm.json`/`tsconfig.types.json`, via
 * their own `**\/*.typetest.ts` exclude entry) — so it is checked by `bun run
 * --filter @oxy.so/db typescript` but never emitted into `dist/`.
 *
 * `jest.config.js` now type-checks `__tests__` too (Task 4b overrides
 * `isolatedModules: false` for ts-jest's own resolved compiler options, since
 * `ts-jest/dist/legacy/config/config-set.js` reads
 * `this.parsedTsConfig.options.isolatedModules` — this package's
 * `tsconfig.json` `compilerOptions.isolatedModules: true` — to decide whether
 * to build a full LanguageService at all; with it left on, ts-jest fell back
 * to per-file `transpileModule` with zero diagnostics, for every file it
 * transformed). So a type-only assertion under `__tests__` would no longer
 * silently no-op. This check stays here regardless, because it needs no live
 * database or constructed transaction handle to run at all — `TransactionHandle`
 * is extracted purely at the type level from `PostgresJsDatabase['transaction']`'s
 * callback parameter, and the function below is never called; its body is the
 * whole check. `tsc` itself was never affected by `isolatedModules` in the way
 * ts-jest is — it is a real project-wide type-check either way — and
 * `tsconfig.json`'s `isolatedModules: true` remains a separate, deliberately-kept
 * guard for the `tsc` build configs against code that would not survive a
 * per-file transpiler downstream, unrelated to whether tests get type-checked.
 *
 * `.transaction()` is never actually invoked here, which is what a real
 * transaction would require.
 */
type TransactionCallback = Parameters<
  PostgresJsDatabase<Record<string, unknown>>['transaction']
>[0];
type TransactionHandle = Parameters<TransactionCallback>[0];

function realHandlesSatisfySqlExecutor(
  db: PostgresJsDatabase<Record<string, unknown>>,
  tx: TransactionHandle,
): void {
  // A real pool handle must satisfy SqlExecutor.
  const poolExecutor: SqlExecutor = db;
  void poolExecutor;

  // The handle a real transaction callback receives must satisfy SqlExecutor
  // too — this is the property that lets a sweep or a gate run inside a
  // caller's transaction (see `database.ts`'s `SqlExecutor` doc comment).
  const txExecutor: SqlExecutor = tx;
  void txExecutor;
}
void realHandlesSatisfySqlExecutor;

/**
 * The bun-sql half, held to the same standard and to drizzle's own types.
 *
 * `OxyBunSqlQueryResultHKT` restates drizzle's `BunSQLQueryResultHKT` so this
 * package's declarations never import `drizzle-orm/bun-sql` (whose own
 * declarations import `bun`, which a Node consumer has no types for). The
 * restatement is only safe while the two stay interchangeable, so both
 * directions are asserted against drizzle's real class — a drizzle bump that
 * changes the result kind fails `bun run typescript` here instead of handing
 * a consumer a handle whose `execute()` is typed wrongly.
 */
type BunTransactionHandle = Parameters<
  Parameters<OxyBunSqlDatabase<Record<string, unknown>>['transaction']>[0]
>[0];

function bunSqlHandlesSatisfySqlExecutor(
  db: OxyBunSqlDatabase<Record<string, unknown>>,
  tx: BunTransactionHandle,
  drizzleOwn: BunSQLDatabase<Record<string, unknown>>,
  restated: PgDatabase<OxyBunSqlQueryResultHKT, Record<string, unknown>>,
): void {
  const poolExecutor: SqlExecutor = db;
  void poolExecutor;
  const txExecutor: SqlExecutor = tx;
  void txExecutor;

  const fromDrizzle: PgDatabase<OxyBunSqlQueryResultHKT, Record<string, unknown>> = drizzleOwn;
  void fromDrizzle;
  const toDrizzle: PgDatabase<BunSQLQueryResultHKT, Record<string, unknown>> = restated;
  void toDrizzle;
}
void bunSqlHandlesSatisfySqlExecutor;

/**
 * Both drivers' clients satisfy `RawSqlClient`, which is what lets every
 * `migrate/` reader take either one; and `createDatabase` picks its return
 * type from `driver`, so a bun-sql caller never sees a postgres.js type.
 */
function clientsSatisfyRawSqlClient(pg: postgres.Sql, bun: BunSqlClient): void {
  const fromPostgres: RawSqlClient = pg;
  void fromPostgres;
  const fromBun: RawSqlClient = bun;
  void fromBun;

  const schema = {};
  const pgHandle = createDatabase({ databaseUrl: '', schema });
  const pgClient: postgres.Sql = pgHandle.client;
  void pgClient;
  const bunHandle = createDatabase({ databaseUrl: '', schema, driver: 'bun-sql' });
  const bunDb: OxyBunSqlDatabase<typeof schema> = bunHandle.db;
  const bunClient: BunSqlClient = bunHandle.client;
  void bunDb;
  void bunClient;
  // @ts-expect-error — a bun-sql handle's client is not a postgres.js client.
  const notPostgres: postgres.Sql = bunHandle.client;
  void notPostgres;
  // @ts-expect-error — postgres.js options are refused on the bun-sql overload.
  createDatabase({ databaseUrl: '', schema, driver: 'bun-sql', client: { idle_timeout: 5 } });
}
void clientsSatisfyRawSqlClient;
