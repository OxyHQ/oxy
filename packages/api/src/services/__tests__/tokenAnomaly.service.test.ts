/**
 * Sudden-TOKEN detection, against a REAL Postgres (#972 section 8).
 *
 * ## Every case is a pair, because "no anomaly" is the default answer
 *
 * The detector's normal output is an empty array. A test that only asserted "the
 * spiking account is flagged" would pass against a detector that flagged
 * everything, and one that only asserted "the quiet account is not" would pass
 * against a detector that flagged nothing — which is what an unwired detector, a
 * broken query and an inverted comparison all look like. So two accounts are seeded
 * side by side and the assertion is about WHICH of them appears.
 *
 * ## The two sides of the comparison come from two tables, on purpose
 *
 * The hour is read from `inference_usage_events` — the only one of the two with an
 * hour in it — and the baseline from `inference_usage_daily_rollups`, which is the
 * durable side. That split is a real seam and it is what this file has to exercise:
 * a fixture that seeded only one of them would leave the detector unable to
 * compare, and a query that read the wrong table for either half would still be
 * green against a fixture that filled both identically. So the spike is written to
 * the EVENTS table only and the baseline to the ROLLUP only, which is also how
 * production writes them (`recordInferenceUsage` writes both, in one transaction,
 * from the same request).
 *
 * ## Rows are written directly
 *
 * `recordInferenceUsage` stamps the current instant, and this file needs rows dated
 * days in the past to have a baseline at all. The telemetry service's own
 * arithmetic is tested where that service is; what is measured here is a query over
 * rows that exist.
 *
 * ## And it never blocks
 *
 * Asserted explicitly, because "does not block" is the property most likely to be
 * quietly lost: nothing in the serving path reads this table, so a spike must leave
 * the account's ability to be served untouched.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { inferenceTokenAnomalies } from '../../db/schema/inferenceTokenAnomalies';
import { inferenceUsageDailyRollups } from '../../db/schema/inferenceUsageDailyRollups';
import { inferenceUsageEvents } from '../../db/schema/inferenceUsageEvents';
import { users } from '../../db/schema/users';
import {
  DEFAULT_TOKEN_ANOMALY_MULTIPLE,
  detectTokenAnomalies,
  forgetReportedTokenAnomalyMultiples,
  MINIMUM_TOKEN_BASELINE_DAYS,
  resolveTokenAnomalyMultiple,
  sweepTokenAnomalies,
  TOKEN_ANOMALY_MULTIPLE_VARIABLE,
} from '../tokenAnomaly.service';

jest.setTimeout(60_000);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ORIGINAL_MULTIPLE = process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE];

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  if (ORIGINAL_MULTIPLE === undefined) delete process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE];
  else process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE] = ORIGINAL_MULTIPLE;
  await closePostgres();
});

beforeEach(() => {
  delete process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE];
  forgetReportedTokenAnomalyMultiples();
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function tag(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

interface Consumer {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
}

async function seedConsumer(): Promise<Consumer> {
  const suffix = tag();
  const db = getDb();
  const [account] = await db
    .insert(users)
    .values({ username: `tok-${suffix}`, email: `tok-${suffix}@example.test` })
    .returning({ id: users.id });
  const [application] = await db
    .insert(applications)
    .values({ name: `Tok ${suffix}`, ownerAccountId: account.id })
    .returning({ id: applications.id });
  const [credential] = await db
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: 'test',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  return {
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
  };
}

/**
 * One usage EVENT at an explicit instant — the hour side of the comparison.
 *
 * Written to `inference_usage_events` only, never the rollup, so a detector that
 * read the wrong table for the current hour would find nothing.
 */
async function seedEvent(
  consumer: Consumer,
  createdAt: Date,
  tokens: { input?: number; cachedInput?: number; output?: number; reasoning?: number }
): Promise<void> {
  await getDb()
    .insert(inferenceUsageEvents)
    .values({
      accountId: consumer.accountId,
      applicationId: consumer.applicationId,
      applicationCredentialId: consumer.credentialId,
      requestId: `req-${randomUUID()}`,
      environment: 'production',
      endpoint: '/v1/responses',
      statusCode: 200,
      outcome: 'completed',
      requestedModelReference: 'oxy/tok',
      resolvedModelReference: 'oxy/tok@2026-08-01',
      servingProvider: 'oxy-hosted',
      usageSource: 'provider_reported',
      inputTokens: tokens.input ?? 0,
      cachedInputTokens: tokens.cachedInput ?? 0,
      outputTokens: tokens.output ?? 0,
      reasoningTokens: tokens.reasoning ?? 0,
      createdAt,
    });
}

/**
 * One ROLLUP day — the baseline side of the comparison.
 *
 * Written to `inference_usage_daily_rollups` only. The primary key includes the
 * day, so one row per day per consumer is exactly what production would hold.
 */
async function seedRollupDay(
  consumer: Consumer,
  day: Date,
  tokens: { input?: number; output?: number }
): Promise<void> {
  await getDb()
    .insert(inferenceUsageDailyRollups)
    .values({
      day: day.toISOString().slice(0, 10),
      accountId: consumer.accountId,
      applicationId: consumer.applicationId,
      applicationCredentialId: consumer.credentialId,
      environment: 'production',
      requestedModelReference: 'oxy/tok',
      servingProvider: 'oxy-hosted',
      outcome: 'completed',
      requestCount: 1,
      errorCount: 0,
      inputTokens: tokens.input ?? 0,
      outputTokens: tokens.output ?? 0,
    });
}

/** A flat daily history of `dailyTokens`, long enough to clear the minimum. */
async function seedBaseline(consumer: Consumer, dailyTokens: number): Promise<void> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  for (let day = 1; day <= MINIMUM_TOKEN_BASELINE_DAYS + 1; day += 1) {
    await seedRollupDay(consumer, new Date(midnight.getTime() - day * DAY_MS), {
      input: dailyTokens,
    });
  }
}

/** An instant inside the hour the detector reads: the last COMPLETE hour. */
function insideLastCompleteHour(): Date {
  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  return new Date(hour.getTime() - HOUR_MS + 30 * 60 * 1000);
}

/** This account's anomalies only, so a sibling suite cannot move the answer. */
async function anomaliesFor(accountId: string) {
  return getDb()
    .select()
    .from(inferenceTokenAnomalies)
    .where(eq(inferenceTokenAnomalies.accountId, accountId));
}

/* -------------------------------------------------------------------------- */
/*  The configured multiple                                                   */
/* -------------------------------------------------------------------------- */

describe('the configured multiple', () => {
  it('defaults, and takes a number above 1', () => {
    expect(resolveTokenAnomalyMultiple()).toBe(DEFAULT_TOKEN_ANOMALY_MULTIPLE);

    process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE] = '5.5';
    expect(resolveTokenAnomalyMultiple()).toBe(5.5);
  });

  it.each([['nonsense'], ['0'], ['1'], ['-4'], ['NaN'], ['']])(
    'falls back to the default on %p rather than flagging everybody',
    (value) => {
      process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE] = value;
      // A multiple of 0 or 1 flags an account for using a normal number of tokens,
      // which is how an alert channel becomes noise nobody reads. A typo must not
      // disable the detector silently either — hence the default, not a throw.
      expect(resolveTokenAnomalyMultiple()).toBe(DEFAULT_TOKEN_ANOMALY_MULTIPLE);
    }
  );

  it('matches the spend half, so the two signals are comparable', () => {
    // Not a coincidence to be tidied away: an operator reading both endpoints is
    // comparing two ratios, and different thresholds would make that comparison
    // wrong without saying so.
    expect(DEFAULT_TOKEN_ANOMALY_MULTIPLE).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  The signal                                                                */
/* -------------------------------------------------------------------------- */

describe('an hour above the account’s own daily median', () => {
  it('flags the spiking account and NOT the flat one', async () => {
    const spiking = await seedConsumer();
    const flat = await seedConsumer();

    // Both have the same fortnight of history: 1,000 tokens a day.
    await seedBaseline(spiking, 1_000);
    await seedBaseline(flat, 1_000);

    const hour = insideLastCompleteHour();
    // The spike: 10,000 in one hour against a 1,000-token daily median — 10x.
    await seedEvent(spiking, hour, { input: 6_000, output: 4_000 });
    // The CONTROL, in the same hour: a normal 100 tokens, well under 3x.
    await seedEvent(flat, hour, { input: 100 });

    const detected = await detectTokenAnomalies();
    const accounts = detected.map((anomaly) => anomaly.accountId);

    // WHICH of the two, not merely that something was found.
    expect(accounts).toContain(spiking.accountId);
    expect(accounts).not.toContain(flat.accountId);

    const anomaly = detected.find((entry) => entry.accountId === spiking.accountId);
    expect(anomaly).toBeDefined();
    if (anomaly === undefined) return;
    // Numbers, not strings: `postgres.js` decodes `bigint` as text and a raw read
    // bypasses drizzle's mapper, so `'10000' > '1000'` would be a STRING compare.
    expect(anomaly.hourTokens).toBe(10_000);
    expect(anomaly.baselineMedianTokens).toBe(1_000);
    expect(typeof anomaly.hourTokens).toBe('number');
    expect(anomaly.thresholdMultiple).toBe(DEFAULT_TOKEN_ANOMALY_MULTIPLE);
    expect(anomaly.observedDays).toBe(MINIMUM_TOKEN_BASELINE_DAYS + 1);
  });

  it('sums all four token units, and only those four', async () => {
    const consumer = await seedConsumer();
    await seedBaseline(consumer, 1_000);

    // 1,000 of each of the four token kinds = 4,000, which is above 3x.
    await seedEvent(consumer, insideLastCompleteHour(), {
      input: 1_000,
      cachedInput: 1_000,
      output: 1_000,
      reasoning: 1_000,
    });

    const detected = await detectTokenAnomalies();
    const anomaly = detected.find((entry) => entry.accountId === consumer.accountId);
    expect(anomaly).toBeDefined();
    // Exactly 4,000 — so cached and reasoning tokens are counted as siblings of
    // input and output rather than dropped, and nothing else crept into the sum.
    expect(anomaly?.hourTokens).toBe(4_000);
  });

  it('does NOT flag an account whose history is too short', async () => {
    const consumer = await seedConsumer();
    // One day below the minimum. A new account's first real hour is "infinitely
    // above" a short history, and flagging every new customer is how the channel
    // becomes something people mute.
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    for (let day = 1; day <= MINIMUM_TOKEN_BASELINE_DAYS - 1; day += 1) {
      await seedRollupDay(consumer, new Date(midnight.getTime() - day * DAY_MS), { input: 1_000 });
    }
    await seedEvent(consumer, insideLastCompleteHour(), { input: 50_000 });

    const detected = await detectTokenAnomalies();
    expect(detected.map((entry) => entry.accountId)).not.toContain(consumer.accountId);

    // The pair: one more day of history and the SAME spike is flagged. Without
    // this, "not flagged" is also what a detector reading no rows at all reports.
    await seedRollupDay(consumer, new Date(midnight.getTime() - MINIMUM_TOKEN_BASELINE_DAYS * DAY_MS), {
      input: 1_000,
    });
    const after = await detectTokenAnomalies();
    expect(after.map((entry) => entry.accountId)).toContain(consumer.accountId);
  });

  it('does NOT flag an account whose baseline is zero', async () => {
    const consumer = await seedConsumer();
    // A fortnight of days that recorded requests and no tokens — an embeddings-only
    // or refusal-only history. Every multiple of zero is exceeded, so without the
    // filter this account is the platform's most anomalous.
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    for (let day = 1; day <= MINIMUM_TOKEN_BASELINE_DAYS + 1; day += 1) {
      await seedRollupDay(consumer, new Date(midnight.getTime() - day * DAY_MS), { input: 0 });
    }
    await seedEvent(consumer, insideLastCompleteHour(), { input: 5_000 });

    const detected = await detectTokenAnomalies();
    expect(detected.map((entry) => entry.accountId)).not.toContain(consumer.accountId);
  });

  it('reads the last COMPLETE hour, not the one still filling', async () => {
    const consumer = await seedConsumer();
    await seedBaseline(consumer, 1_000);
    // A spike in the CURRENT hour, which is still accumulating. Reading it would
    // compare a partial hour against a full day and fire early on a busy minute.
    await seedEvent(consumer, new Date(), { input: 50_000 });

    const detected = await detectTokenAnomalies();
    expect(detected.map((entry) => entry.accountId)).not.toContain(consumer.accountId);

    // The pair: the same spike in the previous hour IS read.
    await seedEvent(consumer, insideLastCompleteHour(), { input: 50_000 });
    const after = await detectTokenAnomalies();
    expect(after.map((entry) => entry.accountId)).toContain(consumer.accountId);
  });

  it('excludes the current day from the baseline it compares against', async () => {
    const consumer = await seedConsumer();
    await seedBaseline(consumer, 1_000);
    // TODAY's rollup carries the spike itself. If the baseline included it, a big
    // enough spike would raise the median it is measured against and hide itself.
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    await seedRollupDay(consumer, midnight, { input: 100_000 });
    await seedEvent(consumer, insideLastCompleteHour(), { input: 10_000 });

    const detected = await detectTokenAnomalies();
    const anomaly = detected.find((entry) => entry.accountId === consumer.accountId);
    expect(anomaly).toBeDefined();

    /*
     * `observedDays` is what carries this claim, and the median CANNOT — measured.
     * A mutation widening the window to `day <= today` left every test in this file
     * green, because `percentile_disc` over eight flat days plus one outlier still
     * selects a flat day: a median is robust to exactly the contamination this test
     * is about. The day COUNT is not.
     */
    expect(anomaly?.observedDays).toBe(MINIMUM_TOKEN_BASELINE_DAYS + 1);
    // Still 1,000 — true, and kept as the statement of intent, but it is the count
    // above that would go red if today's row were admitted.
    expect(anomaly?.baselineMedianTokens).toBe(1_000);
  });
});

/* -------------------------------------------------------------------------- */
/*  The sweep                                                                 */
/* -------------------------------------------------------------------------- */

describe('the sweep records once per spike and never blocks', () => {
  it('records a new row once, and a repeated observation not at all', async () => {
    const consumer = await seedConsumer();
    await seedBaseline(consumer, 1_000);
    await seedEvent(consumer, insideLastCompleteHour(), { input: 10_000 });

    /*
     * `recorded` is a PLATFORM-WIDE count — the sweep flags every spiking account,
     * including ones seeded by the cases above — so it cannot carry this claim.
     * Asserted per account instead, which is also what the claim actually is: one
     * row for one spike, however many other accounts spiked in the same hour.
     */
    const first = await sweepTokenAnomalies();
    expect(first.detected.map((entry) => entry.accountId)).toContain(consumer.accountId);
    expect(first.recorded).toBeGreaterThan(0);
    expect(await anomaliesFor(consumer.accountId)).toHaveLength(1);

    // The sweep re-reads the same hour every fifteen minutes by design. The second
    // pass must still DETECT it (so the signal is not lost) and add NO row (so "how
    // many anomalies" is not a question about the sweep interval).
    const second = await sweepTokenAnomalies();
    expect(second.detected.map((entry) => entry.accountId)).toContain(consumer.accountId);

    const rows = await anomaliesFor(consumer.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0].hourTokens).toBe(10_000);
    expect(rows[0].baselineMedianTokens).toBe(1_000);
    expect(rows[0].thresholdMultiple).toBe(DEFAULT_TOKEN_ANOMALY_MULTIPLE);
    expect(rows[0].observedDays).toBe(MINIMUM_TOKEN_BASELINE_DAYS + 1);
  });

  it('writes NOTHING for a flat account, and no row is the honest answer', async () => {
    const consumer = await seedConsumer();
    await seedBaseline(consumer, 1_000);
    await seedEvent(consumer, insideLastCompleteHour(), { input: 100 });

    const result = await sweepTokenAnomalies();
    expect(result.detected.map((entry) => entry.accountId)).not.toContain(consumer.accountId);
    expect(await anomaliesFor(consumer.accountId)).toHaveLength(0);
  });

  it('records the threshold that was in force, so an old row stays readable', async () => {
    const consumer = await seedConsumer();
    await seedBaseline(consumer, 1_000);
    // 4x the median: flagged at a threshold of 3, not at one of 5.
    await seedEvent(consumer, insideLastCompleteHour(), { input: 4_000 });

    // Per account, for the reason given above: `recorded` counts the platform.
    process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE] = '5';
    await sweepTokenAnomalies();
    expect(await anomaliesFor(consumer.accountId)).toHaveLength(0);

    process.env[TOKEN_ANOMALY_MULTIPLE_VARIABLE] = '3';
    await sweepTokenAnomalies();
    const rows = await anomaliesFor(consumer.accountId);
    expect(rows).toHaveLength(1);
    // The row says 3, not "anomalous": a reader cannot otherwise tell a 4x alert
    // under a 3x threshold from one that fired when the threshold was 2x.
    expect(rows[0].thresholdMultiple).toBe(3);
  });

  it('BLOCKS NOTHING: the account is untouched by having been flagged', async () => {
    const consumer = await seedConsumer();
    await seedBaseline(consumer, 1_000);
    await seedEvent(consumer, insideLastCompleteHour(), { input: 10_000 });
    await sweepTokenAnomalies();

    expect(await anomaliesFor(consumer.accountId)).toHaveLength(1);

    // Nothing on the serving path reads this table, and nothing about the account
    // changed. The customer's own control is `spending_limits`, which refuses
    // inside `reserve`; this signal says "somebody should look".
    const [application] = await getDb()
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, consumer.applicationId))
      .limit(1);
    expect(application.status).toBe('active');

    const [credential] = await getDb()
      .select({ status: applicationCredentials.status })
      .from(applicationCredentials)
      .where(
        and(
          eq(applicationCredentials.id, consumer.credentialId),
          eq(applicationCredentials.applicationId, consumer.applicationId)
        )
      )
      .limit(1);
    expect(credential.status).toBe('active');
  });
});
