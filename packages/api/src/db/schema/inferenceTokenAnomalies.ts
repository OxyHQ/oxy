/**
 * `inference_token_anomalies` — a TOKEN spike that was noticed, and nothing else.
 *
 * #972 section 8 asks for "anomaly detection for sudden spend/token spikes". The
 * spend half is `inference_spend_anomalies`; this is the token half. One row per
 * account, per hour in which the account's token consumption exceeded a multiple
 * of its own trailing daily baseline. `services/tokenAnomaly.service.ts` writes it
 * and `GET /inference/admin/token-anomalies` reads it.
 *
 * ## WHY A SECOND TABLE RATHER THAN A COLUMN ON THE FIRST
 *
 * `inference_spend_anomalies` stores its two values as `exactAmount()` — money —
 * and carries `currency` as a grouping DIMENSION, because summing amounts across
 * currencies is meaningless. A token count is neither: it is an integer, and it
 * has no currency at all. Reusing that table would mean putting counts in money
 * columns and inventing a currency for them, which is the same category error its
 * own detector header warns about ("a cheap model can produce ten times the tokens
 * for a tenth of the money").
 *
 * So the two signals are distinguishable by CONSTRUCTION rather than by a
 * discriminator somebody has to read: different table, different column types, and
 * no currency here to be confused with a monetary one. **A token spike with flat
 * spend is a different fact from a spend spike with flat tokens**, and both are
 * different from the two moving together — which is the whole reason the epic names
 * them separately.
 *
 * ## WHAT A ROW IS NOT
 *
 * **Not a block, a refusal, or a finding of abuse.** Nothing reads this table to
 * decide whether to serve a request, exactly as with the spend half: the expensive
 * error is the false positive, and a hard stop on a token multiple would take a
 * paying customer's traffic down during precisely the migration or batch job that
 * made their token count jump, with nobody deciding. `spending_limits` is the
 * mechanism a customer uses to say what they want stopped, and it already refuses
 * inside `reserve`. This says "somebody should look".
 *
 * It is also not financial — a token count is not a charge — so the FK is
 * `CASCADE`: an alert must not join the set of records that keep an account
 * undeletable.
 *
 * ## WHY THE THRESHOLD AND THE SAMPLE SIZE ARE ON THE ROW
 *
 * `threshold_multiple` and `observed_days` record what the decision was made WITH.
 * `INFERENCE_TOKEN_ANOMALY_MULTIPLE` is an environment value somebody can change,
 * and a row recording only "this was anomalous" becomes unreadable the moment it
 * does: the reader cannot tell a 3x alert under a 3x threshold from a 3x alert that
 * fired when the threshold was 2x.
 *
 * ## ONE ROW PER HOUR, ENFORCED
 *
 * The detector runs on an interval and re-reads the same trailing hour several
 * times, so `unique (account_id, detected_for_hour)` plus `ON CONFLICT DO NOTHING`
 * is what makes a repeated observation one alert rather than one per sweep.
 *
 * `detected_for_hour` is the truncated UTC hour the tokens fell in, never the
 * instant of detection — two sweeps observing one spike must collide.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, doublePrecision, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { users } from './users';

export const inferenceTokenAnomalies = pgTable(
  'inference_token_anomalies',
  {
    id: generatedId(),

    /**
     * Whose token consumption spiked. `CASCADE`, not `RESTRICT` — see the header:
     * an alert is not a financial record and must not make an account undeletable.
     */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** The truncated UTC hour whose token count was anomalous. */
    detectedForHour: timestamptz().notNull(),

    /**
     * Tokens consumed in that hour — the sum of the four TOKEN units only.
     *
     * `input_tokens`, `cached_input_tokens`, `output_tokens` and
     * `reasoning_tokens`. Images, audio and video milliseconds, characters and
     * embeddings are deliberately excluded: adding milliseconds to a token count
     * produces a number that is not tokens, which is the same error as adding USD
     * to EUR.
     *
     * `bigint` rather than `integer`: a busy account passes two billion tokens in
     * an hour without anything being wrong.
     */
    hourTokens: bigint({ mode: 'number' }).notNull(),

    /**
     * The median of the account's own trailing DAILY token totals.
     *
     * `percentile_disc`, not `percentile_cont`: the discrete form returns a real
     * observed day and keeps the value an integer, where the continuous form
     * interpolates between two days and returns `double precision` — a float
     * standing in for a count of discrete things.
     */
    baselineMedianTokens: bigint({ mode: 'number' }).notNull(),

    /** The configured multiple in force when this row was written. */
    thresholdMultiple: doublePrecision().notNull(),

    /** How many days of history the median was taken over. */
    observedDays: integer().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    // Idempotency. See "ONE ROW PER HOUR" in the header. No currency in the key,
    // unlike the spend half — a token count has none, so one account-hour is one
    // row and a second would be a duplicate rather than another currency.
    unique('inference_token_anomalies_account_hour_key').on(t.accountId, t.detectedForHour),

    // "What has this account triggered lately", newest first — the staff read.
    index('inference_token_anomalies_account_id_detected_for_hour_idx').on(
      t.accountId,
      t.detectedForHour.desc()
    ),
    // "What fired across the platform in the last day", which is not scoped to an
    // account and so cannot use the compound above.
    index('inference_token_anomalies_detected_for_hour_idx').on(t.detectedForHour.desc()),

    check('inference_token_anomalies_hour_tokens_check', sql`${t.hourTokens} >= 0`),
    // A ZERO baseline is refused rather than stored. Every multiple of zero is
    // exceeded, so a row carrying one would record an alert whose stated reason is
    // arithmetically vacuous — the detector filters it, and this is what stops
    // another writer reintroducing it.
    check(
      'inference_token_anomalies_baseline_median_tokens_check',
      sql`${t.baselineMedianTokens} > 0`
    ),
    // A multiple of 1 or less flags an account for using a normal number of tokens.
    check('inference_token_anomalies_threshold_multiple_check', sql`${t.thresholdMultiple} > 1`),
    check('inference_token_anomalies_observed_days_check', sql`${t.observedDays} > 0`),
    // The row's own claim has to be true of the row: an hour at or below its
    // baseline is not a spike, so a writer that inverted the comparison would be
    // refused here rather than filling the table with non-events.
    check(
      'inference_token_anomalies_is_a_spike_check',
      sql`${t.hourTokens} > ${t.baselineMedianTokens}`
    ),
  ]
);
