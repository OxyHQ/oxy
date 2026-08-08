/**
 * PostgreSQL connection for {{APP_NAME}}.
 *
 * Drizzle ORM over postgres.js, built through `@oxyhq/db`'s `createDatabase` so
 * the handle is constructed with `DATABASE_CASING` — the one setting that
 * decides what queries REFERENCE, and which `drizzle.config.ts` reads again to
 * decide what the DDL CREATES. Both sides read the same exported constant, so
 * they cannot drift into referencing columns the migrations never created.
 *
 * postgres.js and NOT `drizzle-orm/bun-sql`: the container image runs this
 * package's compiled CommonJS output, and `bun-sql` reaches for the `Bun`
 * global and hard-fails the moment anything loads it outside Bun.
 *
 * Connect once at boot (`connectPostgres()` in `server.ts`), then read the
 * handle synchronously from anywhere via `getDb()`.
 */

import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import { assertPostgresMigrationsCurrent, readJournal } from '@oxyhq/db/migrate';
import type postgres from 'postgres';
import { logger } from '../utils/logger';
import { MIGRATIONS_FOLDER } from './migrationsFolder';
import * as schema from './schema';

/** Seconds `closePostgres` waits for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

/** The migration journal this build ships. See {@link assertMigrationsCurrent}. */
const JOURNAL = readJournal(MIGRATIONS_FOLDER);

export type Database = OxyDatabase<typeof schema>;

/**
 * An open transaction on that pool — the handle `db.transaction(async (tx) => …)`
 * passes its callback.
 *
 * DERIVED from `Database` rather than written out, so it cannot drift from the
 * schema or from drizzle's generics when either changes.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Either handle. A write that must be able to JOIN a caller's transaction takes
 * this: a `Transaction` is not assignable to `Database` (it has no `$client`),
 * so a helper typed only as `Database` silently forces its caller to run OUTSIDE
 * the transaction — which is how a guarded write loses atomicity with the work
 * it is supposed to be atomic WITH.
 */
export type DatabaseOrTransaction = Database | Transaction;

let db: Database | null = null;
let client: postgres.Sql | null = null;

/** Reads a positive integer from the environment, falling back to `fallback`. */
function readPoolSetting(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Open the connection pool. Call once during startup, before serving traffic.
 *
 * Idempotent: a second call returns the existing handle rather than opening a
 * second pool.
 *
 * @throws {Error} When `DATABASE_URL` is unset, or when the server behind it
 *   does not answer. Both are startup failures — there is no second store to
 *   fall back to, so a task that cannot reach Postgres must not start.
 */
export async function connectPostgres(): Promise<Database> {
  if (db) return db;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with:\n' +
        '  docker compose -f docker-compose.postgres.yml up -d postgres\n' +
        'then copy packages/backend/.env.example to packages/backend/.env.',
    );
  }

  const maxPoolSize = readPoolSetting('DATABASE_POOL_MAX', 10);
  const instance = createDatabase({
    databaseUrl,
    schema,
    client: {
      max: maxPoolSize,
      idle_timeout: readPoolSetting('DATABASE_IDLE_TIMEOUT_SECONDS', 30),
      connect_timeout: readPoolSetting('DATABASE_CONNECT_TIMEOUT_SECONDS', 10),
      onnotice: (notice) => logger.info('Postgres notice', notice.message),
    },
  });

  // postgres.js connects lazily, so constructing the pool proves nothing. Issue
  // a real round trip here so an unreachable or misconfigured database fails
  // during startup instead of on the first user request — and only publish the
  // handle once that round trip has succeeded.
  try {
    await instance.client`select 1`;
  } catch (error) {
    await instance.client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    throw error;
  }

  client = instance.client;
  db = instance.db;

  logger.info(`Connected to PostgreSQL (pool max ${String(maxPoolSize)})`);
  return db;
}

/**
 * The connection opened by {@link connectPostgres}. Everything that serves a
 * request goes through here.
 *
 * The raw postgres.js handle underneath is reachable as `getDb().$client`.
 * Reaching for it to run ordinary SQL bypasses the schema types AND the casing
 * configuration that keep queries and migrations agreeing on column names, so
 * keep it for the protocol-level operations drizzle does not wrap (`COPY`,
 * `ANALYZE`) and nothing else.
 *
 * @throws {Error} If called before {@link connectPostgres} resolved — a
 *   programming error (a query issued before startup finished), not a runtime
 *   condition to recover from.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error(
      'PostgreSQL is not connected. Call connectPostgres() during startup ' +
        'before issuing queries.',
    );
  }
  return db;
}

/**
 * Whether the database answers a trivial query right now — half of `GET /ready`.
 *
 * A real round trip, deliberately, and not a `db !== null` flag: a pool can
 * exist while the server behind it is unreachable, so the cheap synchronous
 * answer is the one that reports healthy during an outage.
 *
 * Never throws: an unreachable database is a health-check RESULT, not an error
 * for the caller to handle.
 */
export async function checkPostgresHealth(): Promise<boolean> {
  const instanceClient = client;
  if (!instanceClient) return false;
  try {
    await instanceClient`select 1`;
    return true;
  } catch (error) {
    logger.error('Postgres health check failed', error);
    return false;
  }
}

/**
 * Whether this build's migrations have all been applied — the other half of
 * `GET /ready`.
 *
 * The failure this exists for lands after the point of no return: a deploy that
 * migrates in a one-shot task and then starts serving tasks. If the one-shot did
 * not run, or ran against the wrong database, the serving tasks still start,
 * still connect, and then fail every query against a schema that is not there.
 * A task that cannot serve correctly must not be able to say that it can.
 *
 * Lives HERE rather than in the route so the raw postgres.js handle stays inside
 * this module. The journal is read ONCE at module load: it is a set of files
 * shipped inside the build and cannot change while the process runs, so
 * re-reading it per probe would only add a way for readiness to fail on an
 * unrelated filesystem hiccup.
 *
 * @throws {Error} `MigrationsNotCurrentError` when the database is behind this
 *   build (its message names the missing tags), or a driver error when the
 *   ledger cannot be read at all.
 */
export async function assertMigrationsCurrent(): Promise<void> {
  const instanceClient = client;
  if (!instanceClient) {
    throw new Error(
      'PostgreSQL is not connected. Call connectPostgres() during startup ' +
        'before asserting the migration ledger.',
    );
  }
  await assertPostgresMigrationsCurrent(instanceClient, JOURNAL);
}

/** Close the pool (for shutdown hooks). Safe to call when never connected. */
export async function closePostgres(): Promise<void> {
  const instanceClient = client;
  if (!instanceClient) return;
  client = null;
  db = null;
  await instanceClient.end({ timeout: CLOSE_TIMEOUT_SECONDS });
}
