/**
 * Sudden-spend detection, against a REAL Postgres (#972 sections 8 and 12).
 *
 * ## Every case is a pair, because "no anomaly" is the default answer
 *
 * The detector's normal output is an empty array. A test that only asserted "the
 * spiking account is flagged" would pass against a detector that flagged
 * everything, and one that only asserted "the quiet account is not" would pass
 * against a detector that flagged nothing — which is what an unwired detector,
 * a broken query and a mistyped comparison all look like. So the two accounts are
 * seeded side by side in most cases below and the assertion is about WHICH of them
 * appears.
 *
 * ## The receipts are written directly
 *
 * `settle` stamps `settled_at` with `now()`, and this file needs receipts dated
 * days in the past to have a baseline at all. The rows are inserted with explicit
 * timestamps and the minimum column set the table requires — the ledger's own
 * arithmetic is tested where the ledger is; what is measured here is a query over
 * rows that exist.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { inferenceSpendAnomalies } from '../../db/schema/inferenceSpendAnomalies';
import { priceVersions } from '../../db/schema/priceVersions';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { users } from '../../db/schema/users';
import {
  DEFAULT_ANOMALY_MULTIPLE,
  detectSpendAnomalies,
  forgetReportedAnomalyMultiples,
  MINIMUM_BASELINE_DAYS,
  resolveAnomalyMultiple,
  SPEND_ANOMALY_MULTIPLE_VARIABLE,
  sweepSpendAnomalies,
} from '../spendAnomaly.service';

jest.setTimeout(60_000);

const ORIGINAL_MULTIPLE = process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE];

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  if (ORIGINAL_MULTIPLE === undefined) delete process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE];
  else process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE] = ORIGINAL_MULTIPLE;
  await closePostgres();
});

beforeEach(() => {
  delete process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE];
  forgetReportedAnomalyMultiples();
});

function tag(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Spender {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly priceVersionId: string;
}

async function seedSpender(): Promise<Spender> {
  const suffix = tag();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `anom-${suffix}` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Anomaly ${suffix}`, ownerAccountId: account.id })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: 'test',
      publicKey: `oxy_dk_${randomUUID().replace(/-/g, '')}`,
      type: 'service',
      environment: 'production',
    })
    .returning({ id: applicationCredentials.id });
  const [version] = await getDb()
    .insert(priceVersions)
    .values({
      modelReference: `oxy/anom-${suffix}`,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(Date.now() - DAY_MS),
    })
    .returning({ id: priceVersions.id });

  return {
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
    priceVersionId: version.id,
  };
}

/** One settled charge, at a chosen instant and amount. */
async function seedReceipt(spender: Spender, settledAt: Date, amount: string): Promise<void> {
  await getDb().insert(usageReceipts).values({
    idempotencyKey: `anom-${randomUUID()}`,
    accountId: spender.accountId,
    applicationId: spender.applicationId,
    applicationCredentialId: spender.credentialId,
    requestId: `req-${randomUUID()}`,
    environment: 'production',
    outcome: 'completed',
    usageSource: 'provider_reported',
    inputTokens: 1_000,
    resolvedModelReference: 'oxy/anom',
    servingProvider: 'oxy-hosted',
    priceVersionId: spender.priceVersionId,
    billedAmount: amount,
    currency: 'USD',
    settledAt,
  });
}

/**
 * A steady daily history, one receipt per day, ending yesterday.
 *
 * `MINIMUM_BASELINE_DAYS + 1` days so the account clears the minimum with a day
 * to spare — a fixture sitting exactly on a boundary is one off-by-one from
 * measuring the boundary instead of the thing.
 */
async function seedBaseline(spender: Spender, dailyAmount: string): Promise<void> {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  for (let day = 1; day <= MINIMUM_BASELINE_DAYS + 1; day += 1) {
    // Midday of each past day, so no row lands on a boundary the query truncates.
    await seedReceipt(spender, new Date(midnight.getTime() - day * DAY_MS + 12 * HOUR_MS), dailyAmount);
  }
}

/** An instant inside the hour the detector reads: the last COMPLETE hour. */
function insideLastCompleteHour(): Date {
  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  return new Date(hour.getTime() - HOUR_MS + 30 * 60 * 1000);
}

describe('the configured multiple', () => {
  it('defaults, and takes a number above 1', () => {
    expect(resolveAnomalyMultiple()).toBe(DEFAULT_ANOMALY_MULTIPLE);

    process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE] = '5.5';
    expect(resolveAnomalyMultiple()).toBe(5.5);
  });

  it.each([['nonsense'], ['0'], ['1'], ['-4'], ['NaN']])(
    'falls back to the default on %s rather than flagging everybody',
    (value) => {
      process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE] = value;
      // A multiple of 0 or 1 would flag an account for spending a normal amount,
      // which is how an alert channel becomes noise nobody reads.
      expect(resolveAnomalyMultiple()).toBe(DEFAULT_ANOMALY_MULTIPLE);
    }
  );
});

describe('an hour above the account’s own daily median', () => {
  it('flags the spiking account and not the steady one beside it', async () => {
    const spiking = await seedSpender();
    const steady = await seedSpender();
    await Promise.all([seedBaseline(spiking, '1.000000000000'), seedBaseline(steady, '1.000000000000')]);

    // One hour, ten times a normal DAY.
    await seedReceipt(spiking, insideLastCompleteHour(), '10.000000000000');
    // And the control: the steady account also spent in that hour, at its usual
    // rate. Without this, "the steady account is absent" would be true of an
    // account that simply had no traffic.
    await seedReceipt(steady, insideLastCompleteHour(), '0.500000000000');

    const detected = await detectSpendAnomalies();
    const flagged = detected.map((anomaly) => anomaly.accountId);
    expect(flagged).toContain(spiking.accountId);
    expect(flagged).not.toContain(steady.accountId);

    const anomaly = detected.find((row) => row.accountId === spiking.accountId);
    expect(anomaly).toBeDefined();
    // Exact decimal strings on both sides, never floats.
    expect(anomaly?.hourAmount).toBe('10.000000000000');
    expect(anomaly?.baselineMedianAmount).toBe('1.000000000000');
    expect(anomaly?.currency).toBe('USD');
    expect(anomaly?.thresholdMultiple).toBe(DEFAULT_ANOMALY_MULTIPLE);
    expect(anomaly?.observedDays).toBe(MINIMUM_BASELINE_DAYS + 1);
  });

  it('does not flag an account with too little history, however large the hour', async () => {
    const fresh = await seedSpender();
    // Two days of history — real spend, and nowhere near the minimum.
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    await seedReceipt(fresh, new Date(midnight.getTime() - DAY_MS + 12 * HOUR_MS), '1.000000000000');
    await seedReceipt(fresh, new Date(midnight.getTime() - 2 * DAY_MS + 12 * HOUR_MS), '1.000000000000');
    await seedReceipt(fresh, insideLastCompleteHour(), '500.000000000000');

    const detected = await detectSpendAnomalies();
    expect(detected.map((anomaly) => anomaly.accountId)).not.toContain(fresh.accountId);

    // CONTROL: the SAME hourly figure against a full baseline IS flagged, so the
    // silence above is the history requirement and not a broken query.
    const established = await seedSpender();
    await seedBaseline(established, '1.000000000000');
    await seedReceipt(established, insideLastCompleteHour(), '500.000000000000');
    const second = await detectSpendAnomalies();
    expect(second.map((anomaly) => anomaly.accountId)).toContain(established.accountId);
  });

  it('does not flag an account whose baseline is zero', async () => {
    const dormant = await seedSpender();
    // A full history of zero-amount receipts — a real row set, a zero median.
    // Every multiple of zero is exceeded, so without the filter this account is
    // the most anomalous on the platform for spending one cent.
    await seedBaseline(dormant, '0.000000000000');
    await seedReceipt(dormant, insideLastCompleteHour(), '0.010000000000');

    const detected = await detectSpendAnomalies();
    expect(detected.map((anomaly) => anomaly.accountId)).not.toContain(dormant.accountId);
  });

  it('respects the configured multiple in both directions', async () => {
    const spender = await seedSpender();
    await seedBaseline(spender, '1.000000000000');
    // Exactly 4× a normal day.
    await seedReceipt(spender, insideLastCompleteHour(), '4.000000000000');

    process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE] = '10';
    const strict = await detectSpendAnomalies();
    expect(strict.map((anomaly) => anomaly.accountId)).not.toContain(spender.accountId);

    process.env[SPEND_ANOMALY_MULTIPLE_VARIABLE] = '2';
    const loose = await detectSpendAnomalies();
    expect(loose.map((anomaly) => anomaly.accountId)).toContain(spender.accountId);
    expect(loose.find((anomaly) => anomaly.accountId === spender.accountId)?.thresholdMultiple).toBe(2);
  });
});

describe('the sweep records once per spike and never blocks', () => {
  it('writes a row the first time and nothing the second', async () => {
    const spender = await seedSpender();
    await seedBaseline(spender, '1.000000000000');
    await seedReceipt(spender, insideLastCompleteHour(), '20.000000000000');

    const first = await sweepSpendAnomalies();
    expect(first.detected.map((anomaly) => anomaly.accountId)).toContain(spender.accountId);
    expect(first.recorded).toBeGreaterThan(0);

    const rows = await getDb()
      .select()
      .from(inferenceSpendAnomalies)
      .where(eq(inferenceSpendAnomalies.accountId, spender.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0].hourAmount).toBe('20.000000000000');
    expect(rows[0].thresholdMultiple).toBe(DEFAULT_ANOMALY_MULTIPLE);

    // The same spike, observed again. The sweep re-reads the same hour by design,
    // so a second row here would make "how many anomalies" a question about the
    // sweep interval.
    const second = await sweepSpendAnomalies();
    expect(second.detected.map((anomaly) => anomaly.accountId)).toContain(spender.accountId);
    const after = await getDb()
      .select()
      .from(inferenceSpendAnomalies)
      .where(eq(inferenceSpendAnomalies.accountId, spender.accountId));
    expect(after).toHaveLength(1);
  });

  it('records nothing at all when nobody spiked', async () => {
    const steady = await seedSpender();
    await seedBaseline(steady, '1.000000000000');
    await seedReceipt(steady, insideLastCompleteHour(), '0.100000000000');

    await sweepSpendAnomalies();
    const rows = await getDb()
      .select()
      .from(inferenceSpendAnomalies)
      .where(eq(inferenceSpendAnomalies.accountId, steady.accountId));
    expect(rows).toEqual([]);
  });
});
