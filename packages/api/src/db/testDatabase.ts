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
 *
 * A run that never reaches its teardown — killed by a signal, a closed
 * terminal, a tool's timeout — drops nothing, and each such run used to leave
 * a fully migrated database behind for good. Every database is therefore
 * labelled, and owned through a session-level advisory lock its process holds
 * until it drops it; {@link reapOrphanedTestDatabases} drops the labelled ones
 * whose lock is free.
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { openPostgresClient } from '@oxy.so/db';
import type postgres from 'postgres';
import { ConfigurationError } from '../config/env';

/** Bytes of randomness in a throwaway database name. */
const NAME_ENTROPY_BYTES = 8;
/**
 * Every throwaway database matches this, and `dropTestDatabase` refuses
 * anything that does not — so a misconfigured `DATABASE_URL` can never make
 * teardown drop a real database.
 */
const TEST_DATABASE_NAME = /^oxy_test_[0-9a-f]{16}$/;
/**
 * How the `COMMENT` on a throwaway database begins; the host and pid of the
 * process that made it follow, for a person reading `\l+`. A database without
 * it — made before the label existed, or by hand — is never reaped. Whether
 * its owner is alive is decided by its ownership lock, never by the label.
 */
const OWNER_LABEL = 'oxy-jest owner=';
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
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

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
  /** Test-only provisioning on a newly created empty database, never an existing URL. */
  billingSandboxNamespace?: 'test:test' | 'test:staging' | 'test:development';
};

/**
 * Create a migrated throwaway database and, by default, point `DATABASE_URL` at it.
 *
 * @returns The throwaway database's connection string.
 * @throws {ConfigurationError} When neither `TEST_DATABASE_URL` nor
 *   `DATABASE_URL` is set — there is no server to create the database on.
 */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<string> {
  const { assignEnv = true } = options;
  if (
    options.billingSandboxNamespace &&
    (process.env.NODE_ENV !== 'test' ||
      !['test:test', 'test:staging', 'test:development'].includes(options.billingSandboxNamespace))
  )
    throw new ConfigurationError('Invalid test-only billing database declaration');
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new ConfigurationError(
      'TEST_DATABASE_URL (or DATABASE_URL) must point at a Postgres server so ' +
        'a throwaway test database can be created on it. Start one with: ' +
        'docker compose -f docker-compose.dev.yml up -d postgres',
    );
  }

  // Built from a fixed prefix plus hex, so the name contains only `[a-z0-9_]`
  // and needs no escaping beyond the quoting below — CREATE/DROP DATABASE
  // cannot take a bound parameter.
  const name = `oxy_test_${randomBytes(NAME_ENTROPY_BYTES).toString('hex')}`;

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${name}`;
  const url = testUrl.toString();

  // Owned BEFORE it exists, so no reaper ever sees it labelled and unowned.
  await holdOwnership(baseUrl, name);
  const create = openPostgresClient(maintenanceUrl(baseUrl), { client: { max: 1 } });
  let created = false;
  try {
    // template1 can include extensions or application tables on a developer's
    // server. Start pristine so sandbox provenance is checked before migrations.
    await create.unsafe(`create database "${name}" template template0`);
    created = true;
    const owner = `${OWNER_LABEL}${hostname()}/${process.pid}`.replace(/'/g, "''");
    await create.unsafe(`comment on database "${name}" is '${owner}'`);
    if (options.billingSandboxNamespace) {
      const fresh = openPostgresClient(url, { client: { max: 1 } });
      try {
        const rows =
          await fresh`select current_database() as name, (select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public') as tables`;
        if (rows[0].name !== name || rows[0].tables !== 0)
          throw new ConfigurationError('Billing sandbox must be a new empty test database');
        await create.unsafe(
          `alter database "${name}" set oxy.billing_namespace = '${options.billingSandboxNamespace}'`,
        );
      } finally {
        await fresh.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
      }
    }
  } catch (error) {
    if (created) await dropTestDatabase(url);
    else await releaseOwnership(name);
    throw error;
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
  try {
    for (let i = 0; i < count; i++) {
      urls.push(await createTestDatabase({ assignEnv: false }));
    }
  } catch (error) {
    // Jest runs no teardown after a failed global setup.
    await Promise.allSettled(urls.map((url) => dropTestDatabase(url)));
    throw error;
  }
  return urls;
}

/**
 * The open sessions that own this process's throwaway databases, by name.
 * On `globalThis` because Jest's global setup and global teardown share a
 * process but not necessarily a module instance.
 */
const ownerRegistry = globalThis as { __oxyTestDatabaseOwners?: Map<string, postgres.Sql> };
ownerRegistry.__oxyTestDatabaseOwners ??= new Map();
const ownerSessions = ownerRegistry.__oxyTestDatabaseOwners;

/** The advisory-lock key that says a database's owner is alive (hashed server-side). */
function ownershipKey(name: string): string {
  return `oxy-jest:${name}`;
}

/**
 * Take ownership of `name` for this process's lifetime: a session-level
 * advisory lock, held on a connection of its own until the database is
 * dropped. Postgres releases it the moment that session ends — the process
 * exited, was killed, or lost the server — which is what
 * {@link reapOrphanedTestDatabases} asks. A pid cannot answer that: hostnames
 * repeat across PID namespaces (a container on the host network, every WSL2
 * distro), so a pid that is dead here can be a live run there.
 */
async function holdOwnership(baseUrl: string, name: string): Promise<void> {
  const session = openPostgresClient(maintenanceUrl(baseUrl), {
    client: {
      max: 1,
      // Never recycled: a new connection would not hold the lock.
      max_lifetime: 0,
      idle_timeout: 0,
      connection: { application_name: `oxy-jest owner ${name}` },
    },
  });
  try {
    await session`select pg_advisory_lock(hashtextextended(${ownershipKey(name)}, 0))`;
  } catch (error) {
    await session.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
    throw error;
  }
  ownerSessions.set(name, session);
}

async function releaseOwnership(name: string): Promise<void> {
  const session = ownerSessions.get(name);
  if (!session) return;
  ownerSessions.delete(name);
  await session.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
}

/**
 * Drop every throwaway database whose owner is gone — what a run killed
 * outright left behind. Run before a suite creates its own, so a killed run
 * costs one database until the next run rather than one database forever.
 *
 * Liveness is Postgres's answer, not this host's: a database is reaped only
 * when it carries {@link createTestDatabase}'s label AND its ownership lock is
 * free, so a run in progress anywhere keeps its databases, and an unlabelled
 * one is left for a person to decide.
 *
 * @returns The names it dropped.
 */
export async function reapOrphanedTestDatabases(): Promise<string[]> {
  const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!baseUrl) return [];
  const admin = openPostgresClient(maintenanceUrl(baseUrl), { client: { max: 1 } });
  try {
    const rows = await admin<{ name: string; label: string | null }[]>`
      select datname as name, shobj_description(oid, 'pg_database') as label
      from pg_database where datname like 'oxy_test_%'`;
    const reaped: string[] = [];
    for (const { name, label } of rows) {
      if (!TEST_DATABASE_NAME.test(name) || !label?.startsWith(OWNER_LABEL)) continue;
      const key = ownershipKey(name);
      const [{ free }] = await admin<{ free: boolean }[]>`
        select pg_try_advisory_lock(hashtextextended(${key}, 0)) as free`;
      if (!free) continue;
      try {
        await admin.unsafe(`drop database if exists "${name}" with (force)`);
        reaped.push(name);
      } finally {
        await admin`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
      }
    }
    return reaped;
  } finally {
    await admin.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
  }
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
      `Refusing to drop "${name}": only throwaway databases created by createTestDatabase (oxy_test_<16 hex>) may be dropped.`,
    );
  }

  const remove = openPostgresClient(maintenanceUrl(databaseUrl), { client: { max: 1 } });
  try {
    await remove.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await remove.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
    await releaseOwnership(name);
  }
}
