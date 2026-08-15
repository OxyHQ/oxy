/**
 * Spending Limit Service — budgets, alert thresholds and the hard/soft stop.
 *
 * Called by `inferenceLedger.service.ts` INSIDE the reservation transaction, on
 * the same locked balance row, because a limit consulted after the provider has
 * been billed is not a limit.
 *
 * ## What counts toward a limit
 *
 * Settled spend (`usage_receipts.billed_amount`) PLUS money currently held
 * (`usage_reservations` still in `held`), plus the hold being taken right now.
 * Including holds is the safe direction and it is not free: a limit that counts
 * only settled charges can be blown straight through by concurrency, because
 * every in-flight request is invisible to it until it settles. The cost is that
 * a burst of holds can refuse a request the account could in fact afford; the
 * holds expire and the budget recovers.
 *
 * Refunds are subtracted, because a reversed charge is not spend.
 *
 * ## An account-scoped limit covers the account's SUBTREE
 *
 * An organization's budget has to bound what its projects spend, or it bounds
 * nothing — a project account is where an application's owner account usually
 * sits. The descendant set comes from the existing materialised `user_ancestors`
 * path, the same one `resolveEffectiveMembership` walks, so budgets and
 * permissions cannot come to different answers about the shape of the tree.
 *
 * ## Alerts are events, not states
 *
 * A crossed threshold is recorded in `spending_limit_notifications`, unique on
 * `(limit, period_start, threshold)`. Without that record the "you have used
 * 75% of your budget" alert re-fires on every subsequent request for the rest of
 * the period. The insert is `ON CONFLICT DO NOTHING`, never a
 * catch-the-duplicate: a duplicate key and a dropped connection are
 * indistinguishable inside a `catch`.
 *
 * This module DECIDES and RECORDS. It does not deliver — wiring a crossing to
 * an email or a webhook is a notification concern, and the row is the durable
 * trigger a delivery pass reads.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import type { DatabaseOrTransaction } from '../config/postgres';
import {
  spendingLimitNotifications,
  spendingLimits,
  type SpendingLimitEnforcement,
  type SpendingLimitPeriod,
  type SpendingLimitScope,
} from '../db/schema/spendingLimits';
import { userAncestors } from '../db/schema/userAncestors';

/** Basis points in a whole. 10000 bps = 100%. */
const BASIS_POINTS = 10000;

/** Where a request's spend is attributed, for matching limits against it. */
export interface SpendingScope {
  /** The account the workload belongs to — `applications.owner_account_id`. */
  readonly accountId: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
}

/** One limit the request came up against. */
export interface SpendingLimitVerdict {
  readonly spendingLimitId: string;
  readonly scope: SpendingLimitScope;
  readonly period: SpendingLimitPeriod;
  readonly enforcement: SpendingLimitEnforcement;
  /** Exact decimal string. */
  readonly limitAmount: string;
  /** Spend already counted in this period, before the amount being reserved. */
  readonly currentSpend: string;
  /** `currentSpend` plus the amount being reserved. */
  readonly projectedSpend: string;
}

export type SpendingLimitEvaluation =
  /** Nothing is exceeded, though soft limits may have been passed. */
  | { readonly status: 'within'; readonly softStopsPassed: SpendingLimitVerdict[] }
  /** A `hard_stop` limit would be exceeded — the reservation must be refused. */
  | { readonly status: 'exceeded'; readonly limit: SpendingLimitVerdict };

interface LimitRow extends Record<string, unknown> {
  id: string;
  scope: SpendingLimitScope;
  scope_account_id: string | null;
  scope_application_id: string | null;
  scope_application_credential_id: string | null;
  period: SpendingLimitPeriod;
  enforcement: SpendingLimitEnforcement;
  limit_amount: string;
  alert_threshold_bps: number[];
  period_start_ms: string;
  current_spend: string;
  projected_spend: string;
  exceeded: boolean;
}

/**
 * The start of the window a period is measured over.
 *
 * `total` is a LIFETIME cap, so its window opens at the epoch — a rolling
 * window would quietly re-arm a budget that is meant never to.
 *
 * Written against the `sl` alias explicitly rather than by interpolating the
 * drizzle column: a column interpolated into raw SQL renders BARE, and a bare
 * name in a query with more than one relation in scope resolves against
 * whichever one Postgres picks, silently.
 */
const PERIOD_START_EXPRESSION = `case sl.period
    when 'daily' then date_trunc('day', now())
    when 'weekly' then date_trunc('week', now())
    when 'monthly' then date_trunc('month', now())
    else timestamptz '1970-01-01T00:00:00Z'
  end`;

/**
 * Evaluate every limit that applies to one reservation.
 *
 * Returns the FIRST `hard_stop` breach it finds — there is nothing useful to do
 * with a second one, and reporting the one that stopped the request is what a
 * customer needs to raise. Soft-stop breaches are all returned, because a
 * caller may want to surface every one of them.
 */
export async function evaluateSpendingLimits(
  tx: DatabaseOrTransaction,
  scope: SpendingScope,
  currency: string,
  additionalAmount: string
): Promise<SpendingLimitEvaluation> {
  const ancestorRows = await tx
    .select({ ancestorId: userAncestors.ancestorId })
    .from(userAncestors)
    .where(eq(userAncestors.userId, scope.accountId));
  const accountScopeTargets = [scope.accountId, ...ancestorRows.map((row) => row.ancestorId)];

  const applicable = await tx
    .select({ id: spendingLimits.id })
    .from(spendingLimits)
    .where(
      and(
        eq(spendingLimits.status, 'active'),
        eq(spendingLimits.currency, currency),
        or(
          inArray(spendingLimits.scopeAccountId, accountScopeTargets),
          eq(spendingLimits.scopeApplicationId, scope.applicationId),
          eq(spendingLimits.scopeApplicationCredentialId, scope.applicationCredentialId)
        )
      )
    );

  if (applicable.length === 0) {
    return { status: 'within', softStopsPassed: [] };
  }

  const limitIds = applicable.map((row) => row.id);
  const rows = await executeRows<LimitRow>(
    tx,
    sql`
      with applicable as (
        select
          sl.id,
          sl.scope,
          sl.scope_account_id,
          sl.scope_application_id,
          sl.scope_application_credential_id,
          sl.period,
          sl.enforcement,
          sl.limit_amount,
          sl.alert_threshold_bps,
          ${sql.raw(PERIOD_START_EXPRESSION)} as period_start
        from ${spendingLimits} sl
        -- "= any(param)", never a bare array: an interpolated array renders as a
        -- ROW CONSTRUCTOR, which compares tuples rather than testing membership.
        where sl.id = any(${sql.param(limitIds)}::text[])
      ),
      -- Every account a scope covers: the account itself plus its whole
      -- subtree, so an organization budget bounds what its projects spend.
      covered as (
        select a.id as limit_id, a.scope_account_id as account_id
        from applicable a
        where a.scope_account_id is not null
        union
        select a.id, ua.user_id
        from applicable a
        join user_ancestors ua on ua.ancestor_id = a.scope_account_id
        where a.scope_account_id is not null
      ),
      settled as (
        select a.id as limit_id, coalesce(sum(r.billed_amount), 0) as amount
        from applicable a
        left join usage_receipts r
          on r.currency = ${currency}
         and r.settled_at >= a.period_start
         and (
              (a.scope = 'account'
                 and r.account_id in (select c.account_id from covered c where c.limit_id = a.id))
           or (a.scope = 'application' and r.application_id = a.scope_application_id)
           or (a.scope = 'credential'
                 and r.application_credential_id = a.scope_application_credential_id)
         )
        group by a.id
      ),
      -- A reversed charge is not spend.
      reversed as (
        select a.id as limit_id, coalesce(sum(f.amount), 0) as amount
        from applicable a
        left join usage_refunds f on f.subject_kind = 'receipt' and f.currency = ${currency}
        left join usage_receipts r on r.id = f.receipt_id and r.settled_at >= a.period_start
        where r.id is not null
          and (
              (a.scope = 'account'
                 and r.account_id in (select c.account_id from covered c where c.limit_id = a.id))
           or (a.scope = 'application' and r.application_id = a.scope_application_id)
           or (a.scope = 'credential'
                 and r.application_credential_id = a.scope_application_credential_id)
          )
        group by a.id
      ),
      -- Money currently held. Counted, because a limit blind to in-flight
      -- requests can be blown straight through by concurrency.
      held as (
        select a.id as limit_id, coalesce(sum(res.reserved_amount), 0) as amount
        from applicable a
        left join usage_reservations res
          on res.status = 'held'
         and res.currency = ${currency}
         and res.created_at >= a.period_start
         and (
              (a.scope = 'account'
                 and res.account_id in (select c.account_id from covered c where c.limit_id = a.id))
           or (a.scope = 'application' and res.application_id = a.scope_application_id)
           or (a.scope = 'credential'
                 and res.application_credential_id = a.scope_application_credential_id)
         )
        group by a.id
      ),
      totalled as (
        select
          a.*,
          greatest(
            0::numeric,
            coalesce(s.amount, 0) - coalesce(v.amount, 0) + coalesce(h.amount, 0)
          ) as current_spend
        from applicable a
        left join settled s on s.limit_id = a.id
        left join reversed v on v.limit_id = a.id
        left join held h on h.limit_id = a.id
      )
      select
        t.id,
        t.scope,
        t.scope_account_id,
        t.scope_application_id,
        t.scope_application_credential_id,
        t.period,
        t.enforcement,
        t.limit_amount::text as limit_amount,
        t.alert_threshold_bps,
        -- Epoch MILLISECONDS as text, not a timestamptz: db.execute bypasses
        -- drizzle's result mapper, so what the driver hands back for a
        -- timestamp is the driver's business rather than the column's. An
        -- explicit integer instant has one reading.
        (extract(epoch from t.period_start) * 1000)::bigint::text as period_start_ms,
        t.current_spend::text as current_spend,
        (t.current_spend + ${additionalAmount}::numeric)::text as projected_spend,
        (t.current_spend + ${additionalAmount}::numeric > t.limit_amount) as exceeded
      from totalled t
      order by t.enforcement, t.id
    `
  );

  const softStopsPassed: SpendingLimitVerdict[] = [];
  for (const row of rows) {
    const verdict: SpendingLimitVerdict = {
      spendingLimitId: row.id,
      scope: row.scope,
      period: row.period,
      enforcement: row.enforcement,
      limitAmount: row.limit_amount,
      currentSpend: row.current_spend,
      projectedSpend: row.projected_spend,
    };
    if (!row.exceeded) continue;
    if (row.enforcement === 'hard_stop') {
      return { status: 'exceeded', limit: verdict };
    }
    softStopsPassed.push(verdict);
  }

  await recordThresholdCrossings(tx, rows);

  return { status: 'within', softStopsPassed };
}

/**
 * Write one notification per threshold a limit has newly crossed.
 *
 * Two steps, deliberately: the COMPARISON runs in SQL against the exact
 * `numeric` spend (a JS `number` comparison here would decide, wrongly and
 * occasionally, whether a customer is told they are near their budget), and the
 * INSERT goes through the query builder so the row gets the same application-
 * generated uuid v7 every other primary key in this schema does.
 *
 * Idempotent on `(limit, period_start, threshold)` via `ON CONFLICT DO NOTHING`,
 * never a caught duplicate-key error: a duplicate key and a dropped connection
 * are indistinguishable inside a `catch`, so an exception handler would answer
 * "already notified" to an infrastructure failure.
 */
async function recordThresholdCrossings(
  tx: DatabaseOrTransaction,
  rows: readonly LimitRow[]
): Promise<void> {
  const candidates = rows.filter((row) => row.alert_threshold_bps.length > 0);
  if (candidates.length === 0) return;

  const crossings: {
    spendingLimitId: string;
    periodStart: Date;
    thresholdBps: number;
    spendAmount: string;
  }[] = [];

  for (const row of candidates) {
    const [decision] = await executeRows<{ crossed: number[] }>(
      tx,
      sql`
        select coalesce(array_agg(threshold.bps order by threshold.bps), '{}')::int[] as crossed
        from unnest(${sql.param(row.alert_threshold_bps)}::int[]) as threshold(bps)
        where ${row.projected_spend}::numeric
              >= ${row.limit_amount}::numeric * threshold.bps
                 / ${sql.raw(String(BASIS_POINTS))}::numeric
      `
    );
    for (const bps of decision?.crossed ?? []) {
      crossings.push({
        spendingLimitId: row.id,
        periodStart: new Date(Number(row.period_start_ms)),
        thresholdBps: bps,
        spendAmount: row.projected_spend,
      });
    }
  }

  if (crossings.length === 0) return;
  await tx.insert(spendingLimitNotifications).values(crossings).onConflictDoNothing();
}
