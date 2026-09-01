/**
 * Throwaway Test Database
 *
 * Creates a uniquely-named database on the server `TEST_DATABASE_URL` (falling
 * back to `DATABASE_URL`) points at, applies every migration in `drizzle/`, and
 * publishes its URL as `DATABASE_URL` so the suite's own `connectPostgres()`
 * opens against it — a test therefore exercises the same pool, casing and
 * schema wiring `config/postgres.ts` uses in production, not a parallel copy.
 *
 * Migrations are applied by shelling out to `bun run db:migrate`
 * (`src/db/migrate.ts`), the single migration mechanism in this package. There
 * is no second migrator: what a developer runs, what CI runs, what the test
 * harness runs, and what the production one-shot ECS task runs are all the same
 * code — the compiled form of that file, over the same `drizzle/` files.
 *
 * `DATABASE_URL` is the ONLY channel between create and drop — jest's global
 * setup and teardown share a process, and an env var the harness already has to
 * publish beats a second `globalThis` slot that could drift out of sync with it.
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import postgres from 'postgres';
import { ConfigurationError } from '../config/env';

/** Bytes of randomness in a throwaway database name. */
const NAME_ENTROPY_BYTES = 8;
/**
 * Every throwaway database matches this, and `dropTestDatabase` refuses
 * anything that does not — so a misconfigured `DATABASE_URL` can never make
 * teardown drop a real database.
 */
const TEST_DATABASE_NAME = /^oxy_test_[0-9a-f]{16}$/;
/** Seconds an admin connection waits before giving up on close. */
const ADMIN_CLOSE_TIMEOUT_SECONDS = 5;
/** Milliseconds `bun run db:migrate` may take before the run is abandoned. */
const MIGRATE_TIMEOUT_MS = 60_000;

/**
 * `packages/api` — the working directory `bun run db:migrate` must run from, one
 * level above both `src/db/` (ts-jest reading source) and `dist/db/` (the tsc
 * build), so the same relative path is correct either way.
 */
const PACKAGE_ROOT = join(__dirname, '..', '..');

/**
 * Run `bun run db:migrate` against `databaseUrl`.
 *
 * @throws {Error} Carrying the migrator's own output when it fails — a silent
 *   migration failure would leave every test querying an empty database and
 *   failing for the wrong reason.
 */
function runMigrations(databaseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', 'db:migrate'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MIGRATE_TIMEOUT_MS,
    });

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });

    child.on('error', (error) => {
      reject(new Error(`Failed to run \`bun run db:migrate\`: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`\`bun run db:migrate\` exited with code ${code}:\n${output}`));
    });
  });
}

/**
 * `CREATE`/`DROP DATABASE` cannot run from inside the database they target, so
 * both go through the always-present `postgres` maintenance database.
 */
function maintenanceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

export type CreateTestDatabaseOptions = {
  /**
   * When true (default), sets `process.env.DATABASE_URL` to the new database.
   * Global setup passes `false` while provisioning one database per worker.
   */
  assignEnv?: boolean;
};

/**
 * Create a migrated throwaway database and, by default, point `DATABASE_URL` at it.
 *
 * @returns The throwaway database's connection string.
 * @throws {ConfigurationError} When neither `TEST_DATABASE_URL` nor
 *   `DATABASE_URL` is set — there is no server to create the database on.
 */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {}
): Promise<string> {
  const { assignEnv = true } = options;
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new ConfigurationError(
      'TEST_DATABASE_URL (or DATABASE_URL) must point at a Postgres server so ' +
      'a throwaway test database can be created on it. Start one with: ' +
      'docker compose -f docker-compose.dev.yml up -d postgres'
    );
  }

  // Built from a fixed prefix plus hex, so the name contains only `[a-z0-9_]`
  // and needs no escaping beyond the quoting below — CREATE/DROP DATABASE
  // cannot take a bound parameter.
  const name = `oxy_test_${randomBytes(NAME_ENTROPY_BYTES).toString('hex')}`;

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${name}`;
  const url = testUrl.toString();

  const create = postgres(maintenanceUrl(baseUrl), { max: 1 });
  try {
    await create.unsafe(`create database "${name}"`);
  } finally {
    await create.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
  }

  try {
    await runMigrations(url);
  } catch (error) {
    // An unmigrated database left behind would be dropped by nothing, so remove
    // it before surfacing the failure.
    await dropTestDatabase(url);
    throw error;
  }

  if (assignEnv) {
    process.env.DATABASE_URL = url;
  }
  return url;
}

/**
 * Create `count` independent throwaway databases, each fully migrated.
 * Used by Jest global setup to provision one database per worker.
 */
export async function createTestDatabases(count: number): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    urls.push(await createTestDatabase({ assignEnv: false }));
  }
  return urls;
}

/**
 * Drop a database created by `createTestDatabase`.
 *
 * `WITH (FORCE)` (Postgres 13+) terminates any connection a suite left behind,
 * so a leaked handle cannot turn teardown into a hang.
 *
 * @throws {ConfigurationError} If `databaseUrl` does not name a throwaway
 *   database. Teardown reads its target from the environment, so this guard is
 *   what stops a stray `DATABASE_URL` from dropping a real database.
 */
export async function dropTestDatabase(databaseUrl: string): Promise<void> {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new ConfigurationError(
      `Refusing to drop "${name}": only throwaway databases created by ` +
      'createTestDatabase (oxy_test_<16 hex>) may be dropped.'
    );
  }

  const remove = postgres(maintenanceUrl(databaseUrl), { max: 1 });
  try {
    await remove.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await remove.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
  }
}
