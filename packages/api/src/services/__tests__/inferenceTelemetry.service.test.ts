/**
 * The inference telemetry stream and its daily rollup, against a REAL Postgres.
 *
 * Two things here are not incidental:
 *
 *  1. **Every rollup case records at least TWICE.** A single insert never
 *     reaches the `ON CONFLICT … DO UPDATE` branch, so a test that records once
 *     cannot see the `excluded.<column>` bug at all — and that bug (interpolating
 *     a drizzle column, which emits the TypeScript property name) fails at
 *     runtime with `42703`, not at build time.
 *
 *  2. **Redelivery is asserted on the ROLLUP, not only on the event table.** A
 *     redelivered report that was rejected by the event's unique index but still
 *     incremented the rollup would inflate every usage chart while the event
 *     stream stayed correct — drift that nothing else in the system would
 *     surface.
 *
 * Every fixture is scoped to ids this file owns, so a sibling test seeding the
 * shared database cannot move an aggregate here.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { inferenceUsageDailyRollups } from '../../db/schema/inferenceUsageDailyRollups';
import {
  inferenceUsageEvents,
  UNROUTED_PROVIDER,
} from '../../db/schema/inferenceUsageEvents';
import { users } from '../../db/schema/users';
import {
  recordInferenceUsage,
  summarizeUsage,
  type RecordUsageInput,
} from '../inferenceTelemetry.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
}

async function makeFixture(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const [account] = await getDb()
    .insert(users)
    .values({ username: `tel-${suffix}`, email: `tel-${suffix}@example.test` })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Tel ${suffix}`, ownerAccountId: account.id })
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
  return {
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
  };
}

function usage(f: Fixture, overrides: Partial<RecordUsageInput> = {}): RecordUsageInput {
  return {
    accountId: f.accountId,
    applicationId: f.applicationId,
    applicationCredentialId: f.credentialId,
    requestId: `req-${randomUUID()}`,
    environment: 'production',
    endpoint: '/v1/chat/completions',
    statusCode: 200,
    outcome: 'completed',
    requestedModelReference: 'oxy/test',
    resolvedModelReference: 'oxy/test@2026-08-01',
    servingProvider: 'oxy-hosted',
    usageSource: 'provider_reported',
    units: { input_tokens: 100, output_tokens: 20 },
    latencyMs: 350,
    ...overrides,
  };
}

describe('the telemetry stream', () => {
  it('records one row per request and attributes it to the account', async () => {
    const f = await makeFixture();
    const result = await recordInferenceUsage(usage(f));

    expect(result.status).toBe('recorded');
    const rows = await getDb()
      .select({
        accountId: inferenceUsageEvents.accountId,
        applicationId: inferenceUsageEvents.applicationId,
        applicationCredentialId: inferenceUsageEvents.applicationCredentialId,
        inputTokens: inferenceUsageEvents.inputTokens,
      })
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.accountId, f.accountId));

    expect(rows.length).toBe(1);
    // All three, not just the user the old table carried.
    expect(rows[0].accountId).toBe(f.accountId);
    expect(rows[0].applicationId).toBe(f.applicationId);
    expect(rows[0].applicationCredentialId).toBe(f.credentialId);
    expect(rows[0].inputTokens).toBe(100);
  });

  it('carries no money column at all', async () => {
    const columns = await getDb().execute(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('inference_usage_events', 'inference_usage_daily_rollups')
    `);
    // The floor first, so an empty match below means "no such column exists"
    // rather than "the catalogue query read nothing".
    expect(columns.length).toBeGreaterThan(30);

    const money = columns
      .map((row) => String(row.column_name))
      .filter((name) => /cost|credit|amount|price|billed|spend/.test(name));
    // "The exact billed amount comes from the ledger, never from telemetry
    // sums" — enforced by there being nothing here to sum.
    expect(money).toEqual([]);
  });

  it('is idempotent on a redelivered report, in the events AND the rollup', async () => {
    const f = await makeFixture();
    const input = usage(f);

    const first = await recordInferenceUsage(input);
    const second = await recordInferenceUsage(input);

    expect(first.status).toBe('recorded');
    expect(second.status).toBe('already-recorded');

    const events = await getDb()
      .select({ id: inferenceUsageEvents.id })
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.accountId, f.accountId));
    expect(events.length).toBe(1);

    const [rollup] = await getDb()
      .select({
        requestCount: inferenceUsageDailyRollups.requestCount,
        inputTokens: inferenceUsageDailyRollups.inputTokens,
      })
      .from(inferenceUsageDailyRollups)
      .where(eq(inferenceUsageDailyRollups.accountId, f.accountId));
    // Counted ONCE. Two would be the drift nothing else surfaces.
    expect(rollup.requestCount).toBe(1);
    expect(rollup.inputTokens).toBe(100);
  });

  it('distinguishes two generations of one request', async () => {
    const f = await makeFixture();
    const requestId = `req-${randomUUID()}`;
    await recordInferenceUsage(usage(f, { requestId, generationId: 'gen-1' }));
    await recordInferenceUsage(usage(f, { requestId, generationId: 'gen-2' }));

    const events = await getDb()
      .select({ id: inferenceUsageEvents.id })
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.accountId, f.accountId));
    expect(events.length).toBe(2);
  });
});

describe('the daily rollup', () => {
  it('adds each counter to itself on conflict', async () => {
    const f = await makeFixture();
    const day = new Date();

    // THREE records, so the conflict branch runs twice. One record would never
    // reach it, and the `excluded.<column>` bug it guards fails only there.
    for (let index = 0; index < 3; index += 1) {
      await recordInferenceUsage(usage(f, { occurredAt: day }));
    }

    const [rollup] = await getDb()
      .select()
      .from(inferenceUsageDailyRollups)
      .where(eq(inferenceUsageDailyRollups.accountId, f.accountId));

    expect(rollup.requestCount).toBe(3);
    expect(rollup.errorCount).toBe(0);
    expect(rollup.inputTokens).toBe(300);
    expect(rollup.outputTokens).toBe(60);
  });

  it('counts an error response in error_count but keeps it in request_count', async () => {
    const f = await makeFixture();
    const day = new Date();
    await recordInferenceUsage(usage(f, { occurredAt: day }));
    await recordInferenceUsage(
      usage(f, { occurredAt: day, statusCode: 502, outcome: 'failed', units: {} })
    );

    const rows = await getDb()
      .select({
        outcome: inferenceUsageDailyRollups.outcome,
        requestCount: inferenceUsageDailyRollups.requestCount,
        errorCount: inferenceUsageDailyRollups.errorCount,
      })
      .from(inferenceUsageDailyRollups)
      .where(eq(inferenceUsageDailyRollups.accountId, f.accountId));

    // `outcome` is a rollup DIMENSION, so the two land on separate rows.
    expect(rows.length).toBe(2);
    const failed = rows.find((row) => row.outcome === 'failed');
    expect(failed?.requestCount).toBe(1);
    expect(failed?.errorCount).toBe(1);
  });

  it('files an unrouted request under the sentinel rather than dropping it', async () => {
    const f = await makeFixture();
    await recordInferenceUsage(
      usage(f, {
        statusCode: 429,
        outcome: 'failed',
        resolvedModelReference: undefined,
        servingProvider: undefined,
        units: {},
      })
    );

    const [rollup] = await getDb()
      .select({ servingProvider: inferenceUsageDailyRollups.servingProvider })
      .from(inferenceUsageDailyRollups)
      .where(eq(inferenceUsageDailyRollups.accountId, f.accountId));
    // A rollup primary key cannot hold a NULL, and dropping the row would make
    // rejected traffic invisible in exactly the report an operator needs.
    expect(rollup.servingProvider).toBe(UNROUTED_PROVIDER);
  });

  it('summarizes an account over a date range', async () => {
    const f = await makeFixture();
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    await recordInferenceUsage(usage(f, { occurredAt: yesterday }));
    await recordInferenceUsage(usage(f, { occurredAt: today }));

    const from = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const to = today.toISOString().slice(0, 10);

    const summary = await summarizeUsage({ accountId: f.accountId, from, to });
    expect(summary.length).toBe(2);
    expect(summary.reduce((total, row) => total + row.requestCount, 0)).toBe(2);
    expect(summary.reduce((total, row) => total + row.units.inputTokens, 0)).toBe(200);

    // Scoped to the credential, the same two rows; scoped to a credential that
    // recorded nothing, none — so the filter is doing work rather than being
    // ignored.
    const scoped = await summarizeUsage({
      accountId: f.accountId,
      from,
      to,
      applicationCredentialId: f.credentialId,
    });
    expect(scoped.length).toBe(2);

    const other = await makeFixture();
    const empty = await summarizeUsage({
      accountId: f.accountId,
      from,
      to,
      applicationCredentialId: other.credentialId,
    });
    expect(empty).toEqual([]);
  });

  it('keeps two days apart', async () => {
    const f = await makeFixture();
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    await recordInferenceUsage(usage(f, { occurredAt: yesterday }));
    await recordInferenceUsage(usage(f, { occurredAt: yesterday }));
    await recordInferenceUsage(usage(f, { occurredAt: today }));

    const rows = await getDb()
      .select({ day: inferenceUsageDailyRollups.day, requestCount: inferenceUsageDailyRollups.requestCount })
      .from(inferenceUsageDailyRollups)
      .where(
        and(
          eq(inferenceUsageDailyRollups.accountId, f.accountId),
          eq(inferenceUsageDailyRollups.applicationId, f.applicationId)
        )
      );

    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.requestCount).sort((a, b) => a - b)).toEqual([1, 2]);
  });
});
