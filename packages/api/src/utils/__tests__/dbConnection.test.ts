/**
 * The database readiness gate — the startup wait and the `/health` probe,
 * against a REAL Postgres.
 *
 * ## Why this is load-bearing
 *
 * `GET /health` is the ALB target-group check. A 503 drains the task out of the
 * load balancer, so the probe's meaning must be exactly "the database is
 * unusable" — nothing wider, nothing narrower. The Mongo version read
 * `mongoose.connection.readyState === 1`, a DRIVER-SIDE FLAG, which is why it
 * could report a healthy database while the server was refusing work.
 *
 * The two functions below are therefore held apart deliberately, because the
 * distinction is the whole fix:
 *
 *  - {@link isDatabaseConnected} — SYNCHRONOUS, "is a pool open?". Not a
 *    liveness check, and used only where a background job must decide whether
 *    it may issue a query at all.
 *  - {@link isDatabaseReachable} — a real `select 1` round trip over the pool
 *    real requests use. This is what `/health` reports.
 *
 * A test that only proved "a pool object exists" would pass against the exact
 * bug this replaces, so every reachability assertion here is made against a
 * pool that has actually been closed or pointed somewhere unreachable.
 */

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { closePostgres, connectPostgres } from '../../config/postgres';
import {
  isDatabaseConnected,
  isDatabaseReachable,
  waitForDatabaseConnection,
} from '../dbConnection';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

/**
 * Only a database matching this may be dropped by the helper below — the same
 * guard `db/testDatabase.ts` carries, for the same reason: teardown reads its
 * target from the environment, and a stray `DATABASE_URL` must not be able to
 * drop a real database.
 */
const PROBE_DATABASE_NAME = /^oxy_probe_[0-9a-f]{16}$/;

/** `CREATE`/`DROP DATABASE` cannot run from inside the database they target. */
function maintenanceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * An EMPTY throwaway database, and its connection string.
 *
 * Deliberately unmigrated: the probe issues `select 1`, which needs no schema,
 * and skipping the migration run keeps this a fast test rather than a slow one.
 */
async function createProbeDatabase(): Promise<string> {
  const name = `oxy_probe_${randomBytes(8).toString('hex')}`;
  const url = new URL(ORIGINAL_DATABASE_URL ?? '');
  url.pathname = `/${name}`;

  const admin = postgres(maintenanceUrl(ORIGINAL_DATABASE_URL ?? ''), { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  return url.toString();
}

/**
 * Drop it, terminating whatever is still connected (`WITH (FORCE)`), which is
 * how a live pool is put into the "open, but the server can no longer answer"
 * state.
 */
async function dropProbeDatabase(databaseUrl: string): Promise<void> {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!PROBE_DATABASE_NAME.test(name)) {
    throw new Error(`Refusing to drop "${name}": not a probe database`);
  }
  const admin = postgres(maintenanceUrl(ORIGINAL_DATABASE_URL ?? ''), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

afterEach(async () => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  await closePostgres();
});

afterAll(async () => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  await closePostgres();
});

describe('isDatabaseConnected — pool presence, NOT liveness', () => {
  it('is false before a pool is opened and true after', async () => {
    await closePostgres();
    expect(isDatabaseConnected()).toBe(false);

    await connectPostgres();
    expect(isDatabaseConnected()).toBe(true);
  });

  it('is false again once the pool is closed', async () => {
    await connectPostgres();
    await closePostgres();

    expect(isDatabaseConnected()).toBe(false);
  });
});

describe('isDatabaseReachable — the /health probe', () => {
  it('answers true against a live database', async () => {
    await connectPostgres();

    expect(await isDatabaseReachable()).toBe(true);
  });

  it('answers false — never throws — when no pool is open', async () => {
    await closePostgres();

    // `/health` turns this into a 503. An exception here would instead reach
    // the handler's catch, which also answers 503 — so the distinction matters
    // for the OTHER callers, and for not logging an error on every poll of a
    // task that has not finished starting.
    await expect(isDatabaseReachable()).resolves.toBe(false);
  });

  it('refuses to publish a handle for a database that cannot answer', async () => {
    await closePostgres();
    const url = new URL(ORIGINAL_DATABASE_URL ?? '');
    url.pathname = '/oxy_does_not_exist';
    process.env.DATABASE_URL = url.toString();

    // `connectPostgres` round-trips before publishing, which is why startup
    // fails loudly instead of serving against a database that never came up.
    await expect(connectPostgres()).rejects.toThrow();
    expect(isDatabaseConnected()).toBe(false);
    await expect(isDatabaseReachable()).resolves.toBe(false);
  });

  it('answers FALSE while the pool is still open but the server stopped answering', async () => {
    // THE discriminating case, and the reason this file exists.
    //
    // Every other assertion here is also satisfied by a probe that merely
    // reports whether a pool object exists — because `connectPostgres`
    // round-trips, a pool never exists while the database is unreachable at
    // STARTUP. What a connection-object check cannot see is a database that
    // went away AFTER a healthy start: an RDS failover, a network partition, a
    // server refusing work. That is the production shape, and reporting
    // "connected" through it is what kept a drained-worthy task in the ALB
    // target group.
    //
    // Reproduced for real by dropping the database out from under a live pool.
    await closePostgres();
    const probeUrl = await createProbeDatabase();
    process.env.DATABASE_URL = probeUrl;

    await connectPostgres();
    expect(isDatabaseConnected()).toBe(true);
    expect(await isDatabaseReachable()).toBe(true);

    await dropProbeDatabase(probeUrl);

    // The pool handle is UNCHANGED — still published, still non-null — and the
    // probe must nonetheless answer false.
    expect(isDatabaseConnected()).toBe(true);
    expect(await isDatabaseReachable()).toBe(false);

    // 20s was not enough, and the reason is `dropProbeDatabase`, not the probe.
    // `DROP DATABASE` forces a checkpoint, so under a loaded parallel run — the
    // backfill suites COPY hundreds of thousands of rows concurrently — it waits
    // for one. Measured against this same server: 45ms idle, and 43,185ms /
    // 21,374ms / 4,051ms on consecutive attempts while those suites ran. The
    // budget is what this test spends WAITING for a housekeeping operation, and
    // it was tight enough that any additional write load made it flake.
    //
    // Raised rather than removed: the thing it guards is a probe that never
    // answers, and a hang is unbounded, so a finite budget still catches it.
  }, 120_000);
});

describe('waitForDatabaseConnection — the startup gate', () => {
  it('resolves against a reachable database and publishes the pool', async () => {
    await closePostgres();

    await waitForDatabaseConnection(5_000);

    expect(isDatabaseConnected()).toBe(true);
    expect(await isDatabaseReachable()).toBe(true);
  });

  it('is idempotent — calling it with a pool already open is a no-op', async () => {
    await connectPostgres();

    await expect(waitForDatabaseConnection(5_000)).resolves.toBeUndefined();
    expect(isDatabaseConnected()).toBe(true);
  });

  it('THROWS once the deadline passes rather than letting startup continue', async () => {
    await closePostgres();
    const url = new URL(ORIGINAL_DATABASE_URL ?? '');
    url.pathname = '/oxy_does_not_exist';
    process.env.DATABASE_URL = url.toString();

    // `server.ts` gates `app.listen` on this promise and `process.exit(1)`s on
    // rejection. Resolving anyway would let the task serve traffic — and pass
    // its own health check on the strength of a connection object — against a
    // database that never came up.
    await expect(waitForDatabaseConnection(1_500)).rejects.toThrow(
      /PostgreSQL connection timeout after 1500ms/,
    );
    expect(isDatabaseConnected()).toBe(false);
  }, 15_000);

  it('RETRIES inside the deadline instead of giving up on the first attempt', async () => {
    await closePostgres();
    const url = new URL(ORIGINAL_DATABASE_URL ?? '');
    url.pathname = '/oxy_does_not_exist';
    process.env.DATABASE_URL = url.toString();

    // `postgres.js` makes ONE connection attempt where the Mongo driver retried
    // internally, so without the retry loop a task that starts beside a
    // database still finishing a failover would crash-loop. The error names the
    // attempt count, which is what says the loop really ran.
    await expect(waitForDatabaseConnection(2_500)).rejects.toThrow(/[2-9]\d* attempt\(s\)/);
  }, 15_000);
});
