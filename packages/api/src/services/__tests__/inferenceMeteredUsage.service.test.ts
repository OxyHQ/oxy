/**
 * The durable usage record (#1526, I09) against a REAL Postgres: idempotency
 * without a hold, technical capacity under concurrency, the tariff snapshot,
 * and the report that keeps usage, tariff, provider cost and charge apart.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  INFERENCE_ECONOMIC_POLICY_VERSION,
  type EconomicTreatmentDecision,
  type InternalMeteredRelationship,
} from '../../config/inferenceEconomicPolicy';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { inferenceMeteredUsage } from '../../db/schema/inferenceMeteredUsage';
import { internalCostCenters } from '../../db/schema/internalCostCenters';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { users } from '../../db/schema/users';
import {
  claimMeteredAdmission,
  costCenterUsage,
  markMeteredAdmissionRefused,
  settleMeteredUsage,
  reconcileMeteredReceipts,
  type MeteredAdmissionInput,
} from '../inferenceMeteredUsage.service';
import { ingestProviderCostAttempts, type ProviderCostAttemptEvent } from '../kaanaProviderCostFeed.service';
import { quoteUnits, provisionBillingProfile, recordTopUp, settle as settleLedger } from '../inferenceLedger.service';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { readJevTechnicalMetering } from '../../scripts/jevMeteringReadback';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';

jest.setTimeout(60_000);

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

const tag = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly priceVersionId: string;
  readonly modelReference: string;
}

/** An account labelled as a cost centre, its application, a credential and a price. */
async function makeFixture(): Promise<Fixture> {
  const db = getDb();
  const t = tag();
  const [account] = await db
    .insert(users)
    .values({ username: `meter-${t}`, email: `meter-${t}@example.test` })
    .returning({ id: users.id });
  await db.insert(internalCostCenters).values({ accountId: account.id, slug: `cc-${t}`, label: `CC ${t}` });
  const [application] = await db
    .insert(applications)
    .values({ name: `Meter ${t}`, ownerAccountId: account.id, createdByUserId: account.id, scopes: ['inference:invoke'] })
    .returning({ id: applications.id });
  const minted = generateMachineCredentialToken();
  const [credential] = await db
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: `key-${t}`,
      publicKey: `oxy_dk_${t}`,
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      type: 'machine',
      environment: 'production',
      scopes: ['inference:invoke'],
      status: 'active',
      createdByUserId: account.id,
    })
    .returning({ id: applicationCredentials.id });
  const modelReference = `pub${t}/model-${t}@2026-01-01`;
  const priceVersionId = await makePrice(modelReference, `prov${t}`, '3.000000000000');
  return {
    accountId: account.id,
    applicationId: application.id,
    credentialId: credential.id,
    priceVersionId,
    modelReference,
  };
}

/** `inputPerMillion` per million input tokens, $15 per million output tokens. */
async function makePrice(modelReference: string, provider: string, inputPerMillion: string): Promise<string> {
  const db = getDb();
  const [price] = await db
    .insert(priceVersions)
    .values({ modelReference, provider, status: 'active', effectiveFrom: new Date(Date.now() - 60_000) })
    .returning({ id: priceVersions.id });
  await db.insert(priceVersionUnitPrices).values([
    { priceVersionId: price.id, unit: 'requests', amount: '0.000000000000', per: 1 },
    { priceVersionId: price.id, unit: 'input_tokens', amount: inputPerMillion, per: 1_000_000 },
    { priceVersionId: price.id, unit: 'output_tokens', amount: '15.000000000000', per: 1_000_000 },
  ]);
  return price.id;
}

function internal(capacity: InternalMeteredRelationship['capacity'], applicationId: string): EconomicTreatmentDecision {
  return {
    treatment: 'internal_metered',
    policyVersion: INFERENCE_ECONOMIC_POLICY_VERSION,
    relationship: {
      relationshipId: 'alia-kaana',
      consumerApplicationId: applicationId,
      consumerProduct: 'alia',
      providerProduct: 'kaana',
      environments: ['production'],
      lane: 'service_token',
      capacity,
    },
  };
}

const commercial: EconomicTreatmentDecision = {
  treatment: 'commercial',
  policyVersion: INFERENCE_ECONOMIC_POLICY_VERSION,
};

function admission(fixture: Fixture, economics: EconomicTreatmentDecision, key?: string): MeteredAdmissionInput {
  const requestId = randomUUID();
  return {
    requestId,
    idempotencyKey: key ?? `oxy-edge:req:${requestId}`,
    economics,
    accountId: fixture.accountId,
    applicationId: fixture.applicationId,
    applicationCredentialId: fixture.credentialId,
    environment: 'production',
    endpoint: '/v1/responses',
    requestedModelReference: fixture.modelReference,
    admittedModelReference: fixture.modelReference,
    admittedProvider: 'synthetic',
    admittedDeploymentId: 'kaana-synthetic',
    routingPolicyVersionId: undefined,
    ceiling: { amount: '0.050000000000', currency: 'USD' },
    expiresInSeconds: 900,
  };
}

async function settle(fixture: Fixture, meteredUsageId: string, units = { input_tokens: 1000, output_tokens: 2000 }) {
  return settleMeteredUsage({
    meteredUsageId,
    outcome: 'completed',
    usageSource: 'provider_reported',
    units,
    resolvedModelReference: fixture.modelReference,
    servingProvider: 'synthetic',
    generationId: undefined,
    priceVersionId: fixture.priceVersionId,
  });
}

async function row(id: string) {
  const [found] = await getDb().select().from(inferenceMeteredUsage).where(eq(inferenceMeteredUsage.id, id));
  return found;
}

describe('idempotency without a hold', () => {
  it('lets exactly one of N concurrent claims on one key through, for every treatment', async () => {
    for (const economics of [commercial, internal({ maxConcurrentRequests: 100, maxRequestsPerUtcDay: 1000 }, 'x')]) {
      const fixture = await makeFixture();
      const key = `oxy-edge:idem:${fixture.credentialId}:${tag()}`;
      const results = await Promise.all(
        Array.from({ length: 12 }, () => claimMeteredAdmission(admission(fixture, economics, key)))
      );
      expect(results.filter((result) => result.status === 'claimed')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'duplicate')).toHaveLength(11);
    }
  });

  it('frees a key whose request was refused before forwarding, exactly as a declined reservation does', async () => {
    const fixture = await makeFixture();
    const key = `oxy-edge:idem:${fixture.credentialId}:${tag()}`;
    const first = await claimMeteredAdmission(admission(fixture, commercial, key));
    if (first.status !== 'claimed') throw new Error('fixture claim failed');
    expect((await claimMeteredAdmission(admission(fixture, commercial, key))).status).toBe('duplicate');
    await markMeteredAdmissionRefused(first.meteredUsageId);
    expect((await claimMeteredAdmission(admission(fixture, commercial, key))).status).toBe('claimed');
    expect((await row(first.meteredUsageId)).status).toBe('refused');
  });
});

describe('technical capacity for internal_metered', () => {
  it('admits exactly the concurrency budget under a burst, and refuses the rest as capacity — never money', async () => {
    const fixture = await makeFixture();
    const economics = internal({ maxConcurrentRequests: 3, maxRequestsPerUtcDay: 1000 }, fixture.applicationId);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimMeteredAdmission(admission(fixture, economics)))
    );
    const claimed = results.filter((result) => result.status === 'claimed');
    expect(claimed).toHaveLength(3);
    expect(results.filter((result) => result.status === 'capacity-exceeded')).toEqual(
      Array(7).fill(expect.objectContaining({ limit: 'concurrency' }))
    );

    // Settling one frees one slot.
    const first = claimed[0];
    if (first.status !== 'claimed') throw new Error('unreachable');
    expect(await settle(fixture, first.meteredUsageId)).toEqual({ status: 'settled', tariff: 'quoted' });
    expect((await claimMeteredAdmission(admission(fixture, economics))).status).toBe('claimed');
  });

  it('refuses past the daily budget even with every request settled', async () => {
    const fixture = await makeFixture();
    const economics = internal({ maxConcurrentRequests: 10, maxRequestsPerUtcDay: 2 }, fixture.applicationId);
    for (let i = 0; i < 2; i += 1) {
      const claim = await claimMeteredAdmission(admission(fixture, economics));
      if (claim.status !== 'claimed') throw new Error('fixture claim failed');
      await settle(fixture, claim.meteredUsageId);
    }
    expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({
      status: 'capacity-exceeded',
      limit: 'daily',
    });
  });

  it.each([0, 1])('readback and admission count 32 live requests across treatments (%i internal)', async (internalCount) => {
    const fixture = await makeFixture();
    const economics = internal({ maxConcurrentRequests: 32, maxRequestsPerUtcDay: 5000 }, fixture.applicationId);
    const ids: string[] = [];
    for (let i = 0; i < 32; i += 1) {
      const claim = await claimMeteredAdmission(admission(fixture, i < internalCount ? economics : commercial));
      if (claim.status !== 'claimed') throw new Error('fixture claim failed');
      ids.push(claim.meteredUsageId);
    }
    const evidence = await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production');
    expect(evidence).toEqual({ schemaAvailable: true, activeAdmissions: 32, dailyAdmissions: 32 });
    expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({ status: 'capacity-exceeded', limit: 'concurrency' });
    // Expiry releases concurrency but preserves today's non-refused admission.
    await getDb().update(inferenceMeteredUsage).set({ expiresAt: new Date(0) }).where(eq(inferenceMeteredUsage.id, ids[0]));
    expect(await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production')).toMatchObject({ activeAdmissions: 31, dailyAdmissions: 32 });
    expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({ status: 'claimed' });
  });

  it.each([0, 1])('readback and admission count 5000 expired requests for the UTC day (%i internal)', async (internalCount) => {
    const fixture = await makeFixture();
    const economics = internal({ maxConcurrentRequests: 32, maxRequestsPerUtcDay: 5000 }, fixture.applicationId);
    const initial = await claimMeteredAdmission(admission(fixture, internalCount === 1 ? economics : commercial));
    if (initial.status !== 'claimed') throw new Error('fixture claim failed');
    await getDb().update(inferenceMeteredUsage).set({ expiresAt: new Date(0) }).where(eq(inferenceMeteredUsage.id, initial.meteredUsageId));
    await getDb().execute(sql`
      insert into inference_metered_usage (id, request_id, idempotency_key, economic_treatment,
        economic_policy_version, account_id, application_id, application_credential_id,
        environment, endpoint, requested_model_reference, admitted_model_reference,
        admitted_provider, admitted_deployment_id, expires_at, created_at)
      select gen_random_uuid()::text, ${fixture.applicationId} || '-day-' || n, ${fixture.applicationId} || '-key-' || n,
        'commercial', ${INFERENCE_ECONOMIC_POLICY_VERSION}, ${fixture.accountId}, ${fixture.applicationId},
        ${fixture.credentialId}, 'production', '/v1/responses', ${fixture.modelReference},
        ${fixture.modelReference}, 'synthetic', 'kaana-synthetic', now() - interval '1 minute', now()
      from generate_series(1, 4999) n`);
    expect(await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production'))
      .toEqual({ schemaAvailable: true, activeAdmissions: 0, dailyAdmissions: 5000 });
    expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({ status: 'capacity-exceeded', limit: 'daily' });
    // Moving a row across UTC midnight changes only the daily population.
    await getDb().execute(sql`update inference_metered_usage set created_at =
      (date_trunc('day', now() at time zone 'utc') at time zone 'utc') - interval '1 second'
      where id = ${initial.meteredUsageId}`);
    expect(await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production')).toMatchObject({ activeAdmissions: 0, dailyAdmissions: 4999 });
    expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({ status: 'claimed' });
  });

  it('readback preserves admission boundaries for application, environment, refusal and the two-day window', async () => {
    const fixture = await makeFixture();
    const other = await makeFixture();
    const active = await claimMeteredAdmission(admission(fixture, commercial));
    const refused = await claimMeteredAdmission(admission(fixture, commercial));
    const old = await claimMeteredAdmission(admission(fixture, commercial));
    if (active.status !== 'claimed' || refused.status !== 'claimed' || old.status !== 'claimed') throw new Error('fixture claim failed');
    await markMeteredAdmissionRefused(refused.meteredUsageId);
    await getDb().execute(sql`update inference_metered_usage set created_at = now() - interval '3 days',
      expires_at = now() + interval '1 day' where id = ${old.meteredUsageId}`);
    await claimMeteredAdmission({ ...admission(fixture, commercial), environment: 'development' });
    await claimMeteredAdmission(admission(other, commercial));
    expect(await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production'))
      .toEqual({ schemaAvailable: true, activeAdmissions: 1, dailyAdmissions: 1 });
    await getDb().transaction(async tx => {
      await tx.execute(sql`set transaction read only, isolation level repeatable read`);
      expect(await readJevTechnicalMetering(tx, fixture.applicationId, 'production'))
        .toEqual({ schemaAvailable: true, activeAdmissions: 1, dailyAdmissions: 1 });
    });
    expect(await getDb().select().from(inferenceMeteredUsage).where(and(eq(inferenceMeteredUsage.applicationId, fixture.applicationId), eq(inferenceMeteredUsage.status, 'admitted')))).toHaveLength(3);
  });

  it.each([
    "alter table inference_metered_usage drop column final_authorized_provider",
    "alter table inference_metered_usage drop constraint inference_metered_usage_parent_check",
    "alter table inference_metered_usage drop constraint inference_metered_usage_final_authorization_check",
    "drop index inference_metered_usage_parent_idx",
  ])('blocks readback with missing required schema evidence: %s', async statement => {
    const fixture = await makeFixture();
    await expect(getDb().transaction(async tx => {
      await tx.execute(sql.raw(statement));
      expect(await readJevTechnicalMetering(tx, fixture.applicationId, 'production'))
        .toEqual({ schemaAvailable: false, activeAdmissions: 0, dailyAdmissions: 0 });
      throw new Error('rollback schema fixture');
    })).rejects.toThrow('rollback schema fixture');
    expect(await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production'))
      .toMatchObject({ schemaAvailable: true });
  });

  it('applies no capacity to a commercial claim (its limit is the ledger)', async () => {
    const fixture = await makeFixture();
    for (let i = 0; i < 4; i += 1) {
      expect((await claimMeteredAdmission(admission(fixture, commercial))).status).toBe('claimed');
    }
  });
});

describe('the usage record', () => {
  it('snapshots the cost centre, the policy version and the tariff; a later price never rewrites it', async () => {
    const fixture = await makeFixture();
    const claim = await claimMeteredAdmission(
      admission(fixture, internal({ maxConcurrentRequests: 10, maxRequestsPerUtcDay: 10 }, fixture.applicationId))
    );
    if (claim.status !== 'claimed') throw new Error('fixture claim failed');
    await settle(fixture, claim.meteredUsageId);

    const settled = await row(claim.meteredUsageId);
    expect(settled).toMatchObject({
      status: 'settled',
      economicTreatment: 'internal_metered',
      economicPolicyVersion: INFERENCE_ECONOMIC_POLICY_VERSION,
      economicRelationshipId: 'alia-kaana',
      costCenterAccountId: fixture.accountId,
      inputTokens: 1000,
      outputTokens: 2000,
      tariffStatus: 'quoted',
      // 1000 × $3/M + 2000 × $15/M
      tariffAmount: '0.033000000000',
      tariffCurrency: 'USD',
      usageReceiptId: null,
    });

    // A new, dearer price version for the same route, and the old snapshot holds.
    const dearer = await makePrice(fixture.modelReference, 'synthetic-dearer', '30.000000000000');
    expect(await quoteUnits(dearer, { input_tokens: 1000, output_tokens: 2000 })).toMatchObject({
      status: 'quoted',
      amount: '0.060000000000',
    });
    expect((await row(claim.meteredUsageId)).tariffAmount).toBe('0.033000000000');
  });

  it('records an unpriceable tariff as unknown, never zero', async () => {
    const fixture = await makeFixture();
    const claim = await claimMeteredAdmission(admission(fixture, commercial));
    if (claim.status !== 'claimed') throw new Error('fixture claim failed');
    expect(await settle(fixture, claim.meteredUsageId, { input_tokens: 10, output_tokens: 10, images: 1 } as never))
      .toEqual({ status: 'settled', tariff: 'unpriced' });
    expect(await row(claim.meteredUsageId)).toMatchObject({ tariffStatus: 'unpriced', tariffAmount: null });
  });

  it('settles once: a second settlement is refused and the first stands', async () => {
    const fixture = await makeFixture();
    const claim = await claimMeteredAdmission(admission(fixture, commercial));
    if (claim.status !== 'claimed') throw new Error('fixture claim failed');
    await settle(fixture, claim.meteredUsageId);
    expect(await settle(fixture, claim.meteredUsageId, { input_tokens: 9, output_tokens: 9 })).toEqual({
      status: 'not-admitted',
    });
    expect((await row(claim.meteredUsageId)).inputTokens).toBe(1000);
  });

  it('cannot attach a receipt to an internal request (the database refuses it)', async () => {
    const fixture = await makeFixture();
    const claim = await claimMeteredAdmission(
      admission(fixture, internal({ maxConcurrentRequests: 10, maxRequestsPerUtcDay: 10 }, fixture.applicationId))
    );
    if (claim.status !== 'claimed') throw new Error('fixture claim failed');
    await expect(
      getDb()
        .update(inferenceMeteredUsage)
        .set({ usageReceiptId: 'any-receipt' })
        .where(eq(inferenceMeteredUsage.id, claim.meteredUsageId))
    ).rejects.toThrow();
  });
});

describe('terminal recovery from committed commercial receipts', () => {
  it('skips conflicting terminal rows before its batch limit and links a matching later row', async () => {
    const fixture = await makeFixture();
    await provisionBillingProfile({ accountId: fixture.accountId });
    await recordTopUp({ idempotencyKey: `fund-${tag()}`, accountId: fixture.accountId,
      currency: 'USD', amount: '1.000000000000', actor: { kind: 'machine' } });
    const ids: string[] = [];
    for (const meteredTokens of [9, 1000]) {
      const input = admission(fixture, commercial);
      const claim = await claimMeteredAdmission(input);
      if (claim.status !== 'claimed') throw new Error('fixture claim failed');
      ids.push(claim.meteredUsageId);
      await settle(fixture, claim.meteredUsageId, { input_tokens: meteredTokens, output_tokens: 2000 });
      const result = await settleLedger({ idempotencyKey: input.idempotencyKey,
        attribution: { accountId: fixture.accountId, applicationId: fixture.applicationId,
          applicationCredentialId: fixture.credentialId, requestId: input.requestId, environment: 'production' },
        outcome: 'completed', usageSource: 'provider_reported',
        units: { input_tokens: 1000, output_tokens: 2000 }, resolvedModelReference: fixture.modelReference,
        servingProvider: 'synthetic', priceVersionId: fixture.priceVersionId });
      if (result.status !== 'settled') throw new Error(`fixture settlement failed: ${result.status}`);
    }
    expect(await reconcileMeteredReceipts(1)).toBe(1);
    expect((await row(ids[0])).usageReceiptId).toBeNull();
    expect((await row(ids[0])).inputTokens).toBe(9);
    expect((await row(ids[1])).usageReceiptId).not.toBeNull();
    expect(await reconcileMeteredReceipts(1)).toBe(0);
  });

  it('recovers a receipt committed before metering, without a second charge or execution', async () => {
    const fixture = await makeFixture();
    const input = admission(fixture, commercial);
    const claim = await claimMeteredAdmission(input);
    if (claim.status !== 'claimed') throw new Error('fixture claim failed');
    await provisionBillingProfile({ accountId: fixture.accountId });
    await recordTopUp({ idempotencyKey: `fund-${tag()}`, accountId: fixture.accountId,
      currency: 'USD', amount: '1.000000000000', actor: { kind: 'machine' } });
    const receipt = await settleLedger({ idempotencyKey: input.idempotencyKey,
      attribution: { accountId: fixture.accountId, applicationId: fixture.applicationId,
        applicationCredentialId: fixture.credentialId, requestId: input.requestId, environment: 'production' },
      outcome: 'completed', usageSource: 'provider_reported',
      units: { input_tokens: 1000, output_tokens: 2000 }, resolvedModelReference: fixture.modelReference,
      servingProvider: 'synthetic', priceVersionId: fixture.priceVersionId });
    if (receipt.status !== 'settled') throw new Error(`fixture settlement failed: ${receipt.status}`);
    // Crash boundary: the immutable receipt exists, terminal metering does not.
    expect((await row(claim.meteredUsageId)).status).toBe('admitted');
    expect(await reconcileMeteredReceipts()).toBe(1);
    expect(await row(claim.meteredUsageId)).toMatchObject({ status: 'settled',
      inputTokens: 1000, outputTokens: 2000, usageReceiptId: receipt.receipt.receiptId });
    expect(await reconcileMeteredReceipts()).toBe(0);
    expect(await getDb().select().from(usageReceipts).where(eq(usageReceipts.requestId, input.requestId))).toHaveLength(1);
    expect((await claimMeteredAdmission(input)).status).toBe('duplicate');
  });
});

describe('the cost-centre usage report', () => {
  function attempt(requestId: string, index: number, overrides: Partial<ProviderCostAttemptEvent> = {}): ProviderCostAttemptEvent {
    return {
      position: `kaf_${requestId}_${index}`,
      requestId,
      attemptIndex: index,
      provider: 'synthetic',
      keyId: 'key-1',
      keyClass: 'platform',
      deploymentId: 'kaana-synthetic',
      modelReference: 'pub/model@2026-01-01',
      cost: { currency: 'USD', amountPicos: '10000000000' },
      costSource: 'rate_card',
      rateCardVersionId: 'rc-1',
      costComplete: true,
      served: true,
      occurredAt: new Date().toISOString(),
      units: [{ unit: 'input_tokens', quantity: 1000 }],
      telemetry: null,
      ...overrides,
    };
  }

  it('separates units, tariff, provider cost (failover included, unknown counted) and customer charge', async () => {
    const periodStart = new Date(Date.now() - 60_000);
    const fixture = await makeFixture();
    const economics = internal({ maxConcurrentRequests: 10, maxRequestsPerUtcDay: 10 }, fixture.applicationId);

    const a = admission(fixture, economics);
    const claimA = await claimMeteredAdmission(a);
    const b = admission(fixture, economics);
    const claimB = await claimMeteredAdmission(b);
    const inFlight = await claimMeteredAdmission(admission(fixture, economics));
    if (claimA.status !== 'claimed' || claimB.status !== 'claimed' || inFlight.status !== 'claimed') {
      throw new Error('fixture claims failed');
    }
    await settle(fixture, claimA.meteredUsageId);
    await settle(fixture, claimB.meteredUsageId, { input_tokens: 10, output_tokens: 10, images: 1 } as never);

    // A failed first attempt and a served failover for A; an unknown-cost attempt for B.
    await ingestProviderCostAttempts([
      attempt(a.requestId, 0, { served: false, cost: { currency: 'USD', amountPicos: '2000000000' } }),
      attempt(a.requestId, 1),
      attempt(b.requestId, 0, { costSource: 'unknown', cost: null, rateCardVersionId: null }),
    ]);

    const report = await costCenterUsage({ periodStart, periodEnd: new Date(Date.now() + 60_000), currency: 'USD' });
    const mine = report.filter((entry) => entry.costCenter?.accountId === fixture.accountId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      treatment: 'internal_metered',
      requestCount: 2,
      inFlightCount: 1,
      units: { input_tokens: 1010, output_tokens: 2010, images: 1 },
      tariff: { amount: '0.033000000000', knownCount: 1, unknownCount: 1 },
      // 0.002 (failed attempt) + 0.010 (served failover); B's unknown attempt is counted, not summed.
      providerCost: { amount: '0.012000000000', knownCount: 2, unknownCount: 1 },
      customerCharge: { amount: '0', receiptCount: 0 },
    });
  });
  it('reports incomplete subtotals, missing feed and expired terminal evidence separately', async () => {
    const fixture = await makeFixture();
    const economics = internal({ maxConcurrentRequests: 10, maxRequestsPerUtcDay: 10 }, fixture.applicationId);
    const input = admission(fixture, economics);
    const partial = await claimMeteredAdmission(input);
    const expired = await claimMeteredAdmission({ ...admission(fixture, economics), expiresInSeconds: -1 });
    if (partial.status !== 'claimed' || expired.status !== 'claimed') throw new Error('fixture claim failed');
    await settle(fixture, partial.meteredUsageId);
    await ingestProviderCostAttempts([attempt(input.requestId, 0, { costComplete: false }),
      attempt(input.requestId, 1, { cost: { currency: 'EUR', amountPicos: '10000000000' } }),
      attempt(input.requestId, 2, { costSource: 'provider_reported', cost: { currency: 'USD', amountPicos: '20000000000' } })]);
    const report = await costCenterUsage({ periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000), currency: 'USD' });
    expect(report.find((entry) => entry.costCenter?.accountId === fixture.accountId)).toMatchObject({
      requestCount: 1, inFlightCount: 0, expiredCount: 1,
      providerCost: { amount: '0.030000000000', knownCount: 1, unknownCount: 0,
        partialCount: 1, missingRequestCount: 1, otherCurrencyCount: 1,
        providerReportedAmount: '0.020000000000', providerReportedCount: 1,
        estimatedAmount: '0.010000000000', estimatedCount: 1 },
    });
    expect((await row(expired.meteredUsageId)).status).toBe('admitted');
  });

});
