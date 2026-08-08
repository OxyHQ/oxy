import { createDatabase, type OxyDatabase } from '@oxyhq/db';
import type postgres from 'postgres';
import { logger } from '../utils/logger';
import * as schema from './schema';

/**
 * PostgreSQL connection for {{APP_NAME}}.
 *
 * Drizzle ORM over postgres.js, built through `@oxyhq/db`'s `createDatabase` so
 * the handle is constructed with `DATABASE_CASING` — the one setting that decides
 * what queries REFERENCE, and which `drizzle.config.ts` reads again to decide
 * what the DDL CREATES. Both sides read the same exported constant, so they
 * cannot drift into referencing columns the migrations never created.
 *
 * postgres.js and not `drizzle-orm/bun-sql`: the deployed image runs the compiled
 * CommonJS output, and `bun-sql` reaches for the `Bun` global and hard-fails the
 * moment anything loads it outside Bun.
 *
 * Connect once at boot (`server.ts`), then read the handle synchronously from
 * anywhere via `getDb()`.
 */

/** Seconds `closePostgres` waits for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

export type Database = OxyDatabase<typeof schema>;

/**
 * An open transaction — the handle `db.transaction(async (tx) => …)` passes its
 * callback. DERIVED from `Database` rather than written out, so it cannot drift
 * from the schema or from drizzle's generics when either changes.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Either handle. A helper that must be able to JOIN a caller's transaction takes
 * this: a `Transaction` is not assignable to `Database` (it has no `$client`), so
 * a helper typed only as `Database` silently forces its caller to run OUTSIDE the
 * transaction — which is how a guarded write loses atomicity with the work it is
 * supposed to be atomic WITH.
 */
export type DatabaseOrTransaction = Database | Transaction;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

let db: Database | null = null;
let client: postgres.Sql | null = null;

/**
 * Open the connection pool. Call once during startup, before serving traffic.
 * Idempotent: a second call returns the existing handle rather than opening a
 * second pool.
 *
 * @throws {Error} When `DATABASE_URL` is unset, or when the database cannot be
 *   reached — both are startup misconfigurations; fail fast and loudly.
 */
export async function connectPostgres(): Promise<Database> {
  if (db) return db;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with: ' +
        'docker compose -f docker-compose.postgres.yml up -d postgres',
    );
  }

  const instance = createDatabase({
    databaseUrl,
    schema,
    client: {
      max: intEnv('PG_MAX_POOL_SIZE', 20),
      idle_timeout: intEnv('PG_IDLE_TIMEOUT_SECONDS', 30),
      connect_timeout: intEnv('PG_CONNECT_TIMEOUT_SECONDS', 10),
      // Bounded so a pool behind a load balancer or a failover cannot pin itself
      // to a retired endpoint indefinitely.
      max_lifetime: intEnv('PG_MAX_LIFETIME_SECONDS', 1800),
      onnotice: (notice) => logger.info(`Postgres notice: ${notice.message}`),
    },
  });

  // postgres.js connects lazily, so constructing the pool proves nothing. Issue a
  // real round trip here so an unreachable or misconfigured database fails during
  // startup instead of on the first user request — and only publish the handle
  // once that round trip has succeeded.
  try {
    await instance.client`select 1`;
  } catch (error) {
    await instance.client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    throw error;
  }

  client = instance.client;
  db = instance.db;

  logger.info('Connected to PostgreSQL');
  return db;
}

/**
 * The connection opened by `connectPostgres()`. Everything that serves a request
 * goes through here.
 *
 * The raw postgres.js handle underneath is reachable as `getDb().$client`, for
 * the protocol-level operations drizzle does not wrap (`COPY`, `ANALYZE`).
 * Reaching for it to run ordinary SQL bypasses the schema types AND the casing
 * configuration that keep queries and migrations agreeing on column names.
 *
 * @throws {Error} If called before `connectPostgres()` resolved — a programming
 *   error (a query issued before startup finished), not a runtime condition.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error(
      'PostgreSQL is not connected. Call connectPostgres() during startup before issuing queries.',
    );
  }
  return db;
}

/**
 * Whether the database answers a trivial query right now — what `/ready` reports.
 *
 * A real round trip, deliberately, and not a `db !== null` flag: a pool can exist
 * while the server behind it is unreachable, so the cheap synchronous answer is
 * the one that reports ready during an outage.
 *
 * Never throws: an unreachable database is a readiness RESULT, not an error for
 * the caller to handle.
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

/** Close the pool (for shutdown hooks). Safe to call when never connected. */
export async function closePostgres(): Promise<void> {
  const instanceClient = client;
  if (!instanceClient) return;
  client = null;
  db = null;
  await instanceClient.end({ timeout: CLOSE_TIMEOUT_SECONDS });
}
