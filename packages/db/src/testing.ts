/**
 * Throwaway Test Database
 *
 * Creates a uniquely-named database on the Postgres server `options.adminUrl`
 * points at, optionally applies a caller-supplied schema to it via
 * `options.migrate`, and returns its connection string — so a suite can run
 * against a real schema instead of a fake one. `dropTestDatabase` removes it
 * again.
 *
 * `migrate` is a callback, not a built-in migration mechanism. The original
 * version of this harness (the caller-side code this module was ported from)
 * shelled out to that application's own `bun run db:migrate`, because at the
 * time nothing applied migrations generically. `@oxyhq/db/migrate`'s
 * `runMigrations` now does exactly that, driven entirely by caller-supplied
 * options (its own migrations folder, its own extensions, its own deploy
 * phase) — so a caller passes `(url) => runMigrations({ databaseUrl: url, ... })`
 * (or its own spawn, if it still needs one) rather than this module
 * re-implementing a second migration mechanism that would have to guess a
 * caller's script name and environment variable, which is exactly the kind of
 * consumer-specific assumption this package exists to avoid baking in.
 *
 * There is likewise no default for `adminUrl` read from the environment:
 * which variable (if any) a caller resolves this from is that caller's own
 * naming, not something a shared package can assume — omitting it fails
 * loudly rather than inventing a server to connect to.
 */

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';

/** Bytes of randomness in a throwaway database name. */
const NAME_ENTROPY_BYTES = 8;

/**
 * Every throwaway database created by {@link createTestDatabase} matches
 * this, and {@link dropTestDatabase} refuses anything that does not — so a
 * connection string pointed at the wrong database can never make teardown
 * drop a real one.
 */
const TEST_DATABASE_NAME = /^oxydb_test_[0-9a-f]{16}$/;

/** Seconds an admin connection waits before giving up on close. */
const ADMIN_CLOSE_TIMEOUT_SECONDS = 5;

export interface CreateTestDatabaseOptions {
  /**
   * Connection string for a Postgres server this can create and drop
   * databases on, reached through its always-present `postgres` maintenance
   * database.
   *
   * No default. Omitting it (or passing an empty string) throws immediately,
   * rather than falling back to a guessed local server that would silently
   * create a throwaway database somewhere the caller did not intend.
   */
  readonly adminUrl?: string;

  /**
   * Applies the caller's own schema to the throwaway database once it
   * exists, before {@link createTestDatabase} returns. Receives the
   * throwaway database's OWN connection string — never `adminUrl`: `CREATE
   * DATABASE` has already run by the time this is called, so the hook
   * connects to the real target, not the maintenance database. Typically a
   * closure over `runMigrations` from `@oxyhq/db/migrate`, or a caller's own
   * migration entrypoint.
   *
   * Omitted, the throwaway database is returned empty — a caller may still
   * apply its own schema afterward, the same way it would against any other
   * freshly created database.
   *
   * A hook that throws does not leak the database it was given: the
   * throwaway database is dropped before the rejection propagates, so a
   * broken migration cannot turn one failed test run into a Postgres server
   * full of abandoned throwaway databases.
   */
  readonly migrate?: (databaseUrl: string) => Promise<void>;
}

/**
 * `CREATE`/`DROP DATABASE` cannot run from inside the database they target,
 * so both go through the always-present `postgres` maintenance database.
 */
function maintenanceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * Create a throwaway database — empty, unless `options.migrate` applies a
 * schema to it — and return its connection string.
 *
 * @returns The throwaway database's own connection string, on the same
 *   server as `options.adminUrl`.
 * @throws {Error} When `options.adminUrl` is missing or empty — there is no
 *   server to create the database on, and this never invents one.
 * @throws Whatever `options.migrate` throws, after dropping the database it
 *   was given — a failed migration never leaves a throwaway database behind.
 */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {}
): Promise<string> {
  const baseUrl = options.adminUrl;
  if (!baseUrl) {
    throw new Error(
      'createTestDatabase requires options.adminUrl: a Postgres connection ' +
        'string for a server it can create and drop databases on. There is ' +
        'no default — pass the URL your own application already resolves ' +
        'this from, however it names that environment variable.'
    );
  }

  // Built from a fixed prefix plus hex, so the name contains only
  // `[a-z0-9_]` and needs no escaping beyond the quoting below — CREATE/DROP
  // DATABASE cannot take a bound parameter.
  const name = `oxydb_test_${randomBytes(NAME_ENTROPY_BYTES).toString('hex')}`;

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${name}`;
  const url = testUrl.toString();

  const create = postgres(maintenanceUrl(baseUrl), { max: 1 });
  try {
    await create.unsafe(`create database "${name}"`);
  } finally {
    await create.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
  }

  if (options.migrate) {
    try {
      await options.migrate(url);
    } catch (migrateError) {
      // A hook that fails midway must not leave the throwaway database
      // behind — see this option's own doc comment for why an abandoned one
      // is not merely harmless clutter. But this drop can ALSO fail, and a
      // bare `throw migrateError` below would never be reached in that case —
      // the drop's own rejection would propagate instead, discarding the
      // migration failure entirely and reporting only "could not drop the
      // database" for a problem that was really "your migration is broken".
      // An `AggregateError` keeps both failures, names the migration failure
      // in its own message text (not just buried in a `.cause` a logger may
      // never print), and still throws the original `migrateError` unchanged
      // in the common case where the drop succeeds.
      try {
        await dropTestDatabase(url);
      } catch (dropError) {
        const migrateMessage =
          migrateError instanceof Error ? migrateError.message : String(migrateError);
        const dropMessage = dropError instanceof Error ? dropError.message : String(dropError);
        throw new AggregateError(
          [migrateError, dropError],
          `options.migrate failed (${migrateMessage}), and the throwaway \
database could not be dropped afterward either (${dropMessage}) — it may \
still exist and need manual cleanup.`
        );
      }
      throw migrateError;
    }
  }

  return url;
}

/**
 * Drop a database created by {@link createTestDatabase}.
 *
 * `WITH (FORCE)` (Postgres 13+) terminates any connection a suite left
 * behind, so a leaked handle cannot turn teardown into a hang.
 *
 * @throws {Error} If `databaseUrl` does not name a throwaway database created
 *   by {@link createTestDatabase}. Checked BEFORE opening any connection, so
 *   a stray connection string can never reach `DROP DATABASE` at all — the
 *   guard that stops teardown from dropping a real database.
 */
export async function dropTestDatabase(databaseUrl: string): Promise<void> {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new Error(
      `Refusing to drop "${name}": only throwaway databases created by \
createTestDatabase (oxydb_test_<16 hex>) may be dropped.`
    );
  }

  const remove = postgres(maintenanceUrl(databaseUrl), { max: 1 });
  try {
    await remove.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await remove.end({ timeout: ADMIN_CLOSE_TIMEOUT_SECONDS });
  }
}
