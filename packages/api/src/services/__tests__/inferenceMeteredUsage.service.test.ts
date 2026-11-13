/**
 * The durable usage record (#1526, I09) against a REAL Postgres: idempotency
 * without a hold, technical capacity under concurrency, the tariff snapshot,
 * and the report that keeps usage, tariff, provider cost and charge apart.
 */

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalize } from '@oxy.so/protocol';
import { workloadAttestationHandle } from '../workloadAttestation.service';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { usageReservations } from '../../db/schema/usageReservations';
import { kaanaGrants } from '../../db/schema/kaanaGrants';
import { inferenceAuthorityFences } from '../../db/schema/inferenceAuthorityFences';
import {
  activateInferenceAuthorityFence,
  exportInferenceAuthorityFence,
  isInferenceAuthorityFenceError,
  legacyInferenceFenceEntries,
  type InferenceAuthorityPopulation,
} from '../inferenceAuthorityFence.service';
import * as economicsConfig from '../../config/inferenceEconomicPolicy';
import { applicationInferenceLimits } from '../../db/schema/applicationInferenceLimits';
import { readMeteredCapacity } from '../inferenceCapacity.service';
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
import { supervisionProfiles } from '../../db/schema/supervision';
import { resolveLiveAgencyWorkloadByHandle } from '../agencyServicePrincipal.service';
import { invalidateSupervision } from '../supervisionPolicy.service';
import {
  claimMeteredAdmission,
  costCenterUsage,
  markMeteredAdmissionRefused,
  settleMeteredUsage,
  reconcileMeteredReceipts,
  type MeteredAdmissionInput,
} from '../inferenceMeteredUsage.service';
import {
  ingestProviderCostAttempts,
  type ProviderCostAttemptEvent,
} from '../kaanaProviderCostFeed.service';
import {
  quoteUnits,
  provisionBillingProfile,
  recordTopUp,
  settle as settleLedger,
} from '../inferenceLedger.service';
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
  await db
    .insert(internalCostCenters)
    .values({ accountId: account.id, slug: `cc-${t}`, label: `CC ${t}` });
  const [application] = await db
    .insert(applications)
    .values({
      name: `Meter ${t}`,
      ownerAccountId: account.id,
      createdByUserId: account.id,
      scopes: ['inference:invoke'],
    })
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
async function makePrice(
  modelReference: string,
  provider: string,
  inputPerMillion: string,
): Promise<string> {
  const db = getDb();
  const [price] = await db
    .insert(priceVersions)
    .values({
      modelReference,
      provider,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });
  await db.insert(priceVersionUnitPrices).values([
    { priceVersionId: price.id, unit: 'requests', amount: '0.000000000000', per: 1 },
    { priceVersionId: price.id, unit: 'input_tokens', amount: inputPerMillion, per: 1_000_000 },
    { priceVersionId: price.id, unit: 'output_tokens', amount: '15.000000000000', per: 1_000_000 },
  ]);
  return price.id;
}

function internal(
  capacity: InternalMeteredRelationship['capacity'],
  applicationId: string,
): EconomicTreatmentDecision {
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

function admission(
  fixture: Fixture,
  economics: EconomicTreatmentDecision,
  key?: string,
): MeteredAdmissionInput {
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

async function settle(
  fixture: Fixture,
  meteredUsageId: string,
  units = { input_tokens: 1000, output_tokens: 2000 },
) {
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
  const [found] = await getDb()
    .select()
    .from(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.id, id));
  return found;
}

describe('idempotency without a hold', () => {
  it('lets exactly one of N concurrent claims on one key through, for every treatment', async () => {
    for (const economics of [
      commercial,
      internal({ maxConcurrentRequests: 100, maxRequestsPerUtcDay: 1000 }, 'x'),
    ]) {
      const fixture = await makeFixture();
      const key = `oxy-edge:idem:${fixture.credentialId}:${tag()}`;
      const results = await Promise.all(
        Array.from({ length: 12 }, () => claimMeteredAdmission(admission(fixture, economics, key))),
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
    expect((await claimMeteredAdmission(admission(fixture, commercial, key))).status).toBe(
      'duplicate',
    );
    await markMeteredAdmissionRefused(first.meteredUsageId);
    expect((await claimMeteredAdmission(admission(fixture, commercial, key))).status).toBe(
      'claimed',
    );
    expect((await row(first.meteredUsageId)).status).toBe('refused');
  });
});

describe('technical capacity for internal_metered', () => {
  it('isolates a feature relationship from commercial traffic and enforces one concurrent and daily claim', async () => {
    const fixture = await makeFixture();
    const ordinary = await claimMeteredAdmission(admission(fixture, commercial));
    expect(ordinary.status).toBe('claimed');
    const economics = internal(
      { maxConcurrentRequests: 1, maxRequestsPerUtcDay: 1, scope: 'relationship' },
      fixture.applicationId,
    );
    if (economics.treatment !== 'internal_metered') throw new Error('fixture');
    const own = {
      ...economics,
      relationship: { ...economics.relationship, relationshipId: 'mention-jev-kaana' },
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimMeteredAdmission(admission(fixture, own))),
    );
    const winners = results.filter((result) => result.status === 'claimed');
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => result.status === 'capacity-exceeded')).toHaveLength(7);
    const winner = winners[0];
    if (winner.status !== 'claimed') throw new Error('fixture');
    await settle(fixture, winner.meteredUsageId);
    expect(await claimMeteredAdmission(admission(fixture, own))).toMatchObject({
      status: 'capacity-exceeded',
      limit: 'daily',
    });
    // Internal capacity does not become a global stop for the app's normal commercial traffic.
    expect((await claimMeteredAdmission(admission(fixture, commercial))).status).toBe('claimed');
  });

  it('admits exactly the concurrency budget under a burst, and refuses the rest as capacity — never money', async () => {
    const fixture = await makeFixture();
    const economics = internal(
      { maxConcurrentRequests: 3, maxRequestsPerUtcDay: 1000 },
      fixture.applicationId,
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimMeteredAdmission(admission(fixture, economics))),
    );
    const claimed = results.filter((result) => result.status === 'claimed');
    expect(claimed).toHaveLength(3);
    expect(results.filter((result) => result.status === 'capacity-exceeded')).toEqual(
      Array(7).fill(expect.objectContaining({ limit: 'concurrency' })),
    );

    // Settling one frees one slot.
    const first = claimed[0];
    if (first.status !== 'claimed') throw new Error('unreachable');
    expect(await settle(fixture, first.meteredUsageId)).toEqual({
      status: 'settled',
      tariff: 'quoted',
    });
    expect((await claimMeteredAdmission(admission(fixture, economics))).status).toBe('claimed');
  });

  it('refuses past the daily budget even with every request settled', async () => {
    const fixture = await makeFixture();
    const economics = internal(
      { maxConcurrentRequests: 10, maxRequestsPerUtcDay: 2 },
      fixture.applicationId,
    );
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

  it('bounds each person’s day apart from the application’s, and admits no unattributed request', async () => {
    const fixture = await makeFixture();
    const economics = internal(
      {
        maxConcurrentRequests: 10,
        maxRequestsPerUtcDay: 10,
        maxRequestsPerUserPerUtcDay: 2,
        scope: 'relationship',
      },
      fixture.applicationId,
    );
    const person = randomUUID();
    const other = randomUUID();
    for (let i = 0; i < 2; i += 1) {
      const claim = await claimMeteredAdmission({
        ...admission(fixture, economics),
        delegatedUserId: person,
      });
      if (claim.status !== 'claimed') throw new Error('fixture claim failed');
      await settle(fixture, claim.meteredUsageId);
    }
    expect(
      await claimMeteredAdmission({ ...admission(fixture, economics), delegatedUserId: person }),
    ).toMatchObject({ status: 'capacity-exceeded', limit: 'user-daily' });
    expect(
      (await claimMeteredAdmission({ ...admission(fixture, economics), delegatedUserId: other }))
        .status,
    ).toBe('claimed');
    expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({
      status: 'capacity-exceeded',
      limit: 'user-daily',
    });
  });

  it.each([0, 1])(
    'readback and admission count 32 live requests across treatments (%i internal)',
    async (internalCount) => {
      const fixture = await makeFixture();
      const economics = internal(
        { maxConcurrentRequests: 32, maxRequestsPerUtcDay: 5000 },
        fixture.applicationId,
      );
      const ids: string[] = [];
      for (let i = 0; i < 32; i += 1) {
        const claim = await claimMeteredAdmission(
          admission(fixture, i < internalCount ? economics : commercial),
        );
        if (claim.status !== 'claimed') throw new Error('fixture claim failed');
        ids.push(claim.meteredUsageId);
      }
      const evidence = await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production');
      expect(evidence).toEqual({
        schemaAvailable: true,
        activeAdmissions: 32,
        dailyAdmissions: 32,
      });
      expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({
        status: 'capacity-exceeded',
        limit: 'concurrency',
      });
      // Expiry releases concurrency but preserves today's non-refused admission.
      await getDb()
        .update(inferenceMeteredUsage)
        .set({ expiresAt: new Date(0) })
        .where(eq(inferenceMeteredUsage.id, ids[0]));
      expect(
        await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production'),
      ).toMatchObject({ activeAdmissions: 31, dailyAdmissions: 32 });
      expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({
        status: 'claimed',
      });
    },
  );

  it.each([0, 1])(
    'readback and admission count 5000 expired requests for the UTC day (%i internal)',
    async (internalCount) => {
      const fixture = await makeFixture();
      const economics = internal(
        { maxConcurrentRequests: 32, maxRequestsPerUtcDay: 5000 },
        fixture.applicationId,
      );
      const initial = await claimMeteredAdmission(
        admission(fixture, internalCount === 1 ? economics : commercial),
      );
      if (initial.status !== 'claimed') throw new Error('fixture claim failed');
      await getDb()
        .update(inferenceMeteredUsage)
        .set({ expiresAt: new Date(0) })
        .where(eq(inferenceMeteredUsage.id, initial.meteredUsageId));
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
      expect(await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production')).toEqual({
        schemaAvailable: true,
        activeAdmissions: 0,
        dailyAdmissions: 5000,
      });
      expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({
        status: 'capacity-exceeded',
        limit: 'daily',
      });
      // Moving a row across UTC midnight changes only the daily population.
      await getDb().execute(sql`update inference_metered_usage set created_at =
      (date_trunc('day', now() at time zone 'utc') at time zone 'utc') - interval '1 second'
      where id = ${initial.meteredUsageId}`);
      expect(
        await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production'),
      ).toMatchObject({ activeAdmissions: 0, dailyAdmissions: 4999 });
      expect(await claimMeteredAdmission(admission(fixture, economics))).toMatchObject({
        status: 'claimed',
      });
    },
  );

  it('readback preserves admission boundaries for application, environment, refusal and the two-day window', async () => {
    const fixture = await makeFixture();
    const other = await makeFixture();
    const active = await claimMeteredAdmission(admission(fixture, commercial));
    const refused = await claimMeteredAdmission(admission(fixture, commercial));
    const old = await claimMeteredAdmission(admission(fixture, commercial));
    if (active.status !== 'claimed' || refused.status !== 'claimed' || old.status !== 'claimed')
      throw new Error('fixture claim failed');
    await markMeteredAdmissionRefused(refused.meteredUsageId);
    await getDb().execute(sql`update inference_metered_usage set created_at = now() - interval '3 days',
      expires_at = now() + interval '1 day' where id = ${old.meteredUsageId}`);
    await claimMeteredAdmission({ ...admission(fixture, commercial), environment: 'development' });
    await claimMeteredAdmission(admission(other, commercial));
    expect(await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production')).toEqual({
      schemaAvailable: true,
      activeAdmissions: 1,
      dailyAdmissions: 1,
    });
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`set transaction read only, isolation level repeatable read`);
      expect(await readJevTechnicalMetering(tx, fixture.applicationId, 'production')).toEqual({
        schemaAvailable: true,
        activeAdmissions: 1,
        dailyAdmissions: 1,
      });
    });
    expect(
      await getDb()
        .select()
        .from(inferenceMeteredUsage)
        .where(
          and(
            eq(inferenceMeteredUsage.applicationId, fixture.applicationId),
            eq(inferenceMeteredUsage.status, 'admitted'),
          ),
        ),
    ).toHaveLength(3);
  });

  it.each([
    'alter table inference_metered_usage drop column final_authorized_provider',
    'alter table inference_metered_usage drop constraint inference_metered_usage_parent_check',
    'alter table inference_metered_usage drop constraint inference_metered_usage_final_authorization_check',
    'drop index inference_metered_usage_parent_idx',
  ])('blocks readback with missing required schema evidence: %s', async (statement) => {
    const fixture = await makeFixture();
    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(sql.raw(statement));
        expect(await readJevTechnicalMetering(tx, fixture.applicationId, 'production')).toEqual({
          schemaAvailable: false,
          activeAdmissions: 0,
          dailyAdmissions: 0,
        });
        throw new Error('rollback schema fixture');
      }),
    ).rejects.toThrow('rollback schema fixture');
    expect(
      await readJevTechnicalMetering(getDb(), fixture.applicationId, 'production'),
    ).toMatchObject({ schemaAvailable: true });
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
      admission(
        fixture,
        internal({ maxConcurrentRequests: 10, maxRequestsPerUtcDay: 10 }, fixture.applicationId),
      ),
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
    expect(
      await settle(fixture, claim.meteredUsageId, {
        input_tokens: 10,
        output_tokens: 10,
        images: 1,
      } as never),
    ).toEqual({ status: 'settled', tariff: 'unpriced' });
    expect(await row(claim.meteredUsageId)).toMatchObject({
      tariffStatus: 'unpriced',
      tariffAmount: null,
    });
  });

  it('settles once: a second settlement is refused and the first stands', async () => {
    const fixture = await makeFixture();
    const claim = await claimMeteredAdmission(admission(fixture, commercial));
    if (claim.status !== 'claimed') throw new Error('fixture claim failed');
    await settle(fixture, claim.meteredUsageId);
    expect(
      await settle(fixture, claim.meteredUsageId, { input_tokens: 9, output_tokens: 9 }),
    ).toEqual({
      status: 'not-admitted',
    });
    expect((await row(claim.meteredUsageId)).inputTokens).toBe(1000);
  });

  it('cannot attach a receipt to an internal request (the database refuses it)', async () => {
    const fixture = await makeFixture();
    const claim = await claimMeteredAdmission(
      admission(
        fixture,
        internal({ maxConcurrentRequests: 10, maxRequestsPerUtcDay: 10 }, fixture.applicationId),
      ),
    );
    if (claim.status !== 'claimed') throw new Error('fixture claim failed');
    await expect(
      getDb()
        .update(inferenceMeteredUsage)
        .set({ usageReceiptId: 'any-receipt' })
        .where(eq(inferenceMeteredUsage.id, claim.meteredUsageId)),
    ).rejects.toThrow();
  });
});

describe('terminal recovery from committed commercial receipts', () => {
  it('skips conflicting terminal rows before its batch limit and links a matching later row', async () => {
    const fixture = await makeFixture();
    await provisionBillingProfile({ accountId: fixture.accountId });
    await recordTopUp({
      idempotencyKey: `fund-${tag()}`,
      accountId: fixture.accountId,
      currency: 'USD',
      amount: '1.000000000000',
      actor: { kind: 'machine' },
    });
    const ids: string[] = [];
    for (const meteredTokens of [9, 1000]) {
      const input = admission(fixture, commercial);
      const claim = await claimMeteredAdmission(input);
      if (claim.status !== 'claimed') throw new Error('fixture claim failed');
      ids.push(claim.meteredUsageId);
      await settle(fixture, claim.meteredUsageId, {
        input_tokens: meteredTokens,
        output_tokens: 2000,
      });
      const result = await settleLedger({
        idempotencyKey: input.idempotencyKey,
        attribution: {
          accountId: fixture.accountId,
          applicationId: fixture.applicationId,
          applicationCredentialId: fixture.credentialId,
          requestId: input.requestId,
          environment: 'production',
        },
        outcome: 'completed',
        usageSource: 'provider_reported',
        units: { input_tokens: 1000, output_tokens: 2000 },
        resolvedModelReference: fixture.modelReference,
        servingProvider: 'synthetic',
        priceVersionId: fixture.priceVersionId,
      });
      if (result.status !== 'settled')
        throw new Error(`fixture settlement failed: ${result.status}`);
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
    await recordTopUp({
      idempotencyKey: `fund-${tag()}`,
      accountId: fixture.accountId,
      currency: 'USD',
      amount: '1.000000000000',
      actor: { kind: 'machine' },
    });
    const receipt = await settleLedger({
      idempotencyKey: input.idempotencyKey,
      attribution: {
        accountId: fixture.accountId,
        applicationId: fixture.applicationId,
        applicationCredentialId: fixture.credentialId,
        requestId: input.requestId,
        environment: 'production',
      },
      outcome: 'completed',
      usageSource: 'provider_reported',
      units: { input_tokens: 1000, output_tokens: 2000 },
      resolvedModelReference: fixture.modelReference,
      servingProvider: 'synthetic',
      priceVersionId: fixture.priceVersionId,
    });
    if (receipt.status !== 'settled')
      throw new Error(`fixture settlement failed: ${receipt.status}`);
    // Crash boundary: the immutable receipt exists, terminal metering does not.
    expect((await row(claim.meteredUsageId)).status).toBe('admitted');
    expect(await reconcileMeteredReceipts()).toBe(1);
    expect(await row(claim.meteredUsageId)).toMatchObject({
      status: 'settled',
      inputTokens: 1000,
      outputTokens: 2000,
      usageReceiptId: receipt.receipt.receiptId,
    });
    expect(await reconcileMeteredReceipts()).toBe(0);
    expect(
      await getDb()
        .select()
        .from(usageReceipts)
        .where(eq(usageReceipts.requestId, input.requestId)),
    ).toHaveLength(1);
    expect((await claimMeteredAdmission(input)).status).toBe('duplicate');
  });
});

describe('the cost-centre usage report', () => {
  function attempt(
    requestId: string,
    index: number,
    overrides: Partial<ProviderCostAttemptEvent> = {},
  ): ProviderCostAttemptEvent {
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
    const economics = internal(
      { maxConcurrentRequests: 10, maxRequestsPerUtcDay: 10 },
      fixture.applicationId,
    );

    const a = admission(fixture, economics);
    const claimA = await claimMeteredAdmission(a);
    const b = admission(fixture, economics);
    const claimB = await claimMeteredAdmission(b);
    const inFlight = await claimMeteredAdmission(admission(fixture, economics));
    if (
      claimA.status !== 'claimed' ||
      claimB.status !== 'claimed' ||
      inFlight.status !== 'claimed'
    ) {
      throw new Error('fixture claims failed');
    }
    await settle(fixture, claimA.meteredUsageId);
    await settle(fixture, claimB.meteredUsageId, {
      input_tokens: 10,
      output_tokens: 10,
      images: 1,
    } as never);

    // A failed first attempt and a served failover for A; an unknown-cost attempt for B.
    await ingestProviderCostAttempts([
      attempt(a.requestId, 0, {
        served: false,
        cost: { currency: 'USD', amountPicos: '2000000000' },
      }),
      attempt(a.requestId, 1),
      attempt(b.requestId, 0, { costSource: 'unknown', cost: null, rateCardVersionId: null }),
    ]);

    const report = await costCenterUsage({
      periodStart,
      periodEnd: new Date(Date.now() + 60_000),
      currency: 'USD',
    });
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
    const economics = internal(
      { maxConcurrentRequests: 10, maxRequestsPerUtcDay: 10 },
      fixture.applicationId,
    );
    const input = admission(fixture, economics);
    const partial = await claimMeteredAdmission(input);
    const expired = await claimMeteredAdmission({
      ...admission(fixture, economics),
      expiresInSeconds: -1,
    });
    if (partial.status !== 'claimed' || expired.status !== 'claimed')
      throw new Error('fixture claim failed');
    await settle(fixture, partial.meteredUsageId);
    await ingestProviderCostAttempts([
      attempt(input.requestId, 0, { costComplete: false }),
      attempt(input.requestId, 1, { cost: { currency: 'EUR', amountPicos: '10000000000' } }),
      attempt(input.requestId, 2, {
        costSource: 'provider_reported',
        cost: { currency: 'USD', amountPicos: '20000000000' },
      }),
    ]);
    const report = await costCenterUsage({
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 60_000),
      currency: 'USD',
    });
    expect(report.find((entry) => entry.costCenter?.accountId === fixture.accountId)).toMatchObject(
      {
        requestCount: 1,
        inFlightCount: 0,
        expiredCount: 1,
        providerCost: {
          amount: '0.030000000000',
          knownCount: 1,
          unknownCount: 0,
          partialCount: 1,
          missingRequestCount: 1,
          otherCurrencyCount: 1,
          providerReportedAmount: '0.020000000000',
          providerReportedCount: 1,
          estimatedAmount: '0.010000000000',
          estimatedCount: 1,
        },
      },
    );
    expect((await row(expired.meteredUsageId)).status).toBe('admitted');
  });
});

// Rolling-server cutover: old writers still insert directly and must obey the same barrier.
describe('permanent application authority cutover', () => {
  const originalEnvironment = process.env.OXY_CREDENTIAL_ENVIRONMENT;
  beforeAll(() => {
    process.env.OXY_CREDENTIAL_ENVIRONMENT = 'production';
  });
  afterAll(() => {
    if (originalEnvironment === undefined) delete process.env.OXY_CREDENTIAL_ENVIRONMENT;
    else process.env.OXY_CREDENTIAL_ENVIRONMENT = originalEnvironment;
  });
  async function workloadFixture() {
    const fixture = await makeFixture();
    await getDb()
      .update(applications)
      .set({ type: 'internal', isInternal: true })
      .where(eq(applications.id, fixture.applicationId));
    const [binding] = await getDb()
      .insert(applicationWorkloadIdentities)
      .values({
        applicationId: fixture.applicationId,
        provider: 'aws-iam',
        subject: `test-role-${tag()}`,
        environment: 'production',
      })
      .returning();
    const credentialId = workloadAttestationHandle(binding.subject);
    await getDb()
      .update(applicationCredentials)
      .set({
        id: credentialId,
        type: 'workload',
        publicKey: null,
        tokenPrefix: null,
        tokenHash: null,
        scopes: [],
        workloadIdentityId: binding.id,
      })
      .where(eq(applicationCredentials.id, fixture.credentialId));
    const reviewed = economicsConfig.INTERNAL_METERED_RELATIONSHIPS[0];
    if (!reviewed) throw new Error('Missing reviewed test source');
    jest.replaceProperty(economicsConfig, 'INTERNAL_METERED_RELATIONSHIPS', [
      ...economicsConfig.INTERNAL_METERED_RELATIONSHIPS,
      { ...reviewed, consumerApplicationId: fixture.applicationId },
    ]);
    return { ...fixture, credentialId };
  }
  const population = (f: Fixture): InferenceAuthorityPopulation => ({
    applicationId: f.applicationId,
    ownerAccountId: f.accountId,
    environment: 'production',
    credentialKind: 'application',
  });
  it('activates and exports with one connection and reads supervision in the caller transaction', async () => {
    const originalPoolSize = process.env.PG_MAX_POOL_SIZE;
    const originalCacheTtl = process.env.OXY_AUTHORITY_CACHE_TTL_MS;
    await closePostgres();
    process.env.PG_MAX_POOL_SIZE = '1';
    process.env.OXY_AUTHORITY_CACHE_TTL_MS = '60000';
    const cacheKeys: string[] = [];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await connectPostgres();
      const f = await workloadFixture();
      cacheKeys.push(f.accountId);
      const operation = async () => {
        const fence = await activateInferenceAuthorityFence(population(f));
        const manifest = await exportInferenceAuthorityFence(population(f));
        expect(manifest.fenceId).toBe(fence.id);
        expect(manifest.population.credentialIds).toContain(f.credentialId);
        expect(manifest.entries).toEqual([]);

        // A cached/global read cannot see this uncommitted safety restriction.
        const other = await workloadFixture();
        cacheKeys.push(other.accountId);
        expect(
          await resolveLiveAgencyWorkloadByHandle(other.applicationId, other.credentialId),
        ).not.toBeNull();
        const rollback = new Error('test-only rollback');
        await expect(
          getDb().transaction(async (tx) => {
            await tx.insert(supervisionProfiles).values({
              childAccountId: other.accountId,
              consentVersion: 'test-only',
            });
            expect(
              await resolveLiveAgencyWorkloadByHandle(
                other.applicationId,
                other.credentialId,
                new Date(),
                tx,
              ),
            ).toBeNull();
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        expect(
          await resolveLiveAgencyWorkloadByHandle(other.applicationId, other.credentialId),
        ).not.toBeNull();
      };
      await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Single-connection operation blocked')),
            5000,
          );
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
      for (const key of cacheKeys) invalidateSupervision(key);
      try {
        await closePostgres();
      } finally {
        if (originalPoolSize === undefined) delete process.env.PG_MAX_POOL_SIZE;
        else process.env.PG_MAX_POOL_SIZE = originalPoolSize;
        if (originalCacheTtl === undefined) delete process.env.OXY_AUTHORITY_CACHE_TTL_MS;
        else process.env.OXY_AUTHORITY_CACHE_TTL_MS = originalCacheTtl;
        await connectPostgres();
      }
    }
  }, 15_000);
  const rawValues = (input: MeteredAdmissionInput) => ({
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    accountId: input.accountId,
    applicationId: input.applicationId,
    applicationCredentialId: input.applicationCredentialId,
    environment: input.environment,
    economicTreatment: 'commercial' as const,
    economicPolicyVersion: INFERENCE_ECONOMIC_POLICY_VERSION,
    endpoint: input.endpoint,
    requestedModelReference: input.requestedModelReference,
    admittedModelReference: input.admittedModelReference,
    admittedProvider: input.admittedProvider,
    admittedDeploymentId: input.admittedDeploymentId,
    expiresAt: new Date(Date.now() - 60_000),
  });
  async function waitForBlockedAdvisory() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await getDb().execute<{ waiting: boolean }>(
        sql`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())) as waiting`,
      );
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Expected the competing admission/barrier to wait on its shared lock');
  }
  it('blocks upgraded and raw legacy admission, while allowing prior settlement and permanent export', async () => {
    const f = await workloadFixture();
    const input = admission(
      f,
      commercial,
      `oxy-edge:idem:${f.credentialId}:caller:key:with:colons`,
    );
    const result = await claimMeteredAdmission(input);
    expect(result.status).toBe('claimed');
    const fence = await activateInferenceAuthorityFence(population(f));
    expect((await activateInferenceAuthorityFence(population(f))).id).toBe(fence.id);
    expect(await claimMeteredAdmission(admission(f, commercial))).toEqual({
      status: 'authority-migrating',
    });
    const rejected = await getDb()
      .insert(inferenceMeteredUsage)
      .values(rawValues(admission(f, commercial)))
      .then(() => false, isInferenceAuthorityFenceError);
    expect(rejected).toBe(true);
    await expect(exportInferenceAuthorityFence(population(f))).rejects.toThrow('unresolved');
    await getDb()
      .update(inferenceMeteredUsage)
      .set({ expiresAt: new Date(0) })
      .where(eq(inferenceMeteredUsage.requestId, input.requestId));
    await expect(exportInferenceAuthorityFence(population(f))).rejects.toThrow('unresolved');
    if (result.status !== 'claimed') throw new Error('Expected admitted fixture');
    await settle(f, result.meteredUsageId);
    const manifest = await exportInferenceAuthorityFence(population(f));
    expect(manifest.unresolved).toEqual({ admissions: 0, grants: 0, holds: 0 });
    expect(manifest.population.credentialIds).toEqual([f.credentialId]);
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyKind: 'idempotency_key',
          key: 'caller:key:with:colons',
          bodyDigest: null,
          digestDomain: 'unknown',
        }),
        expect.objectContaining({ keyKind: 'request_id', key: input.requestId }),
      ]),
    );
    const { sha256, ...payload } = manifest;
    expect(sha256).toBe(createHash('sha256').update(canonicalize(payload)).digest('hex'));
    // Cross-language fixture: normalize only opaque fixture IDs and clock;
    // all manifest shape, daily accounting and alias kinds come from the real export.
    const normalized = {
      ...payload,
      fenceId: '01900000-0000-7000-8000-000000000001',
      activatedAt: '2026-11-13T00:00:00.000Z',
      exportedAt: '2026-11-13T01:00:00.000Z',
      population: {
        ...payload.population,
        applicationId: 'application-test',
        ownerAccountId: 'owner-test',
        credentialIds: ['workload-handle-test'],
      },
      dailyUsage: { ...payload.dailyUsage, utcDay: '2026-11-13' },
      entries: payload.entries.map((entry) => ({
        ...entry,
        credentialId: 'workload-handle-test',
        key: entry.keyKind === 'idempotency_key' ? 'synthetic-turn-1' : 'request-test',
        legacyAdmissionId: 'metered:legacy-admission-test',
        requestId: 'request-test',
      })),
    };
    expect({
      ...normalized,
      sha256: createHash('sha256').update(canonicalize(normalized)).digest('hex'),
    }).toEqual(
      JSON.parse(readFileSync(join(__dirname, 'fixtures/inference-fence-v2.json'), 'utf8')),
    );
    await expect(
      getDb().delete(inferenceAuthorityFences).where(eq(inferenceAuthorityFences.id, fence.id)),
    ).rejects.toThrow();
  });
  it('fences every credential and owner in the application/environment but no other application', async () => {
    const f = await workloadFixture();
    const other = await makeFixture();
    await getDb()
      .update(applicationCredentials)
      .set({ applicationId: f.applicationId })
      .where(eq(applicationCredentials.id, other.credentialId));
    await activateInferenceAuthorityFence(population(f));
    expect(
      (
        await claimMeteredAdmission(
          admission({ ...f, credentialId: other.credentialId }, commercial),
        )
      ).status,
    ).toBe('authority-migrating');
    const [session] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: f.applicationId,
        name: 'public-session',
        publicKey: `oxy_dk_${tag()}`,
        type: 'public',
        environment: 'production',
        scopes: [],
        status: 'active',
        createdByUserId: f.accountId,
      })
      .returning();
    expect(
      (await claimMeteredAdmission(admission({ ...f, credentialId: session.id }, commercial)))
        .status,
    ).toBe('authority-migrating');
    const [service] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: f.applicationId,
        name: 'secret-service',
        publicKey: `oxy_dk_${tag()}`,
        type: 'service',
        secretHash: 'synthetic-test-hash',
        environment: 'production',
        scopes: [],
        status: 'active',
        createdByUserId: f.accountId,
      })
      .returning();
    expect(
      (await claimMeteredAdmission(admission({ ...f, credentialId: service.id }, commercial)))
        .status,
    ).toBe('authority-migrating');
    expect((await claimMeteredAdmission(admission(await makeFixture(), commercial))).status).toBe(
      'claimed',
    );
  });
  it('requires actual live workload enrollment and a fence before export', async () => {
    const f = await makeFixture();
    await expect(activateInferenceAuthorityFence(population(f))).rejects.toThrow(
      'active first-party workload',
    );
    await expect(exportInferenceAuthorityFence(population(f))).rejects.toThrow(
      'Activate and drain',
    );
  });
  it('exports UTC application-wide consumption, all historical aliases and the effective Console limit', async () => {
    const f = await workloadFixture();
    const foreign = await makeFixture();
    await getDb()
      .update(applicationCredentials)
      .set({ applicationId: f.applicationId })
      .where(eq(applicationCredentials.id, foreign.credentialId));
    const settled = {
      status: 'settled' as const,
      outcome: 'completed' as const,
      usageSource: 'provider_reported' as const,
      settledAt: new Date(),
    };
    const today = sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
    const prior = sql`(date_trunc('day', now() at time zone 'utc') at time zone 'utc') - interval '1 millisecond'`;
    const inputs = [
      admission(f, commercial),
      admission(f, commercial),
      admission(f, commercial),
      admission({ ...foreign, applicationId: f.applicationId }, commercial),
    ];
    await getDb()
      .insert(inferenceMeteredUsage)
      .values(
        inputs.map((input, i) => ({
          ...rawValues(input),
          ...settled,
          createdAt: today,
          outcome:
            i === 1
              ? ('failed' as const)
              : i === 2
                ? ('cancelled' as const)
                : ('completed' as const),
          endpoint: i === 3 ? '/v1/realtime' : '/v1/responses',
        })),
      );
    const yesterday = admission(f, commercial);
    await getDb()
      .insert(inferenceMeteredUsage)
      .values([
        { ...rawValues(yesterday), ...settled, createdAt: prior },
        { ...rawValues(admission(f, commercial)), status: 'refused', createdAt: today },
        {
          ...rawValues(admission(f, commercial)),
          ...settled,
          environment: 'staging',
          createdAt: today,
        },
      ]);
    await getDb().insert(applicationInferenceLimits).values({
      applicationId: f.applicationId,
      maxRequestsPerUtcDay: 4,
      updatedByAccountId: f.accountId,
    });
    await activateInferenceAuthorityFence(population(f));
    const manifest = await exportInferenceAuthorityFence(population(f));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.dailyUsage).toEqual({
      scope: 'application_environment',
      utcDay: manifest.exportedAt.slice(0, 10),
      admitted: 4,
      maxRequestsPerUtcDay: 4,
    });
    expect(manifest.dailyUsage.admitted).toBe(
      (await readMeteredCapacity(getDb(), f.applicationId, 'production')).dailyAdmissions,
    );
    expect(manifest.population.credentialIds).toEqual([f.credentialId]);
    expect(
      manifest.entries
        .filter((entry) => entry.keyKind === 'request_id')
        .map((entry) => entry.key)
        .sort(),
    ).toEqual([...inputs.map((input) => input.requestId), yesterday.requestId].sort());
    const { sha256, ...payload } = manifest;
    expect(sha256).toBe(createHash('sha256').update(canonicalize(payload)).digest('hex'));
    expect((await exportInferenceAuthorityFence(population(f))).dailyUsage).toEqual(
      manifest.dailyUsage,
    );
    expect(
      (
        await claimMeteredAdmission(
          admission({ ...foreign, applicationId: f.applicationId }, commercial),
        )
      ).status,
    ).toBe('authority-migrating');
    expect(
      (await claimMeteredAdmission({ ...admission(f, commercial), environment: 'staging' })).status,
    ).toBe('claimed');
  });
  it('preserves old workload-only fences without treating them as a complete application cutover', async () => {
    const f = await workloadFixture();
    const other = await makeFixture();
    await getDb()
      .update(applicationCredentials)
      .set({ applicationId: f.applicationId })
      .where(eq(applicationCredentials.id, other.credentialId));
    await getDb()
      .insert(inferenceAuthorityFences)
      .values({ ...population(f), credentialKind: 'workload' });
    expect((await claimMeteredAdmission(admission(f, commercial))).status).toBe(
      'authority-migrating',
    );
    expect(
      (
        await claimMeteredAdmission(
          admission({ ...f, credentialId: other.credentialId }, commercial),
        )
      ).status,
    ).toBe('claimed');
    await expect(exportInferenceAuthorityFence(population(f))).rejects.toThrow(
      'Activate and drain',
    );
  });
  it('refuses unknown, ambiguous and relationship-only daily policies before activating', async () => {
    const f = await workloadFixture();
    const configured = economicsConfig.INTERNAL_METERED_RELATIONSHIPS;
    const relation = configured.find((item) => item.consumerApplicationId === f.applicationId);
    if (!relation) throw new Error('Missing fixture relationship');
    for (const replacements of [
      [],
      [relation, relation],
      [{ ...relation, capacity: { ...relation.capacity, scope: 'relationship' as const } }],
    ]) {
      jest.replaceProperty(economicsConfig, 'INTERNAL_METERED_RELATIONSHIPS', replacements);
      await expect(activateInferenceAuthorityFence(population(f))).rejects.toThrow(
        'unique reviewed',
      );
    }
    jest.replaceProperty(economicsConfig, 'INTERNAL_METERED_RELATIONSHIPS', configured);
    await activateInferenceAuthorityFence(population(f));
    expect(
      (await exportInferenceAuthorityFence(population(f))).dailyUsage.maxRequestsPerUtcDay,
    ).toBe(5000);
  });
  it('drains writers holding the old lock before the migration changes authority lock keys', async () => {
    const f = await workloadFixture();
    const oldMigration = readFileSync(
      join(__dirname, '../../../drizzle/0255_inference_authority_fences.sql'),
      'utf8',
    );
    const newMigration = readFileSync(
      join(__dirname, '../../../drizzle/0256_application_inference_authority.sql'),
      'utf8',
    );
    const oldFunctions = oldMigration
      .split('--> statement-breakpoint')
      .filter((statement) =>
        /CREATE FUNCTION oxy_inference_(authority_lock|admission_authority)/.test(statement),
      );
    const transition = newMigration
      .split('--> statement-breakpoint')
      .filter((statement) => /LOCK TABLE|CREATE OR REPLACE FUNCTION/.test(statement));
    expect(oldFunctions).toHaveLength(2);
    expect(transition).toHaveLength(3);
    for (const statement of oldFunctions)
      await getDb().execute(
        sql.raw(statement.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')),
      );
    let release: () => void = () => undefined;
    let announce: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const writer = getDb().transaction(async (tx) => {
      await tx.insert(inferenceMeteredUsage).values(rawValues(admission(f, commercial)));
      announce();
      await hold;
    });
    await inserted;
    const migration = getDb().transaction(async (tx) => {
      for (const statement of transition) await tx.execute(sql.raw(statement));
    });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = await getDb().execute<{ waiting: boolean }>(sql`
          select exists(select 1 from pg_locks where relation = 'inference_metered_usage'::regclass
            and mode = 'ShareRowExclusiveLock' and not granted
            and database = (select oid from pg_database where datname = current_database())) as waiting`);
        if (rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await writer;
      await migration;
    }
    await activateInferenceAuthorityFence(population(f));
    await expect(exportInferenceAuthorityFence(population(f))).rejects.toThrow('unresolved');
    const foreign = await makeFixture();
    expect(
      (
        await claimMeteredAdmission(
          admission({ ...foreign, applicationId: f.applicationId }, commercial),
        )
      ).status,
    ).toBe('authority-migrating');
  });
  it('serializes a committed old admission before activation and refuses export until it drains', async () => {
    const f = await workloadFixture();
    let unblock: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let announce: () => void = () => undefined;
    const inserted = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const oldWriter = getDb().transaction(async (tx) => {
      await tx.insert(inferenceMeteredUsage).values(rawValues(admission(f, commercial)));
      announce();
      await hold;
    });
    await inserted;
    const activation = activateInferenceAuthorityFence(population(f));
    try {
      await waitForBlockedAdvisory();
    } finally {
      unblock();
    }
    await oldWriter;
    await activation;
    await expect(exportInferenceAuthorityFence(population(f))).rejects.toThrow('unresolved');
  });
  it('serializes activation before an old writer and refuses its insert after the wait', async () => {
    const f = await workloadFixture();
    let unblock: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let announce: () => void = () => undefined;
    const inserted = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const barrier = getDb().transaction(async (tx) => {
      await tx.insert(inferenceAuthorityFences).values(population(f));
      announce();
      await hold;
    });
    await inserted;
    const writer = getDb()
      .insert(inferenceMeteredUsage)
      .values(rawValues(admission(f, commercial)))
      .then(() => false, isInferenceAuthorityFenceError);
    try {
      await waitForBlockedAdvisory();
    } finally {
      unblock();
    }
    await barrier;
    expect(await writer).toBe(true);
    const empty = await exportInferenceAuthorityFence(population(f));
    expect(empty.entries).toHaveLength(0);
    expect(empty.population.credentialIds).toEqual([f.credentialId]);
  });
  it('retains retired-handle history without authorizing it, and requires real grant/hold drain', async () => {
    const f = await workloadFixture();
    const input = admission(f, commercial);
    const result = await claimMeteredAdmission(input);
    if (result.status !== 'claimed') throw new Error('Expected admitted fixture');
    await settle(f, result.meteredUsageId);
    const [grant] = await getDb()
      .insert(kaanaGrants)
      .values({
        requestId: input.requestId,
        operation: 'responses',
        endpoint: '/v1/responses',
        lane: 'service_token',
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.credentialId,
        environment: 'production',
        economicTreatment: 'internal_metered',
        economicPolicyVersion: INFERENCE_ECONOMIC_POLICY_VERSION,
        meteredUsageId: result.meteredUsageId,
        bodySha256: 'a'.repeat(64),
        grantSha256: 'b'.repeat(64),
        signingKeyId: 'synthetic',
        issuedAt: new Date(0),
        executeBy: new Date(1000),
        expiresAt: new Date(2000),
      })
      .returning();
    const oldRequest = randomUUID();
    const [hold] = await getDb()
      .insert(usageReservations)
      .values({
        accountId: f.accountId,
        applicationId: f.applicationId,
        applicationCredentialId: f.credentialId,
        requestId: oldRequest,
        idempotencyKey: `oxy-edge:req:${oldRequest}`,
        environment: 'production',
        reservedAmount: '0.01',
        currency: 'USD',
        ceilingPriceVersionId: f.priceVersionId,
        expiresAt: new Date(0),
      })
      .returning();
    await activateInferenceAuthorityFence(population(f));
    await expect(exportInferenceAuthorityFence(population(f))).rejects.toThrow('unresolved');
    await getDb()
      .update(kaanaGrants)
      .set({ status: 'expired' })
      .where(eq(kaanaGrants.id, grant.id));
    await expect(exportInferenceAuthorityFence(population(f))).rejects.toThrow('unresolved');
    await getDb()
      .update(usageReservations)
      .set({ status: 'expired' })
      .where(eq(usageReservations.id, hold.id));
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ expiresAt: new Date(0) })
      .where(eq(applicationWorkloadIdentities.applicationId, f.applicationId));
    const manifest = await exportInferenceAuthorityFence(population(f));
    expect(manifest.population.credentialIds).toEqual([]);
    expect(manifest.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          credentialId: f.credentialId,
          key: input.requestId,
          legacyAdmissionId: `metered:${result.meteredUsageId}`,
        }),
        expect.objectContaining({
          credentialId: f.credentialId,
          key: oldRequest,
          legacyAdmissionId: `reservation:${hold.id}`,
        }),
      ]),
    );
  });
  it('uses immutable workload classification and authenticated history despite inert metadata changes', async () => {
    const f = await workloadFixture();
    await activateInferenceAuthorityFence(population(f));
    // Binding is still live production; inert attribution columns are not auth.
    await getDb()
      .update(applicationCredentials)
      .set({ environment: 'staging', status: 'revoked', expiresAt: new Date(0) })
      .where(eq(applicationCredentials.id, f.credentialId));
    expect(await claimMeteredAdmission(admission(f, commercial))).toEqual({
      status: 'authority-migrating',
    });
    expect((await exportInferenceAuthorityFence(population(f))).population.credentialIds).toEqual([
      f.credentialId,
    ]);
    await expect(
      getDb()
        .update(applicationCredentials)
        .set({ type: 'service', publicKey: `oxy_dk_${tag()}`, workloadIdentityId: null })
        .where(eq(applicationCredentials.id, f.credentialId)),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'application_credentials_workload_handle_id_check' },
    });
  });
  it('refuses unknown namespaces and contradictory ownership instead of losing a tombstone', () => {
    const row = {
      credential_id: 'wl_test',
      ledger_key: 'oxy-edge:idem:wl_test:actual:key',
      legacy_id: 'metered:one',
      request_id: 'req-one',
    };
    expect(legacyInferenceFenceEntries([row, row])).toHaveLength(2);
    expect(() => legacyInferenceFenceEntries([{ ...row, ledger_key: 'unknown:key' }])).toThrow(
      'namespace',
    );
    expect(() => legacyInferenceFenceEntries([row, { ...row, request_id: 'req-two' }])).toThrow(
      'ownership',
    );
  });
});
