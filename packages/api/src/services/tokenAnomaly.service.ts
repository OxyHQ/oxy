/**
 * Sudden-TOKEN detection (#972 section 8, "anomaly detection for sudden
 * spend/token spikes"; section 12, fraud controls before prepaid public
 * inference).
 *
 * An account whose token consumption in ONE HOUR exceeds a multiple of its own
 * trailing DAILY median is recorded in `inference_token_anomalies` and logged as
 * `inference.tokens.anomaly`. Nothing else happens.
 *
 * ## THE OTHER HALF OF A SIGNAL THAT WAS ALREADY HALF-BUILT
 *
 * `spendAnomaly.service.ts` is the money half, and its header states exactly why
 * it could not also be this one: the daily rollup "carries no money", and using it
 * "would mean detecting a TOKEN spike and calling it a spend spike, which is a
 * different claim about a different thing (a cheap model can produce ten times the
 * tokens for a tenth of the money)". This is that different claim, made
 * separately, on the tables that can support it.
 *
 * **A token spike with flat spend is a different fact from a spend spike with flat
 * tokens**, and both differ from the two moving together. The first is a client in
 * a retry loop or a prompt that grew; the second is a switch to an expensive
 * model; the third is a genuine change in volume. Collapsing them would produce
 * one alert nobody can act on, which is why the two write to different tables with
 * different column types rather than sharing a row with a discriminator.
 *
 * ## IT DOES NOT BLOCK, AND THAT IS THE DESIGN
 *
 * The same argument the spend half makes, and it is not weaker here. A hard stop
 * on a token multiple takes a paying customer's production traffic down during
 * precisely the migration, backfill or launch that made their token count jump,
 * and it does it with nobody deciding. `spending_limits` is what a customer uses
 * to say what they want refused, and it already refuses inside `reserve`. This
 * raises a signal a person acts on.
 *
 * ## WHERE EACH SIDE OF THE COMPARISON COMES FROM, AND WHY THEY DIFFER
 *
 * Both tables carry NO money at all, so "this detector must not read money" is
 * structural here rather than a rule to remember: there is no amount column on
 * either to read.
 *
 *  - **The hour** comes from `inference_usage_events`. It is the only one of the
 *    two with an hour in it: `inference_usage_daily_rollups`' primary key leads
 *    with `day date`, so a detector built on the rollup alone could only compare a
 *    DAY against the daily median — and with a fifteen-minute sweep that fires
 *    once a whole day has exceeded the multiple, which is "expensive day", not
 *    "sudden spike", and notices a runaway client a day late.
 *  - **The baseline** comes from `inference_usage_daily_rollups`, which is the
 *    durable side: it is never swept, where `inference_usage_events` self-deletes
 *    at ninety days. A fourteen-day window sits inside both retentions today, so
 *    the two agree; the rollup is used anyway so the baseline does not silently
 *    start truncating if the window is ever widened.
 *
 * The two are maintained in the SAME transaction by `recordInferenceUsage`, so
 * they cannot disagree about a request.
 *
 * ## TOKENS MEANS TOKENS
 *
 * Four units are summed — `input_tokens`, `cached_input_tokens`, `output_tokens`,
 * `reasoning_tokens` — and the other seven are excluded. Adding audio
 * milliseconds, images, characters or embeddings into a token total produces a
 * number that is not tokens, which is the same category error as adding USD to
 * EUR. A spike in those units is a real thing to detect and it is not this signal.
 *
 * ## THE FOUR THINGS THAT KEEP THE SIGNAL FROM BEING NOISE
 *
 * Taken from the spend half deliberately, so the two behave the same way:
 *
 *  1. **The baseline excludes the current day**, so a spike cannot raise the
 *     baseline it is measured against.
 *  2. **A minimum number of observed days** ({@link MINIMUM_TOKEN_BASELINE_DAYS}).
 *     A new account's first real hour is "infinitely above" a one-day history, and
 *     flagging every new customer is how an alert channel becomes something people
 *     mute.
 *  3. **A zero median is excluded.** Every multiple of zero is exceeded, so an
 *     account idle for a fortnight that then sent one token would otherwise be the
 *     platform's most anomalous account.
 *  4. **No currency dimension**, because a token count has none. This is the one
 *     place the shape legitimately differs from the spend half.
 *
 * ## THE MULTIPLE IS CONFIGURED, WITH A DOCUMENTED DEFAULT
 *
 * `INFERENCE_TOKEN_ANOMALY_MULTIPLE`, default
 * {@link DEFAULT_TOKEN_ANOMALY_MULTIPLE}. An hour is a twenty-fourth of a day, so
 * "an hour above 3x a normal DAY" is roughly seventy times the account's usual
 * hourly rate — deliberately far out, because the first version of a signal nobody
 * trusts is a signal nobody reads. It matches the spend half's default so the two
 * are comparable, and the value in force is written onto every row so tightening
 * it later does not make the old rows unreadable.
 */

import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { getDb } from '../config/postgres';
import { inferenceTokenAnomalies } from '../db/schema/inferenceTokenAnomalies';
import { logger } from '../utils/logger';

/** `INFERENCE_TOKEN_ANOMALY_MULTIPLE` — how far above the daily median is odd. */
export const TOKEN_ANOMALY_MULTIPLE_VARIABLE = 'INFERENCE_TOKEN_ANOMALY_MULTIPLE';

/** See "THE MULTIPLE IS CONFIGURED" in the header for where 3 comes from. */
export const DEFAULT_TOKEN_ANOMALY_MULTIPLE = 3;

/**
 * Days of history the baseline needs before an account can be flagged.
 *
 * Seven, so a median is taken over at least a full week and a weekday/weekend
 * pattern cannot be the whole sample. Below this an account is simply not
 * evaluated — a silence about a new customer, not a clean bill.
 */
export const MINIMUM_TOKEN_BASELINE_DAYS = 7;

/** How far back the daily baseline reaches. */
export const TOKEN_BASELINE_WINDOW_DAYS = 14;

/** How often the sweep runs. */
export const TOKEN_ANOMALY_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * The four token unit columns, as a SQL sum.
 *
 * Written once and used by both halves of the comparison, so the hour and the
 * baseline can never be computed over different unit sets — which would make every
 * ratio wrong in a way no test on either side alone would catch. The column names
 * are identical on both tables (`usageUnitColumns()` spreads the same definition
 * into each), which is what lets one expression serve both.
 */
const TOKEN_UNIT_SUM = sql.raw(
  'coalesce(sum(input_tokens + cached_input_tokens + output_tokens + reasoning_tokens), 0)'
);

/**
 * The configured multiple, or the default.
 *
 * A value that is not a number above 1 falls back to the default and is reported
 * once — the same stance `config/rolloutFlags.ts` and the spend half take, for the
 * same reason: a typo in a threshold must not disable the detector in silence, and
 * it must not be readable as `0` either, which would flag every account.
 */
export function resolveTokenAnomalyMultiple(): number {
  const configured = process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE]?.trim();
  if (configured === undefined || configured.length === 0) return DEFAULT_TOKEN_ANOMALY_MULTIPLE;

  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 1) {
    reportUnreadableMultiple(configured);
    return DEFAULT_TOKEN_ANOMALY_MULTIPLE;
  }
  return parsed;
}

/** Reported once per distinct bad value, not once per sweep. */
const reportedMultiples = new Set<string>();

function reportUnreadableMultiple(value: string): void {
  if (reportedMultiples.has(value)) return;
  reportedMultiples.add(value);
  logger.error(
    'inference.tokens.anomaly_multiple_unreadable',
    new Error(
      `${TOKEN_ANOMALY_MULTIPLE_VARIABLE} is not a number above 1; the default multiple applies`
    ),
    { component: 'tokenAnomaly', expected: 'a number greater than 1, e.g. 3' }
  );
}

/** Test-only reset, so a suite can assert the report fires for its own value. */
export function forgetReportedTokenAnomalyMultiples(): void {
  reportedMultiples.clear();
}

/** One account-hour whose token consumption exceeded its own baseline. */
export interface TokenAnomaly {
  readonly accountId: string;
  /** The truncated UTC hour, as an instant. */
  readonly detectedForHour: Date;
  readonly hourTokens: number;
  readonly baselineMedianTokens: number;
  readonly thresholdMultiple: number;
  readonly observedDays: number;
}

export interface TokenAnomalySweepResult {
  /** Every anomaly the pass observed, whether or not its row was new. */
  readonly detected: readonly TokenAnomaly[];
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
 * The two token totals are STRINGS: `postgres.js` decodes `bigint` as text, and
 * drizzle's `mode: 'number'` is applied by the RESULT MAPPER, which a raw read
 * bypasses. Typing them `number` compiles cleanly and then hands
 * `'12000' > '4000'` — a STRING comparison — to any arithmetic downstream, so they
 * are converted once, deliberately, by {@link toTokenCount}.
 *
 * `detected_for_hour` is `string | Date` for the same bypassed-mapper reason: it
 * arrives as a string, and typing it `Date` compiles and then throws
 * `toISOString is not a function` at the insert.
 */
type TokenAnomalyRow = {
  account_id: string;
  detected_for_hour: string | Date;
  hour_tokens: string;
  baseline_median_tokens: string;
  observed_days: number;
  [key: string]: unknown;
};

/** A token total from a raw `bigint` read. Throws rather than yielding `NaN`. */
function toTokenCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative token count from SQL, received ${value}`);
  }
  return parsed;
}

/** Normalise a raw-read timestamp. See {@link TokenAnomalyRow}. */
function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Find every account whose last complete hour of tokens exceeded its baseline.
 *
 * One statement, three CTEs, and every filter is IN the statement rather than in a
 * loop over accounts: an account-at-a-time detector costs a query per customer per
 * sweep, and the whole computation is two grouped index scans —
 * `inference_usage_events_account_id_created_at_idx` for the hour and
 * `inference_usage_daily_rollups_account_id_day_idx` for the baseline.
 *
 * `percentile_disc` rather than `percentile_cont` — the discrete form returns a
 * real observed day and keeps the value an integer, where the continuous form
 * interpolates and returns `double precision`, putting a float where a count of
 * discrete things belongs.
 */
export async function detectTokenAnomalies(
  thresholdMultiple: number = resolveTokenAnomalyMultiple()
): Promise<readonly TokenAnomaly[]> {
  const rows = await executeRows<TokenAnomalyRow>(
    getDb(),
    sql`
      with recent as (
        select
          account_id,
          date_trunc('hour', now()) - interval '1 hour' as detected_for_hour,
          ${TOKEN_UNIT_SUM} as hour_tokens
        from inference_usage_events
        where created_at >= date_trunc('hour', now()) - interval '1 hour'
          and created_at < date_trunc('hour', now())
        group by account_id
      ),
      daily as (
        select
          account_id,
          day,
          ${TOKEN_UNIT_SUM} as day_tokens
        from inference_usage_daily_rollups
        where day >= (date_trunc('day', now()) - (${TOKEN_BASELINE_WINDOW_DAYS}::int * interval '1 day'))::date
          and day < date_trunc('day', now())::date
        group by account_id, day
      ),
      baseline as (
        select
          account_id,
          percentile_disc(0.5) within group (order by day_tokens) as baseline_median_tokens,
          count(*)::int as observed_days
        from daily
        group by account_id
      )
      select
        recent.account_id,
        recent.detected_for_hour,
        recent.hour_tokens::text as hour_tokens,
        baseline.baseline_median_tokens::text as baseline_median_tokens,
        baseline.observed_days
      from recent
      join baseline on baseline.account_id = recent.account_id
      where baseline.observed_days >= ${MINIMUM_TOKEN_BASELINE_DAYS}::int
        and baseline.baseline_median_tokens > 0
        -- The multiple is bound as TEXT and cast to numeric, never as a float: a
        -- float8 parameter reintroduces binary rounding on the one comparison the
        -- whole signal turns on.
        and recent.hour_tokens
              > baseline.baseline_median_tokens * ${String(thresholdMultiple)}::numeric
      order by recent.account_id
    `
  );

  return rows.map((row) => ({
    accountId: row.account_id,
    detectedForHour: toDate(row.detected_for_hour),
    hourTokens: toTokenCount(row.hour_tokens),
    baselineMedianTokens: toTokenCount(row.baseline_median_tokens),
    thresholdMultiple,
    observedDays: row.observed_days,
  }));
}

/**
 * Detect, record and report. The whole control, in one call.
 *
 * The insert is `ON CONFLICT DO NOTHING RETURNING`, never catch-the-duplicate: a
 * `catch` cannot tell a repeated observation from a dropped connection, and the
 * sweep re-reads the same hour several times by design. `recorded` counts the rows
 * that were genuinely new, which is what makes "the same spike four times"
 * distinguishable from "four spikes".
 *
 * The log line is emitted for a NEW row only, so an alert channel wired to
 * `inference.tokens.anomaly` fires once per spike rather than once per sweep. It
 * carries ids and counts and nothing else — no prompt, no response, no IP.
 */
export async function sweepTokenAnomalies(): Promise<TokenAnomalySweepResult> {
  const thresholdMultiple = resolveTokenAnomalyMultiple();
  const detected = await detectTokenAnomalies(thresholdMultiple);
  if (detected.length === 0) {
    return { detected, recorded: 0, thresholdMultiple };
  }

  let recorded = 0;
  for (const anomaly of detected) {
    // The drizzle builder, not a raw `sql` insert: `id` comes from the schema's
    // `generatedId()` default, which is applied by the BUILDER and not by the
    // database, so a raw insert omitting the column fails its NOT NULL.
    const inserted = await getDb()
      .insert(inferenceTokenAnomalies)
      .values({
        accountId: anomaly.accountId,
        detectedForHour: anomaly.detectedForHour,
        hourTokens: anomaly.hourTokens,
        baselineMedianTokens: anomaly.baselineMedianTokens,
        thresholdMultiple: anomaly.thresholdMultiple,
        observedDays: anomaly.observedDays,
      })
      .onConflictDoNothing({
        target: [inferenceTokenAnomalies.accountId, inferenceTokenAnomalies.detectedForHour],
      })
      .returning({ id: inferenceTokenAnomalies.id });
    if (inserted.length === 0) continue;

    recorded += 1;
    logger.warn('inference.tokens.anomaly', {
      component: 'tokenAnomaly',
      accountId: anomaly.accountId,
      detectedForHour: anomaly.detectedForHour.toISOString(),
      hourTokens: anomaly.hourTokens,
      baselineMedianTokens: anomaly.baselineMedianTokens,
      thresholdMultiple: anomaly.thresholdMultiple,
      observedDays: anomaly.observedDays,
    });
  }

  return { detected, recorded, thresholdMultiple };
}
