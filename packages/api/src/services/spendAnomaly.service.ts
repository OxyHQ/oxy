/**
 * Sudden-spend detection (#972 section 8, "anomaly detection for sudden
 * spend/token spikes"; section 12, fraud controls before prepaid public
 * inference).
 *
 * An account whose inference spend in ONE HOUR exceeds a multiple of its own
 * trailing DAILY median is recorded in `inference_spend_anomalies` and logged as
 * `inference.spend.anomaly`. Nothing else happens.
 *
 * ## IT DOES NOT BLOCK, AND THAT IS THE DESIGN
 *
 * The expensive error here is the false positive. A hard stop on a spend multiple
 * takes a paying customer's production traffic down during precisely the launch,
 * migration or backfill that made their spend jump, and it does it with nobody
 * deciding. A customer who wants their own spend stopped has `spending_limits`,
 * which already refuse inside `reserve`. This raises a signal a person acts on.
 *
 * ## WHY `usage_receipts` AND NOT THE DAILY ROLLUP
 *
 * `inference_usage_daily_rollups` is the obvious-looking source and cannot answer
 * this question in either dimension. Its own header states the first half — "It
 * carries no money, exactly as `inference_usage_events` carries none. A spend
 * figure comes from `usage_receipts`" — and its grain is the second: the primary
 * key leads with `day date`, so there is no hour in it to compare. Using it would
 * mean detecting a TOKEN spike and calling it a spend spike, which is a different
 * claim about a different thing (a cheap model can produce ten times the tokens
 * for a tenth of the money).
 *
 * So both sides come from `usage_receipts` — the financial record — which already
 * carries the exact index the query needs:
 * `usage_receipts_account_id_settled_at_idx` on `(account_id, settled_at desc)`.
 * No new aggregate, no new column, one read.
 *
 * ## THE FOUR THINGS THAT KEEP THE SIGNAL FROM BEING NOISE
 *
 *  1. **The baseline excludes the current day**, so a spike cannot raise the
 *     baseline it is being measured against.
 *  2. **A minimum number of observed days** ({@link MINIMUM_BASELINE_DAYS}). A
 *     brand-new account's first real hour is "infinitely above" a one-day
 *     history, and flagging every new customer on their first day is how an alert
 *     channel becomes something people mute.
 *  3. **A zero median is excluded.** Every multiple of zero is exceeded, so an
 *     account that spent nothing for a fortnight and then spent a cent would
 *     otherwise be the platform's most anomalous account.
 *  4. **Per currency.** Adding USD to EUR produces a number that is not money.
 *
 * ## THE MULTIPLE IS CONFIGURED, WITH A DOCUMENTED DEFAULT
 *
 * `INFERENCE_SPEND_ANOMALY_MULTIPLE`, default {@link DEFAULT_ANOMALY_MULTIPLE}.
 * An hour is a twenty-fourth of a day, so "an hour above 3× a normal DAY" is
 * roughly seventy times the account's usual hourly rate — deliberately far out,
 * because the first version of a signal nobody trusts is a signal nobody reads.
 * The value in force is written onto every row, so tightening it later does not
 * make the old rows unreadable.
 */

import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { getDb } from '../config/postgres';
import { inferenceSpendAnomalies } from '../db/schema/inferenceSpendAnomalies';
import { logger } from '../utils/logger';

/** `INFERENCE_SPEND_ANOMALY_MULTIPLE` — how far above the daily median is odd. */
export const SPEND_ANOMALY_MULTIPLE_VARIABLE = 'INFERENCE_SPEND_ANOMALY_MULTIPLE';

/** See "THE MULTIPLE IS CONFIGURED" in the header for where 3 comes from. */
export const DEFAULT_ANOMALY_MULTIPLE = 3;

/**
 * Days of history the baseline needs before an account can be flagged.
 *
 * Seven, so a median is taken over at least a full week and a weekday/weekend
 * pattern cannot be the whole sample. Below this an account is simply not
 * evaluated — which is a silence about a new customer, not a clean bill.
 */
export const MINIMUM_BASELINE_DAYS = 7;

/** How far back the daily baseline reaches. */
export const BASELINE_WINDOW_DAYS = 14;

/** How often the sweep runs. */
export const SPEND_ANOMALY_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The configured multiple, or the default.
 *
 * A value that is not a number above 1 falls back to the default and is reported
 * once — the same stance `config/rolloutFlags.ts` takes, and for the same reason:
 * a typo in a threshold must not disable the detector in silence, and it must not
 * be readable as `0` either, which would flag every account on the platform.
 */
export function resolveAnomalyMultiple(): number {
  const configured = process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) return DEFAULT_ANOMALY_MULTIPLE;

  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 1) {
    reportUnreadableMultiple(configured);
    return DEFAULT_ANOMALY_MULTIPLE;
  }
  return parsed;
}

/** Reported once per distinct bad value, not once per sweep. */
const reportedMultiples = new Set<string>();

function reportUnreadableMultiple(value: string): void {
  if (reportedMultiples.has(value)) return;
  reportedMultiples.add(value);
  logger.error(
    'inference.spend.anomaly_multiple_unreadable',
    new Error(
      `${SPEND_ANOMALY_MULTIPLE_VARIABLE} is not a number above 1; the default multiple applies`
    ),
    { component: 'spendAnomaly', expected: 'a number greater than 1, e.g. 3' }
  );
}

/** Test-only reset, so a suite can assert the report fires for its own value. */
export function forgetReportedAnomalyMultiples(): void {
  reportedMultiples.clear();
}

/** One account-hour that exceeded its own baseline. */
export interface SpendAnomaly {
  readonly accountId: string;
  readonly currency: string;
  /** The truncated UTC hour, as an instant. */
  readonly detectedForHour: Date;
  /** Exact decimal strings, straight out of `numeric`. */
  readonly hourAmount: string;
  readonly baselineMedianAmount: string;
  readonly thresholdMultiple: number;
  readonly observedDays: number;
}

export interface SpendAnomalySweepResult {
  /** Every anomaly the pass observed, whether or not its row was new. */
  readonly detected: readonly SpendAnomaly[];
  /** How many rows this pass actually inserted — the rest were already recorded. */
  readonly recorded: number;
  readonly thresholdMultiple: number;
}

/**
 * The raw shape the statement below returns.
 *
 * Snake-cased, because a raw `sql` read is not passed through drizzle's column
 * mapper — and typed as a `type` with an index signature because `executeRows`
 * constrains its parameter to `Record<string, unknown>`.
 *
 * `hour_amount` and `baseline_median_amount` are STRINGS: `postgres.js` decodes
 * `numeric` as text, which is the correct decoding for money and the reason these
 * are carried straight through rather than parsed into a `number` anywhere.
 *
 * `detected_for_hour` is `string | Date` and NOT `Date`, because a raw read does
 * not go through drizzle's result mapper — the same reason a `mode: 'number'`
 * column comes back as a string from one. Measured: it arrives as a string here,
 * and typing it `Date` compiled cleanly and then threw
 * `toISOString is not a function` at the insert.
 */
type AnomalyRow = {
  account_id: string;
  currency: string;
  detected_for_hour: string | Date;
  hour_amount: string;
  baseline_median_amount: string;
  observed_days: number;
  [key: string]: unknown;
};

/** Normalise a raw-read timestamp. See {@link AnomalyRow}. */
function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Find every account whose last complete hour of spend exceeded its baseline.
 *
 * One statement, three CTEs, and every filter is IN the statement rather than in
 * a loop over accounts: an account-at-a-time detector costs a query per paying
 * customer per sweep, and the whole computation is two grouped scans of an index
 * that already exists.
 *
 * `percentile_disc` rather than `percentile_cont` — the discrete form returns a
 * real observed day and keeps the value `numeric`, where the continuous form
 * interpolates and returns `double precision`, putting a float where money is.
 */
export async function detectSpendAnomalies(
  thresholdMultiple: number = resolveAnomalyMultiple()
): Promise<readonly SpendAnomaly[]> {
  const rows = await executeRows<AnomalyRow>(
    getDb(),
    sql`
      with recent as (
        select
          account_id,
          currency,
          date_trunc('hour', now()) - interval '1 hour' as detected_for_hour,
          sum(billed_amount) as hour_amount
        from usage_receipts
        where settled_at >= date_trunc('hour', now()) - interval '1 hour'
          and settled_at < date_trunc('hour', now())
        group by account_id, currency
      ),
      daily as (
        select
          account_id,
          currency,
          date_trunc('day', settled_at) as day,
          sum(billed_amount) as day_amount
        from usage_receipts
        where settled_at >= date_trunc('day', now()) - (${BASELINE_WINDOW_DAYS}::int * interval '1 day')
          and settled_at < date_trunc('day', now())
        group by account_id, currency, date_trunc('day', settled_at)
      ),
      baseline as (
        select
          account_id,
          currency,
          percentile_disc(0.5) within group (order by day_amount) as baseline_median_amount,
          count(*)::int as observed_days
        from daily
        group by account_id, currency
      )
      select
        recent.account_id,
        recent.currency,
        recent.detected_for_hour,
        recent.hour_amount,
        baseline.baseline_median_amount,
        baseline.observed_days
      from recent
      join baseline
        on baseline.account_id = recent.account_id
       and baseline.currency = recent.currency
      where baseline.observed_days >= ${MINIMUM_BASELINE_DAYS}::int
        and baseline.baseline_median_amount > 0
        -- The multiple is bound as TEXT and cast, never as a float: a numeric cast
        -- applied to a float8 parameter reintroduces binary rounding on the one
        -- comparison the whole signal turns on.
        and recent.hour_amount
              > baseline.baseline_median_amount * ${String(thresholdMultiple)}::numeric
      order by recent.account_id, recent.currency
    `
  );

  return rows.map((row) => ({
    accountId: row.account_id,
    currency: row.currency,
    detectedForHour: toDate(row.detected_for_hour),
    hourAmount: row.hour_amount,
    baselineMedianAmount: row.baseline_median_amount,
    thresholdMultiple,
    observedDays: row.observed_days,
  }));
}

/**
 * Detect, record and report. The whole control, in one call.
 *
 * The insert is `ON CONFLICT DO NOTHING RETURNING`, never catch-the-duplicate: a
 * `catch` cannot tell a repeated observation from a dropped connection, and the
 * sweep re-reads the same hour several times by design. `recorded` counts the
 * rows that were genuinely new, which is what makes "the same spike four times"
 * distinguishable from "four spikes".
 *
 * The log line is emitted for a NEW row only, so an alert channel wired to
 * `inference.spend.anomaly` fires once per spike rather than once per sweep.
 */
export async function sweepSpendAnomalies(): Promise<SpendAnomalySweepResult> {
  const thresholdMultiple = resolveAnomalyMultiple();
  const detected = await detectSpendAnomalies(thresholdMultiple);
  if (detected.length === 0) {
    return { detected, recorded: 0, thresholdMultiple };
  }

  let recorded = 0;
  for (const anomaly of detected) {
    // The drizzle builder, not a raw `sql` insert: `id` comes from the schema's
    // `generatedId()` default, which is applied by the BUILDER and not by the
    // database — a raw insert omitting the column fails its NOT NULL, which is
    // how this was found.
    const inserted = await getDb()
      .insert(inferenceSpendAnomalies)
      .values({
        accountId: anomaly.accountId,
        currency: anomaly.currency,
        detectedForHour: anomaly.detectedForHour,
        hourAmount: anomaly.hourAmount,
        baselineMedianAmount: anomaly.baselineMedianAmount,
        thresholdMultiple: anomaly.thresholdMultiple,
        observedDays: anomaly.observedDays,
      })
      .onConflictDoNothing({
        target: [
          inferenceSpendAnomalies.accountId,
          inferenceSpendAnomalies.currency,
          inferenceSpendAnomalies.detectedForHour,
        ],
      })
      .returning({ id: inferenceSpendAnomalies.id });
    if (inserted.length === 0) continue;

    recorded += 1;
    // The alertable line. No IP, no user identifier beyond the account id, and no
    // payload — money and the arithmetic that flagged it, which is what an
    // operator needs to decide whether to look.
    logger.warn('inference.spend.anomaly', {
      component: 'spendAnomaly',
      accountId: anomaly.accountId,
      currency: anomaly.currency,
      detectedForHour: anomaly.detectedForHour.toISOString(),
      hourAmount: anomaly.hourAmount,
      baselineMedianAmount: anomaly.baselineMedianAmount,
      thresholdMultiple: anomaly.thresholdMultiple,
      observedDays: anomaly.observedDays,
    });
  }

  return { detected, recorded, thresholdMultiple };
}
