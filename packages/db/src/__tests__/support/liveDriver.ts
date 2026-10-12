/**
 * Which driver the live suites run on, and the clients they open through it.
 *
 * `OXYDB_TEST_DRIVER` selects it: unset (or `postgres-js`) is the default
 * driver and the only one Node can run; `bun-sql` is Bun's built-in client and
 * needs the suite to run under `bun test` (`bun run test:bun-sql`). Anything
 * else is refused rather than silently read as the default — a typo must not
 * turn a bun-sql run into a second postgres.js run that reports green.
 *
 * Every live suite opens its ad-hoc clients through here, and passes
 * {@link TEST_DRIVER} to `runMigrations` / `createTestDatabase` /
 * `dropTestDatabase`, so one suite proves the same claims on either driver.
 */

import { createDatabase, type SqlExecutor } from '../../database';
import {
  DATABASE_DRIVERS,
  type DatabaseDriver,
  type RawSqlClient,
  executeStatement,
  openOwnedConnection,
  queryRows,
} from '../../driver';

function resolveTestDriver(): DatabaseDriver {
  const raw = process.env.OXYDB_TEST_DRIVER;
  if (raw === undefined || raw === '') return 'postgres-js';
  const driver = DATABASE_DRIVERS.find((candidate) => candidate === raw);
  if (driver === undefined) {
    throw new Error(
      `OXYDB_TEST_DRIVER=${JSON.stringify(raw)} is not a driver: expected one of ${DATABASE_DRIVERS.join(', ')}.`,
    );
  }
  return driver;
}

export const TEST_DRIVER: DatabaseDriver = resolveTestDriver();

/** Whether this process can open a `bun-sql` connection at all. */
export const IS_BUN = typeof Reflect.get(globalThis, 'Bun') === 'object';

/** A one-connection client on the test driver, with the two calls the suites need. */
export interface LiveClient {
  readonly client: RawSqlClient;
  query<TRow extends Record<string, unknown>>(statement: string): Promise<TRow[]>;
  exec(statement: string): Promise<void>;
  close(): Promise<void>;
}

export function openLiveClient(
  databaseUrl: string,
  driver: DatabaseDriver = TEST_DRIVER,
): LiveClient {
  const connection = openOwnedConnection(databaseUrl, driver);
  return {
    client: connection.client,
    query: (statement) => queryRows(connection.client, statement),
    exec: (statement) => executeStatement(connection.client, statement),
    close: () => connection.close(5),
  };
}

/**
 * A schema-less drizzle handle on the test driver, built through
 * `createDatabase` itself — so every live suite that reads through a drizzle
 * handle also exercises the driver branch `createDatabase` takes.
 */
export function openLiveDatabase(
  databaseUrl: string,
  driver: DatabaseDriver = TEST_DRIVER,
): { db: SqlExecutor; close(): Promise<void> } {
  if (driver === 'bun-sql') {
    const { db, client } = createDatabase({
      databaseUrl,
      schema: {},
      driver: 'bun-sql',
      client: { max: 1 },
    });
    return { db, close: () => client.close({ timeout: 5 }) };
  }
  const { db, client } = createDatabase({ databaseUrl, schema: {}, client: { max: 1 } });
  return { db, close: () => client.end({ timeout: 5 }) };
}
