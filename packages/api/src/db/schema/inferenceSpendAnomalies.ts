/**
 * `inference_spend_anomalies` — a spend spike that was NOTICED, and nothing else.
 *
 * #972 section 8 asks for "anomaly detection for sudden spend/token spikes" and
 * section 12 for fraud controls before prepaid public inference. This table is
 * the record half of that: one row per account, per currency, per hour in which
 * the account's inference spend exceeded a multiple of its own trailing daily
 * baseline. `services/spendAnomaly.service.ts` writes it and
 * `GET /inference/admin/spend-anomalies` reads it.
 *
 * ## WHAT A ROW IS NOT
 *
 * **It is not a block, a refusal, or a finding of fraud.** Nothing reads this
 * table to decide whether to serve a request, and that is deliberate: the
 * expensive error here is the false positive. An automated hard stop on a spend
 * multiple would take a paying customer's production traffic down during exactly
 * the launch, migration or batch job that made their spend jump — and it would
 * do it without anybody deciding. The spending limits (`spending_limits`) are the
 * mechanism a customer uses to say what they want stopped, and they already exist
 * and already refuse. This says "somebody should look".
 *
 * It is also not financial. The FK is `CASCADE`, unlike every reference into
 * `users` from the ledger: an alert about a charge is not the charge, so it must
 * not join the set of records that keep an account undeletable, and it must not
 * appear in a deletion readout as though the law required keeping it.
 *
 * ## WHY THE THRESHOLD IS STORED ON THE ROW
 *
 * `threshold_multiple` and `observed_days` record what the decision was made
 * WITH. `INFERENCE_SPEND_ANOMALY_MULTIPLE` is an environment value somebody can
 * change, and a row that recorded only "this was anomalous" becomes unreadable
 * the moment it does — the reader cannot tell a 3× alert under a 3× threshold
 * from a 3× alert that fired when the threshold was 2×.
 *
 * ## ONE ROW PER HOUR, ENFORCED
 *
 * The detector runs on an interval and re-reads the same trailing hour several
 * times, so `unique (account_id, currency, detected_for_hour)` plus
 * `ON CONFLICT DO NOTHING` is what makes a repeated observation one alert. Without
 * it a single spike would produce a row per sweep, and "how many anomalies did
 * this account have" would be answering a question about the sweep interval.
 *
 * `detected_for_hour` is the truncated UTC hour the spend fell in, never the
 * instant of detection — two sweeps observing one spike must collide.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { users } from './users';

export const inferenceSpendAnomalies = pgTable(
  'inference_spend_anomalies',
  {
    id: generatedId(),

    /**
     * Whose spend spiked. `CASCADE`, not `RESTRICT` — see the header: an alert is
     * not a financial record and must not make an account undeletable.
     */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * The currency the comparison was made IN.
     *
     * A dimension rather than a detail: summing amounts across currencies is
     * meaningless, so the detector groups by it and a multi-currency account can
     * legitimately have two rows for one hour.
     */
    currency: currencyCode(),

    /** The truncated UTC hour whose spend was anomalous. */
    detectedForHour: timestamptz().notNull(),

    /** What the account spent in that hour, exactly. */
    hourAmount: exactAmount().notNull(),

    /**
     * The median of the account's own trailing DAILY spends, exactly.
     *
     * `percentile_disc`, not `percentile_cont`: the discrete form returns a real
     * observed day and keeps the value `numeric`, where the continuous form
     * interpolates between two days and returns `double precision` — a float
     * standing in for money on a row somebody will read as evidence.
     */
    baselineMedianAmount: exactAmount().notNull(),

    /** The configured multiple in force when this row was written. */
    thresholdMultiple: doublePrecision().notNull(),

    /** How many days of history the median was taken over. */
    observedDays: integer().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // Idempotency. See "ONE ROW PER HOUR" in the header.
    unique('inference_spend_anomalies_account_currency_hour_key').on(
      t.accountId,
      t.currency,
      t.detectedForHour
    ),

    // "What has this account triggered lately", newest first — the staff read.
    index('inference_spend_anomalies_account_id_detected_for_hour_idx').on(
      t.accountId,
      t.detectedForHour.desc()
    ),
    // "What fired across the platform in the last day", the operator's first
    // question, which is not scoped to an account.
    index('inference_spend_anomalies_detected_for_hour_idx').on(t.detectedForHour.desc()),

    check('inference_spend_anomalies_currency_check', currencyCodeCheck(t.currency)),
    check('inference_spend_anomalies_hour_amount_check', sql`${t.hourAmount} >= 0`),
    // A ZERO baseline is refused rather than stored. Every multiple of zero is
    // exceeded, so a row carrying one would record an alert whose stated reason
    // is arithmetically vacuous — the detector filters it, and this is what stops
    // another writer reintroducing it.
    check(
      'inference_spend_anomalies_baseline_median_amount_check',
      sql`${t.baselineMedianAmount} > 0`
    ),
    // A multiple of 1 or less flags an account for spending a normal amount.
    check('inference_spend_anomalies_threshold_multiple_check', sql`${t.thresholdMultiple} > 1`),
    check('inference_spend_anomalies_observed_days_check', sql`${t.observedDays} > 0`),
  ]
);
