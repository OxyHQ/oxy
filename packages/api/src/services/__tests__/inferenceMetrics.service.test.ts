/**
 * The workstream-16 operational metrics, against a REAL Postgres (issue #972).
 *
 * ## The test this file exists for
 *
 * **A metric that reads `0` when it means "unmeasurable" is the failure this
 * whole surface is written to avoid**, and it is invisible from the reading side:
 * `timeToFirstTokenMs: 0` and `timeToFirstTokenMs: { pending }` look the same in
 * a chart, and the first one is a lie a dashboard will act on. So every pending
 * assertion here is paired with a POSITIVE CONTROL that inserts a row carrying
 * the value and asserts the same field flips to `measured` — because "pending"
 * is also what a query pointed at the wrong window, the wrong account or an empty
 * table reports, and without the control this file would be measuring its own
 * blindness.
 *
 * The pending arm additionally has to distinguish two facts: `observedRows: 0`
 * (nothing happened) from `observedRows: 12, rowsCarryingValue: 0` (things
 * happened and none carried the value). Both are asserted, in the same window.
 *
 * ## Every row is written by the REAL writer where one exists
 *
 * Events and rollups go through `recordInferenceUsage`, receipts and holds
 * through `reserve`/`settle`. A hand-built row would let this file agree with
 * itself about a column the production writer never fills — which is exactly how
 * `latency_ms`, `time_to_first_token_ms` and `route_switches` came to be
 * declared, constrained and written by nothing.
 *
 * The one deliberate exception is BACKDATING: `settle` stamps `settled_at` at
 * `now` and the hold's `created_at` milliseconds earlier, so a settlement lag
 * driven purely by the real writers is unassertable. The pair is created for real
 * and then the hold's `created_at` is moved by a known amount, which is what makes
 * the lag a number this file can be wrong about.
 *
 * Fixtures are scoped to ids this file owns and every read is narrowed to them,
 * so a sibling suite seeding the shared database cannot move an aggregate here.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  KAANA_BASE_URL_VARIABLE,
  KAANA_SIGNING_KEY_ID_VARIABLE,
  KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
} from '../../config/kaanaDataPlane';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { KAANA_EXECUTION_VARIABLE } from '../../config/rolloutFlags';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  billingReconciliationDiscrepancies,
  billingReconciliationRuns,
} from '../../db/schema/billingReconciliation';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { usageReservations } from '../../db/schema/usageReservations';
import { users } from '../../db/schema/users';
import {
  provisionBillingProfile,
  recordTopUp,
  reserve,
  settle,
} from '../inferenceLedger.service';
import {
  readInferenceOperationalMetrics,
  type MetricsScope,
} from '../inferenceMetrics.service';
import { recordInferenceUsage, type RecordUsageInput } from '../inferenceTelemetry.service';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly priceVersionId: string;
}

/**
 * The window every assertion uses.
 *
 * Today in UTC on both ends, so a row written by this test lands inside it. The
 * rollup is keyed on a UTC `date` and the event stream on a `timestamptz`, and
 * this is the one value that addresses both.
 */
function today(): { from: string; to: string } {
  const day = new Date().toISOString().slice(0, 10);
  return { from: day, to: day };
}

async function makeFixture(options: { fund?: string } = {}): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const db = getDb();

  const [account] = await db
    .insert(users)
    .values({ username: `met-${tag}`, email: `met-${tag}@example.test` })
    .returning({ id: users.id });
  const [application] = await db
    .insert(applications)
    .values({ name: `Met ${tag}`, ownerAccountId: account.id })
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

  const [version] = await db
    .insert(priceVersions)
    .values({
      modelReference: `oxy/met-${tag}`,
      provider: 'oxy-hosted',
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });
  await db.insert(priceVersionUnitPrices).values([
    { priceVersionId: version.id, unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 },
    { priceVersionId: version.id, unit: 'output_tokens', amount: '15.000000000000', per: 1_000_000 },
  ]);

  await provisionBillingProfile({ accountId: account.id });
  if (options.fund !== undefined) {
    await recordTopUp({
      idempotencyKey: `met-fund-${tag}`,
      accountId: account.id,
      currency: 'USD',
      amount: options.fund,
      actor: { kind: 'machine' },
    });
  }

  return {
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
    priceVersionId: version.id,
  };
}

/** One telemetry row through the real writer. */
async function record(f: Fixture, overrides: Partial<RecordUsageInput> = {}): Promise<void> {
  const result = await recordInferenceUsage({
    accountId: f.accountId,
    applicationId: f.applicationId,
    applicationCredentialId: f.credentialId,
    requestId: `req-${randomUUID()}`,
    environment: 'production',
    endpoint: '/v1/responses',
    statusCode: 200,
    outcome: 'completed',
    requestedModelReference: 'oxy/met',
    resolvedModelReference: 'oxy/met@2026-08-01',
    servingProvider: 'oxy-hosted',
    usageSource: 'provider_reported',
    units: { input_tokens: 100, output_tokens: 20 },
    latencyMs: 350,
    ...overrides,
  });
  // A silently dropped fixture row would make every assertion below read as a
  // correct absence.
  if (result.status !== 'recorded') {
    throw new Error(`fixture telemetry was not recorded: ${result.status}`);
  }
}

function scopeOf(f: Fixture): MetricsScope {
  return { window: today(), accountId: f.accountId };
}

/* -------------------------------------------------------------------------- */
/*  Request, error and cancellation rates                                     */
/* -------------------------------------------------------------------------- */

describe('request, error and cancellation rates', () => {
  it('reports no-traffic as a STATE, never as a zero rate', async () => {
    const f = await makeFixture();
    const metrics = await readInferenceOperationalMetrics(scopeOf(f));

    // The distinction that matters: an error RATE over zero requests is
    // undefined, and `errorRateBps: 0` is the value that reads as "no errors".
    expect(metrics.requests).toEqual({
      state: 'pending',
      reason: 'no_requests_recorded',
      requestCount: 0,
    });
    expect(metrics.requests).not.toHaveProperty('errorRateBps');
  });

  it('counts requests, errors and cancellations from the rollup, with rates', async () => {
    const f = await makeFixture();
    // Four requests: two served, one 500, one cancelled.
    await record(f);
    await record(f);
    await record(f, { statusCode: 500, outcome: 'failed', units: {} });
    await record(f, { statusCode: 499, outcome: 'cancelled', units: {} });

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    expect(metrics.requests).toMatchObject({
      state: 'measured',
      requestCount: 4,
      // `error_count` is the rollup's own `status >= 400` counter, so the
      // cancellation at 499 counts as an error too — two of four.
      errorCount: 2,
      cancelledCount: 1,
      errorRateBps: 5000,
      cancellationRateBps: 2500,
    });
  });

  it('is scoped to the account asked about', async () => {
    const mine = await makeFixture();
    const theirs = await makeFixture();
    await record(mine);
    await record(theirs);
    await record(theirs);

    // The control for every other assertion in this file: if the scope leaked,
    // this would be 3.
    const metrics = await readInferenceOperationalMetrics(scopeOf(mine));
    expect(metrics.requests).toMatchObject({ state: 'measured', requestCount: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/*  Total latency — Oxy's own measurement                                     */
/* -------------------------------------------------------------------------- */

describe('total latency', () => {
  it('reports the distribution of the edge-measured latency, not the mean', async () => {
    const f = await makeFixture();
    for (const latencyMs of [10, 20, 30, 40, 1000]) {
      await record(f, { latencyMs });
    }

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    expect(metrics.totalLatencyMs).toMatchObject({
      state: 'measured',
      observedRows: 5,
      sampleCount: 5,
      p50Ms: 30,
      maxMs: 1000,
    });
    if (metrics.totalLatencyMs.state !== 'measured') throw new Error('expected a measurement');
    // The whole reason this is a distribution and not a mean: the outlier is
    // visible at p99 and would be buried by an average of 220.
    expect(metrics.totalLatencyMs.p99Ms).toBeGreaterThan(metrics.totalLatencyMs.p50Ms);
    expect(metrics.totalLatencyMs.p95Ms).toBeGreaterThanOrEqual(metrics.totalLatencyMs.p50Ms);
  });
});

/* -------------------------------------------------------------------------- */
/*  Time to first token — structurally pending                                */
/* -------------------------------------------------------------------------- */

describe('time to first token', () => {
  it('is PENDING with the reason when traffic exists and no row carries one', async () => {
    const f = await makeFixture();
    await record(f);
    await record(f);
    await record(f);

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    expect(metrics.timeToFirstTokenMs).toEqual({
      state: 'pending',
      // Not `no_requests_recorded`: three requests WERE recorded. And the reason
      // names the MEASURED absence rather than a cause — the edge streams and
      // forwards this figure when a report carries one, so "the edge cannot
      // produce it" would be a stale claim rather than an observation.
      reason: 'no_first_token_time_reported',
      observedRows: 3,
      rowsCarryingValue: 0,
    });
    expect(metrics.timeToFirstTokenMs).not.toHaveProperty('p50Ms');
    // The field that makes that pending READABLE: with no data plane configured,
    // nothing can have streamed, so this pending needs no investigation.
    expect(metrics.dataPlane).toBe('absent');
    expect(metrics.dataPlaneExecution.enabled).toBe(false);
  });

  it('distinguishes an empty window from a window whose rows carry no value', async () => {
    const f = await makeFixture();
    const metrics = await readInferenceOperationalMetrics(scopeOf(f));

    // Same `state`, different `reason` and `observedRows` from the case above —
    // which is what stops "pending" being one undifferentiated shrug.
    expect(metrics.timeToFirstTokenMs).toEqual({
      state: 'pending',
      reason: 'no_requests_recorded',
      observedRows: 0,
      rowsCarryingValue: 0,
    });
  });

  it('POSITIVE CONTROL: a row carrying a first-token time surfaces it', async () => {
    const f = await makeFixture();
    await record(f);
    await record(f, { timeToFirstTokenMs: 120 });
    await record(f, { timeToFirstTokenMs: 240 });

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    expect(metrics.timeToFirstTokenMs).toMatchObject({
      state: 'measured',
      // Three requests, two of which reported a first token. Both numbers are
      // asserted: `sampleCount === observedRows` would mean the NULL row was
      // counted as a sample of zero, which is the imputation this refuses.
      observedRows: 3,
      sampleCount: 2,
      p50Ms: 180,
      maxMs: 240,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Fallback — structurally pending                                           */
/* -------------------------------------------------------------------------- */

describe('fallback', () => {
  it('is PENDING when every row reports zero switches', async () => {
    const f = await makeFixture();
    await record(f);
    await record(f, { routeSwitches: 0 });

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    // `route_switches` is NOT NULL DEFAULT 0, so "reported no switch" and
    // "reported nothing" are the same stored value — a `count(column)` would
    // present all of these as samples of zero.
    expect(metrics.fallback).toEqual({
      state: 'pending',
      reason: 'no_route_switch_reported',
      observedRows: 2,
      rowsCarryingValue: 0,
    });
  });

  it('POSITIVE CONTROL: a reported switch surfaces it', async () => {
    const f = await makeFixture();
    await record(f);
    await record(f, { routeSwitches: 2 });

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    expect(metrics.fallback).toEqual({
      state: 'measured',
      observedRows: 2,
      requestsWithSwitch: 1,
      totalSwitches: 2,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Reserve failures                                                          */
/* -------------------------------------------------------------------------- */

describe('reserve failures', () => {
  it('counts the 402s and says where the two causes are told apart', async () => {
    const f = await makeFixture();
    await record(f);
    await record(f, { statusCode: 402, outcome: 'failed', units: {} });
    await record(f, { statusCode: 402, outcome: 'failed', units: {} });
    // A 500 is an error but not a reserve failure — the control that stops this
    // count being "every error".
    await record(f, { statusCode: 500, outcome: 'failed', units: {} });

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    expect(metrics.reserveFailures).toEqual({
      observedRows: 4,
      refusedRequests: 2,
      reasonsDistinguishableBy: 'inference.edge.reservation_refused log line',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Settlement lag                                                            */
/* -------------------------------------------------------------------------- */

describe('settlement lag', () => {
  /** A real hold and its real receipt, with the hold backdated by `lagMs`. */
  async function settledPair(f: Fixture, lagMs: number): Promise<void> {
    const attribution = {
      accountId: f.accountId,
      applicationId: f.applicationId,
      applicationCredentialId: f.credentialId,
      requestId: `req-${randomUUID()}`,
      environment: 'production' as const,
    };

    const held = await reserve({
      idempotencyKey: `met-r-${randomUUID()}`,
      attribution,
      ceilingPriceVersionId: f.priceVersionId,
      maxAmount: '1.000000000000',
      currency: 'USD',
      expiresInSeconds: 300,
    });
    if (held.status !== 'reserved') throw new Error(`reserve failed: ${held.status}`);

    // Backdated AFTER the hold exists, so what is measured is the join on
    // `reservation_id` and the subtraction — not a row this test invented.
    await getDb()
      .update(usageReservations)
      .set({ createdAt: new Date(Date.now() - lagMs) })
      .where(eq(usageReservations.id, held.reservation.reservationId));

    const settled = await settle({
      idempotencyKey: `met-s-${randomUUID()}`,
      reservationId: held.reservation.reservationId,
      attribution,
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 100, output_tokens: 20 },
      resolvedModelReference: 'oxy/met@2026-08-01',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error(`settle failed: ${settled.status}`);
  }

  it('measures the interval between the hold and the charge', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    await settledPair(f, 5_000);

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    expect(metrics.settlementLagMs).toMatchObject({ state: 'measured', sampleCount: 1 });
    if (metrics.settlementLagMs.state !== 'measured') throw new Error('expected a measurement');
    // Five seconds, allowing for the real time the pair took to be written. The
    // bounds are what make this falsifiable: a join that produced `settled_at`
    // minus `settled_at` would report ~0 and satisfy a bare `> 0`.
    expect(metrics.settlementLagMs.p50Ms).toBeGreaterThan(4_000);
    expect(metrics.settlementLagMs.p50Ms).toBeLessThan(60_000);
  });

  it('is PENDING for a window whose receipts were never held', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    // Shadow metering settles with no reservation, so there is no lag to measure.
    const settled = await settle({
      idempotencyKey: `met-shadow-${randomUUID()}`,
      attribution: {
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.credentialId,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
      },
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 100 },
      resolvedModelReference: 'oxy/met@2026-08-01',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error(`settle failed: ${settled.status}`);

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    // A receipt EXISTS — `observedRows` proves the query found it — and still no
    // lag is reported, rather than a zero.
    expect(metrics.settlementLagMs).toEqual({
      state: 'pending',
      reason: 'no_settled_reservation',
      observedRows: 1,
      rowsCarryingValue: 0,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Unmeasured settlements — the `estimated` index's first reader             */
/* -------------------------------------------------------------------------- */

describe('unmeasured settlements', () => {
  /** Settle with no hold, so the fixture needs no reservation. */
  async function settleWith(f: Fixture, usageSource: 'provider_reported' | 'estimated') {
    const settled = await settle({
      idempotencyKey: `met-um-${randomUUID()}`,
      attribution: {
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.credentialId,
        requestId: `req-${randomUUID()}`,
        environment: 'production',
      },
      // `failed`, so a zero-unit `estimated` settlement is the legitimate shape
      // this metric counts rather than the `completed` one the ledger refuses.
      outcome: 'failed',
      usageSource,
      units: usageSource === 'estimated' ? {} : { input_tokens: 10 },
      resolvedModelReference: 'oxy/met@2026-08-01',
      servingProvider: 'oxy-hosted',
      priceVersionId: f.priceVersionId,
    });
    if (settled.status !== 'settled') throw new Error(`settle failed: ${settled.status}`);
  }

  it('counts the estimated receipts and reports the denominator beside them', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    await settleWith(f, 'estimated');
    await settleWith(f, 'estimated');
    await settleWith(f, 'provider_reported');

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    // Two of three. The denominator is what stops a raw count reading as a rate,
    // and it is also the positive control: a query that found nothing would report
    // `settledReceipts: 0` here rather than 3.
    expect(metrics.unmeasuredSettlements).toMatchObject({
      receiptCount: 2,
      settledReceipts: 3,
    });
    expect(typeof metrics.unmeasuredSettlements.latestSettledAt).toBe('string');
  });

  it('omits the timestamp entirely when nothing is unmeasured', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    await settleWith(f, 'provider_reported');

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    // A receipt EXISTS — so this is "nothing unmeasured", not "nothing found" —
    // and the absent timestamp is absent rather than an epoch or a null.
    expect(metrics.unmeasuredSettlements).toEqual({ receiptCount: 0, settledReceipts: 1 });
    expect(metrics.unmeasuredSettlements).not.toHaveProperty('latestSettledAt');
  });
});

/* -------------------------------------------------------------------------- */
/*  Reconciliation drift                                                      */
/* -------------------------------------------------------------------------- */

describe('reconciliation drift', () => {
  it('is PENDING while no pass has completed, and counts the failures', async () => {
    const f = await makeFixture();
    const now = new Date();
    await getDb()
      .insert(billingReconciliationRuns)
      .values({
        provider: 'stripe',
        accountId: f.accountId,
        currency: 'USD',
        periodStart: new Date(now.getTime() - 3_600_000),
        periodEnd: now,
        status: 'failed',
        startedAt: now,
        completedAt: now,
      });

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    // Not "drift is zero": nothing was read, so the drift for that window is
    // UNKNOWN. Reporting zero here is the "cron that hides drift" outright.
    expect(metrics.reconciliationDrift).toEqual({
      state: 'pending',
      reason: 'no_completed_reconciliation',
      runCount: 1,
      failedRuns: 1,
    });
  });

  it('reports the newest completed pass and the discrepancy observations', async () => {
    const f = await makeFixture();
    const now = new Date();
    const db = getDb();

    const [older] = await db
      .insert(billingReconciliationRuns)
      .values({
        provider: 'stripe',
        accountId: f.accountId,
        currency: 'USD',
        periodStart: new Date(now.getTime() - 7_200_000),
        periodEnd: new Date(now.getTime() - 3_600_000),
        status: 'completed',
        ledgerTotal: '5.000000000000',
        externalTotal: '5.000000000000',
        discrepancyCount: 0,
        startedAt: new Date(now.getTime() - 3_500_000),
        completedAt: new Date(now.getTime() - 3_400_000),
      })
      .returning({ id: billingReconciliationRuns.id });

    const [newer] = await db
      .insert(billingReconciliationRuns)
      .values({
        provider: 'stripe',
        accountId: f.accountId,
        currency: 'USD',
        periodStart: new Date(now.getTime() - 3_600_000),
        periodEnd: now,
        status: 'completed',
        ledgerTotal: '10.000000000000',
        externalTotal: '12.500000000000',
        discrepancyCount: 1,
        startedAt: new Date(now.getTime() - 60_000),
        completedAt: new Date(now.getTime() - 30_000),
      })
      .returning({ id: billingReconciliationRuns.id });

    await db.insert(billingReconciliationDiscrepancies).values({
      runId: newer.id,
      kind: 'missing_in_ledger',
      accountId: f.accountId,
      externalRef: `pi_${randomUUID().slice(0, 8)}`,
      externalAmount: '2.500000000000',
      currency: 'USD',
    });

    // The window is filtered on `started_at`, and the older run starts ~58
    // minutes before `now` — so between 00:00 and 01:00 UTC `today()` excludes
    // it and this measures ONE run instead of two. Derive the window from the
    // rows actually inserted rather than from the wall clock, so the assertion
    // is about the newest-pass logic and not about what time the suite ran.
    const window = {
      from: new Date(now.getTime() - 3_500_000).toISOString().slice(0, 10),
      to: new Date(now.getTime()).toISOString().slice(0, 10),
    };
    const metrics = await readInferenceOperationalMetrics({ window, accountId: f.accountId });
    expect(metrics.reconciliationDrift).toMatchObject({
      state: 'measured',
      runCount: 2,
      completedRuns: 2,
      failedRuns: 0,
      observationsByKind: { missing_in_ledger: 1 },
    });
    if (metrics.reconciliationDrift.state !== 'measured') throw new Error('expected a measurement');
    // The NEWEST pass, not the first one found and not a sum of the two: the
    // current drift is one window's, and $2.50 is that window's.
    expect(metrics.reconciliationDrift.latest.runId).toBe(newer.id);
    expect(metrics.reconciliationDrift.latest.runId).not.toBe(older.id);
    expect(Number(metrics.reconciliationDrift.latest.driftAmount)).toBeCloseTo(2.5, 9);
    expect(metrics.reconciliationDrift.latest.discrepancyCount).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  The payload's own contract                                                */
/* -------------------------------------------------------------------------- */

describe('the payload', () => {
  it('declares its version, its window and that it is eventually consistent', async () => {
    const f = await makeFixture();
    const window = today();
    const metrics = await readInferenceOperationalMetrics({ window, accountId: f.accountId });

    expect(metrics.schemaVersion).toBe(1);
    expect(metrics.window).toEqual(window);
    // Derived from `resolveKaanaDataPlane()`, not asserted: it is what tells a
    // reader whether a pending metric is expected or a fault.
    expect(metrics.dataPlane).toBe('absent');
    expect(metrics.dataPlaneExecution).toEqual({
      enabled: false,
      disabledReason: 'not_configured',
    });
    // A required literal rather than prose: telemetry is written outside the
    // ledger transaction, and every surface built on it has to say so.
    expect(metrics.consistency).toBe('eventually-consistent');
  });

  it('reports configuration separately from the disabled execution gate', async () => {
    const f = await makeFixture();
    const variables = [
      KAANA_BASE_URL_VARIABLE,
      KAANA_SIGNING_KEY_ID_VARIABLE,
      KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
      KAANA_EXECUTION_VARIABLE,
    ] as const;
    const original = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
    const key = generateKeyPairSync('ed25519').privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();

    try {
      process.env[KAANA_BASE_URL_VARIABLE] = 'https://kaana.ai';
      process.env[KAANA_SIGNING_KEY_ID_VARIABLE] = 'metrics-edge';
      process.env[KAANA_SIGNING_PRIVATE_KEY_VARIABLE] = key;
      process.env[KAANA_EXECUTION_VARIABLE] = 'disabled';

      const metrics = await readInferenceOperationalMetrics(scopeOf(f));
      expect(metrics.dataPlane).toBe('configured');
      expect(metrics.dataPlaneExecution).toEqual({
        enabled: false,
        disabledReason: 'disabled',
      });
    } finally {
      for (const name of variables) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('carries no money except the reconciliation totals, and no cost at all', async () => {
    const f = await makeFixture({ fund: '10.000000000000' });
    await record(f);
    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    const serialized = JSON.stringify(metrics);

    // The scanner's own control first: it can find a field that IS there.
    expect(serialized).toContain('eventually-consistent');
    // Oxy's wholesale position is never on a metric, and neither is a price.
    expect(serialized).not.toContain('wholesale');
    expect(serialized).not.toContain('billedAmount');
    expect(serialized).not.toContain('priceVersion');
  });

  it('reads the event stream and the rollup for the SAME window', async () => {
    const f = await makeFixture();
    await record(f);
    await record(f);

    const metrics = await readInferenceOperationalMetrics(scopeOf(f));
    // The rollup is keyed on a UTC `date` and the events on a `timestamptz`, so
    // an off-by-one in either bound would make these two disagree. They are the
    // same two requests.
    expect(metrics.requests).toMatchObject({ state: 'measured', requestCount: 2 });
    expect(metrics.totalLatencyMs).toMatchObject({ observedRows: 2 });
  });

});

/* -------------------------------------------------------------------------- */
/*  The window bound                                                          */
/* -------------------------------------------------------------------------- */

describe('the window', () => {
  it('excludes a day outside it', async () => {
    const f = await makeFixture();
    await record(f);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const metrics = await readInferenceOperationalMetrics({
      window: { from: yesterday, to: yesterday },
      accountId: f.accountId,
    });

    // Paired with the `today()` cases above, which see the same row: without
    // that pairing "the window excluded it" and "the query finds nothing ever"
    // are the same green.
    expect(metrics.requests).toMatchObject({ state: 'pending', requestCount: 0 });
    expect(metrics.totalLatencyMs).toMatchObject({ observedRows: 0 });
  });

  it('counts a row written today when the window is bounded on both sides', async () => {
    const f = await makeFixture();
    await record(f);

    const day = new Date().toISOString().slice(0, 10);
    const [rowCount] = await getDb()
      .select({ n: sql<string>`count(*)::text` })
      .from(applications)
      .where(eq(applications.id, f.applicationId));
    // The floor: the fixture really is in the database this read is pointed at.
    expect(Number(rowCount.n)).toBe(1);

    const metrics = await readInferenceOperationalMetrics({
      window: { from: day, to: day },
      applicationId: f.applicationId,
    });
    expect(metrics.requests).toMatchObject({ state: 'measured', requestCount: 1 });
  });
});
