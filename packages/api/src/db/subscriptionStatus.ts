/**
 * Subscription status projection — the OTHER half of removing the TTL index.
 *
 * `subscriptions` used to carry `index({ endDate: 1 }, { expireAfterSeconds: 0 })`.
 * A Mongo TTL index DELETES the document, so a subscription's record — what was
 * bought, when it started, what it entitled the buyer to — was destroyed the
 * moment its period closed. That was a data-loss bug, and the table is
 * deliberately ABSENT from `db/expiry.ts`'s registry (a test asserts it stays
 * absent) because that registry deletes rows, which is the behaviour being
 * removed.
 *
 * What replaces it is a PROJECTION, not a deletion:
 *
 *   update subscriptions set status = 'expired'
 *   where status = 'active' and end_date <= now()
 *
 * The row survives; only the label catches up. `subscriptions_active_end_date_idx`
 * — a partial index on `end_date where status = 'active'` — is what makes the
 * predicate a range scan rather than a table scan, the same obligation Mongo's
 * TTL index carried.
 *
 * ## This job is housekeeping, never correctness
 *
 * Every read derives expiry for itself: `resolveUserSubscriptionPlan` filters
 * `end_date > now()` in SQL, and `formatSubscriptionResponse` computes `expired`
 * at serialization time. So a missed tick delays a label and entitles nobody —
 * class (A) in `db/expiry.ts`'s taxonomy. The projection exists for reads and
 * dashboards that GROUP BY status, which cannot express the derivation.
 *
 * That is a strictly stronger position than the TTL index held: Mongo's TTL
 * monitor lags about a minute, during which the lapsed document was still
 * present AND still `status: 'active'`, and nothing filtered it.
 *
 * A `GENERATED ALWAYS` column cannot do this — the expression would have to read
 * `now()`, which is not IMMUTABLE.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../config/postgres';

/**
 * Rows relabelled per statement. Bounded so a large backlog cannot hold one
 * transaction open across the whole table — same reason `db/expiry.ts` batches.
 */
const DEFAULT_BATCH_SIZE = 1_000;

/** Statements per run, so a pathological backlog cannot run unbounded. */
const DEFAULT_MAX_BATCHES = 50;

export interface SubscriptionExpiryResult {
  /** How many rows moved from `active` to `expired`. */
  readonly expired: number;
  /** True when the batch ceiling was hit and rows remain for the next run. */
  readonly truncated: boolean;
}

export interface SubscriptionExpiryOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

/**
 * Materialize `status = 'expired'` for every lapsed active subscription.
 *
 * Idempotent by construction: the predicate excludes rows already relabelled, so
 * a second run in the same instant matches nothing. `canceled` rows are never
 * touched — a cancellation is a decision the user made and outranks the deadline.
 *
 * Batching goes through `ctid` (Postgres's physical row address) because
 * `UPDATE ... LIMIT` is not valid SQL: the inner select takes the limit, the
 * outer update relabels exactly those rows.
 */
export async function projectExpiredSubscriptions(
  db: Database,
  options: SubscriptionExpiryOptions = {}
): Promise<SubscriptionExpiryResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;

  let expired = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await db.execute<{ ctid: string }>(sql`
      update "subscriptions" set "status" = 'expired'
      where ctid in (
        select ctid from "subscriptions"
        where "status" = 'active' and "end_date" <= now()
        limit ${batchSize}
      )
      returning ctid
    `);

    expired += rows.length;
    if (rows.length < batchSize) {
      return { expired, truncated: false };
    }
  }

  return { expired, truncated: true };
}
