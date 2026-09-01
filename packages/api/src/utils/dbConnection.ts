/**
 * Database readiness — the startup gate and its synchronous companion.
 *
 * This file used to wrap `mongoose.connection.readyState` and the driver's
 * `connected`/`error` events. Neither has a Postgres counterpart, and the
 * difference is not cosmetic:
 *
 *  - Mongoose's driver retries server selection internally and emits
 *    `connected` whenever it eventually succeeds, so "wait for the connection"
 *    was a matter of subscribing to an event.
 *  - `postgres.js` has no such event. `connectPostgres()` issues ONE `select 1`
 *    and either resolves or throws — a single attempt. On ECS the task can
 *    start before RDS finishes a failover or a security group settles, so a
 *    single attempt would turn a few seconds of unavailability into a crash
 *    loop.
 *
 * {@link waitForDatabaseConnection} therefore RETRIES until the deadline, which
 * is what preserves the old behaviour: `server.ts` does not call `listen` until
 * the database has actually answered, and gives up with a thrown error after
 * the timeout exactly as the Mongo version did.
 *
 * The probe is a real round trip in both functions that claim liveness. A pool
 * object existing proves nothing — that is the failure the `/health` endpoint
 * used to have, where `readyState === 1` reported "connected" against a server
 * that was refusing work.
 */

import { checkPostgresHealth, connectPostgres, isPostgresConnected } from '../config/postgres';
import { logger } from './logger';

/** How long to wait between connection attempts inside the deadline. */
const RETRY_INTERVAL_MS = 1_000;

/**
 * Whether a connection pool is open.
 *
 * SYNCHRONOUS, and therefore NOT a liveness check — a pool can be open while
 * the server is unreachable. It answers "has startup published a handle yet?",
 * which is the question a background job asks before deciding whether it can
 * issue a query at all. Anything that must know the database ANSWERS uses
 * {@link isDatabaseReachable}.
 */
export function isDatabaseConnected(): boolean {
  return isPostgresConnected();
}

/**
 * Whether the database answers a query RIGHT NOW.
 *
 * Round-trips `select 1` through the application's own pool, so it reports on
 * the same connections real requests use. Never throws — an unreachable
 * database is this function's RESULT, not an exception for the caller.
 */
export function isDatabaseReachable(): Promise<boolean> {
  return checkPostgresHealth();
}

/**
 * Open the connection pool, retrying until it answers or `timeout` elapses.
 *
 * Idempotent (`connectPostgres` returns the existing handle), so calling it
 * when already connected costs one `select 1` at most.
 *
 * @param timeout - Milliseconds to keep retrying before giving up.
 * @throws The last connection error once the deadline passes — startup must
 *   fail loudly rather than serve traffic against a database that never came
 *   up.
 */
export async function waitForDatabaseConnection(timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      await connectPostgres();
      if (attempts > 1) {
        logger.info('PostgreSQL connection established after retrying', { attempts });
      }
      return;
    } catch (error) {
      lastError = error;
      logger.warn('PostgreSQL not ready yet, retrying', {
        attempts,
        msRemaining: Math.max(0, deadline - Date.now()),
        error: error instanceof Error ? error.message : String(error),
      });
      const msRemaining = deadline - Date.now();
      if (msRemaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_INTERVAL_MS, msRemaining)));
    }
  }

  throw new Error(
    `PostgreSQL connection timeout after ${timeout}ms (${attempts} attempt(s)): ` +
    (lastError instanceof Error ? lastError.message : String(lastError))
  );
}
