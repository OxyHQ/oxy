import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SqlExecutor } from './database';

/**
 * Compile-time-only regression check: NOT excluded from `tsconfig.json`
 * (unlike `__tests__`, which it does exclude), but excluded from every BUILD
 * tsconfig (`tsconfig.cjs.json`/`tsconfig.esm.json`/`tsconfig.types.json`, via
 * their own `**\/*.typetest.ts` exclude entry) — so it is checked by `bun run
 * --filter @oxyhq/db typescript` but never emitted into `dist/`.
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
type TransactionCallback = Parameters<PostgresJsDatabase<Record<string, unknown>>['transaction']>[0];
type TransactionHandle = Parameters<TransactionCallback>[0];

function realHandlesSatisfySqlExecutor(
  db: PostgresJsDatabase<Record<string, unknown>>,
  tx: TransactionHandle
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
