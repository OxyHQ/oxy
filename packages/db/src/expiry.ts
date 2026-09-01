/**
 * Expiry Sweep — the replacement for Mongo TTL indexes
 *
 * Postgres has no TTL index. A consumer whose Mongo models relied on one needs
 * the same behaviour reproduced in Postgres, so the mechanism is defined ONCE
 * here: a caller builds a list of {@link ExpirySweepTarget}s — one per table
 * that used to carry a TTL index — and passes it to {@link sweepAllExpiredRows}.
 * The registry itself belongs to the consumer, not this package, because it
 * names the consumer's own tables.
 *
 * ## THE RULE, because it is the quietest failure in a Mongo-to-Postgres port
 *
 * **A TTL index is a behaviour of the SOURCE that does not survive the port.**
 * Mongo reaps; Postgres does not. A table ported without a registry entry grows
 * FOREVER — no error, no failing test, no symptom of any kind until disk. It is
 * structurally invisible because the thing doing the work was never in the
 * consumer's code to be missed: there is no deleted call site, no orphaned
 * function, nothing a reviewer diffing the port would see go absent.
 *
 * So porting a collection is not done when its schema, migration and backfill
 * plan exist. If its Mongoose model declares `expireAfterSeconds`, it is done
 * only once a matching entry exists in the consumer's own registry — and a
 * consumer should gate that with a test that WALKS its schema for
 * `expireAfterSeconds` declarations, rather than one that names tables by hand
 * and can only fall as far behind as the last time someone remembered to
 * update it.
 *
 * ## The shape
 *
 * A Mongo TTL index is `{ <field>: 1 }, { expireAfterSeconds: N }` — delete a
 * document once `<field>` is more than N seconds in the past. A registry entry
 * is exactly that pair, so no semantic is lost in translation:
 *
 *   { table, column, retentionSeconds }  →  delete where column <= now() - N
 *
 * Both common uses collapse into it: `expireAfterSeconds: 0` on a column that
 * already stores the deadline (an `expiresAt` column — the column IS the
 * deadline), and `expireAfterSeconds: N` measured from a birth column
 * (`createdAt` and similar).
 *
 * ## Every entry needs to be checked for INTENT, not just replicated
 *
 * A Mongo TTL index DELETES the document — always, unconditionally, once the
 * deadline passes. Before adding a table to a registry, confirm that is really
 * what should happen: a TTL index can be written to mean "mark expired" and
 * quietly destroy history instead, and a TTL'd table that still holds
 * unprocessed work (an outbox, a queue) needs an explicit note about what a
 * stalled consumer plus this sweep does to that backlog — a registry entry
 * with no such note reads as "unconditionally safe to sweep."
 *
 * ## Coexistence with reads
 *
 * Mongo's TTL monitor lags roughly its own check interval; this sweep lags one
 * call. A registry entry is only safe to add once its table's own read paths
 * are audited for depending on a swept row already being gone — every table
 * should either filter on its own deadline independently of the sweep, or be a
 * rolling view where an extra, not-yet-swept row is stale but never unsafe.
 * Adding a read that relies on absence turns the sweep interval into a
 * correctness window.
 *
 * ## Scheduling
 *
 * `sweepExpiredRows` and `sweepAllExpiredRows` are the mechanism only; wiring
 * either to a schedule belongs with the consumer's own job runner, alongside
 * whatever else that consumer already schedules.
 */

import { getTableName, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { executeRows, type SqlExecutor } from './database';

/**
 * Rows deleted per statement. Bounded so a large backlog cannot hold one long
 * transaction open — Mongo's TTL monitor deleted incrementally for the same
 * reason.
 */
const DEFAULT_BATCH_SIZE = 1000;

/**
 * Ceiling on batches per table per call, so one enormous table cannot starve
 * the others in a caller's target list. The remainder is picked up on the next
 * run.
 */
const DEFAULT_MAX_BATCHES = 50;

/** One table's expiry rule — the direct analogue of a Mongo TTL index. */
export interface ExpirySweepTarget {
  readonly table: PgTable;
  /** The date column the retention is measured from. Must be indexed. */
  readonly column: PgColumn;
  /** Seconds a row may survive past `column` before it is deleted. */
  readonly retentionSeconds: number;
  /** What deleting the row costs, in one line. */
  readonly reason: string;
}

/** Outcome of one sweep, for the caller to log or assert on. */
export interface ExpirySweepResult {
  readonly table: string;
  readonly deleted: number;
  /** True when the batch ceiling was hit and rows remain for the next run. */
  readonly truncated: boolean;
}

export interface ExpirySweepOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

/**
 * `column <= now() - retentionSeconds`.
 *
 * The column is interpolated as a drizzle Column, not as
 * `sql.identifier(column.name)`: `column.name` is the TypeScript property name
 * (`expiresAt`), and only drizzle's own renderer applies the configured casing
 * to reach `expires_at` — see `casing.ts`.
 */
function expiredPredicate(target: ExpirySweepTarget): SQL {
  return sql`${target.column} <= now() - make_interval(secs => ${target.retentionSeconds})`;
}

/**
 * Delete every expired row from one target, in bounded batches.
 *
 * Batching goes through `ctid` (Postgres's physical row address) because
 * `DELETE ... LIMIT` is not valid SQL: the inner select takes the limit, the
 * outer delete removes exactly those rows.
 */
export async function sweepExpiredRows(
  db: SqlExecutor,
  target: ExpirySweepTarget,
  options: ExpirySweepOptions = {}
): Promise<ExpirySweepResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const table = sql.identifier(getTableName(target.table));
  const expired = expiredPredicate(target);

  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await executeRows<{ ctid: string }>(
      db,
      sql`
        delete from ${table}
        where ctid in (
          select ctid from ${table} where ${expired} limit ${batchSize}
        )
        returning ctid
      `
    );

    deleted += rows.length;
    if (rows.length < batchSize) {
      return { table: getTableName(target.table), deleted, truncated: false };
    }
  }

  return { table: getTableName(target.table), deleted, truncated: true };
}

/**
 * Sweep every target the caller supplies. Runs them in sequence rather than in
 * parallel: this is background maintenance and should not contend with request
 * traffic for the connection pool.
 */
export async function sweepAllExpiredRows(
  db: SqlExecutor,
  targets: readonly ExpirySweepTarget[],
  options: ExpirySweepOptions = {}
): Promise<ExpirySweepResult[]> {
  const results: ExpirySweepResult[] = [];
  for (const target of targets) {
    results.push(await sweepExpiredRows(db, target, options));
  }
  return results;
}
