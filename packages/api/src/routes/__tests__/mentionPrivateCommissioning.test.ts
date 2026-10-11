/** Synthetic source approvals + signed own-role HTTP + real SQL catalogue/authority/metering. No provider network. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  scopedExecutionAudienceSchema,
  type ScopedExecutionAudience,
  type InferenceRequest,
} from '@oxy.so/contracts';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import {
  applications,
  applicationCredentials,
  applicationWorkloadIdentities,
  users,
  inferenceDeployments,
  inferenceDeploymentRoutingScores,
  inferenceModels,
  inferenceModelRevisions,
  inferencePublishers,
  inferenceProviders,
  priceVersions,
  priceVersionUnitPrices,
  inferenceMeteredUsage,
  usageReservations,
  usageReceipts,
} from '../../db/schema';
import {
  claimMeteredAdmission,
  type MeteredAdmissionInput,
} from '../../services/inferenceMeteredUsage.service';
import type { EconomicTreatmentDecision } from '../../config/inferenceEconomicPolicy';
import * as approvalConfig from '../../config/mentionClassifierEconomics';
import { MENTION_CLASSIFIER_IDENTITY as identity } from '../../config/mentionClassifierEconomics';
import * as scoped from '../../services/scopedExecution.service';
import * as rollout from '../../config/rolloutFlags';
import * as credentialEnvironment from '../../utils/credentialEnvironment';
import { createNeutralRoutingPolicy } from '../__fixtures__/kaanaRuntimeFixtures';
import { resolveEffectiveRoutingPolicy } from '../../services/inferenceRoutingPolicy.service';
import {
  resolveEdgeRoute,
  resolveCatalogueViewer,
  UNCONSTRAINED_ROUTING,
  TEXT_COMPLETION_MODALITY,
  UNCONSTRAINED_EDGE_CAPACITY,
  selectRouteForViewer,
} from '../../services/inferenceCatalogue.service';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { createInferenceEdgeRouter } from '../inferenceEdge';
import type { KaanaClient } from '../../services/kaanaClient';
import { EDGE_ROLLOUT_ENVIRONMENT } from '../__fixtures__/kaanaAudioFixtures';
const viewer = resolveCatalogueViewer({
  type: 'first_party',
  isInternal: false,
});
const scopes = ['inference:invoke', 'inference:usage:read'];
const previous = Object.fromEntries(
  Object.keys(EDGE_ROLLOUT_ENVIRONMENT).map((k) => [k, process.env[k]]),
);
const oldUrl = process.env.DATABASE_URL;
let ownUrl: string;
let server: http.Server;
let audience: ScopedExecutionAudience;
let executions = 0;
const client: KaanaClient = {
  stream: async function* () {
    throw new Error('Synthetic decisions never stream');
  },
  attestDeployments: async () => ({
    snapshotId: 'synthetic-reviewed',
    scopedExecutionContractVersion: '3.6.0',
    deployments: [{ ...audience, regions: [], scopedExecution: audience }],
  }),
  execute: async (envelope: InferenceRequest) => {
    executions++;
    const route = envelope.authorizedRoutes?.[0];
    if (!route) throw new Error('Synthetic route missing');
    const now = new Date().toISOString();
    return {
      generationId: randomUUID(),
      output: [],
      finishReason: 'stop',
      decisions: [{ id: 'q', kind: 'noul', probability: 1 }],
      usage: {
        schemaVersion: 2,
        requestId: envelope.attribution.requestId,
        attribution: envelope.attribution,
        outcome: 'completed',
        units: [
          { unit: 'requests', quantity: 1 },
          { unit: 'input_tokens', quantity: 10 },
          { unit: 'output_tokens', quantity: 0 },
        ],
        usageSource: 'provider_reported',
        resolvedModelReference: route.modelReference,
        servingProvider: route.provider,
        deploymentId: route.deploymentId,
        routeSwitches: 0,
        startedAt: now,
        completedAt: now,
      },
    };
  },
};
jest.setTimeout(60000);
beforeAll(async () => {
  Object.assign(process.env, EDGE_ROLLOUT_ENVIRONMENT);
  ownUrl = await createTestDatabase();
  await connectPostgres();
  await getDb()
    .insert(users)
    .values({ id: identity.ownerAccountId, username: 'synthetic-mention' });
  await getDb().insert(applications).values({
    id: identity.applicationId,
    ownerAccountId: identity.ownerAccountId,
    createdByUserId: identity.ownerAccountId,
    name: 'Synthetic Mention',
    type: 'first_party',
    isOfficial: true,
    isInternal: false,
    status: 'active',
    scopes,
  });
  await getDb().insert(applicationWorkloadIdentities).values({
    id: identity.bindingId,
    applicationId: identity.applicationId,
    provider: 'aws-iam',
    subject: identity.subject,
    scopes,
  });
  await getDb().insert(applicationCredentials).values({
    id: identity.credentialId,
    applicationId: identity.applicationId,
    type: 'workload',
    name: 'Synthetic own workload',
    environment: 'production',
    workloadIdentityId: identity.bindingId,
    status: 'active',
    scopes: [],
  });
  await createNeutralRoutingPolicy({
    accountId: identity.ownerAccountId,
    applicationId: identity.applicationId,
    overrides: {
      optimiseFor: 'price',
      requireZeroDataRetention: true,
      prohibitTrainingOnCustomerData: true,
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/v1', createInferenceEdgeRouter({ kaanaClient: client }));
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', r);
  });
});
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await closePostgres();
  if (ownUrl) await dropTestDatabase(ownUrl);
  if (oldUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldUrl;
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  jest.spyOn(credentialEnvironment, 'workloadTokenEnvironment').mockReturnValue('production');
  executions = 0;
  await getDb()
    .delete(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
  await getDb()
    .update(applicationWorkloadIdentities)
    .set({ scopes, subject: identity.subject })
    .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
  await getDb()
    .update(applications)
    .set({ status: 'active' })
    .where(eq(applications.id, identity.applicationId));
});
async function post(f: Awaited<ReturnType<typeof fixture>>) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = signServiceTokenEd25519({
    type: 'service',
    appId: identity.applicationId,
    appName: 'Mention',
    credentialId: identity.credentialId,
    ownerAccountId: identity.ownerAccountId,
    environment: 'production',
    scopes,
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: issuedAt,
    exp: issuedAt + 300,
  });
  const data = JSON.stringify({
    model: f.modelReference,
    state: f.state,
    questions: [{ id: 'q', kind: 'noul', question: 'Synthetic?' }],
  });
  return new Promise<{
    status: number;
    body: unknown;
  }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        path: '/v1/decisions',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          'idempotency-key': f.audience.idempotencyKey,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error('synthetic HTTP timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
async function authorizedFixture(state = 'SYNTHETIC') {
  const f = await fixture(state);
  audience = f.audience;
  expect(scopedExecutionAudienceSchema.safeParse(audience)).toMatchObject({
    success: true,
  });
  f.authorizeFixture();
  jest
    .spyOn(scoped, 'scopedPermitForContext')
    .mockImplementation((c) => scoped.bindScopedPermit(f.audience, c));
  jest.spyOn(approvalConfig, 'mentionClassifierApproval').mockReturnValue({
    economicPolicyVersion: 'mention/synthetic-composition-v1',
    evidenceRef: 'synthetic-explicit-review',
    expiresAt: f.audience.expiresAt,
    deploymentId: f.audience.deploymentId,
    modelReference: f.modelReference,
    provider: 'openrouter',
    priceVersionId: f.price.id,
    routingPolicyId: f.audience.policy.routingPolicyId,
    routingPolicyVersion: f.audience.policy.policyVersion,
  });
  return f;
}
async function fixture(state = 'SYNTHETIC') {
  const key = randomUUID().replaceAll('-', '');
  const publisher = `private${key}`;
  const provider = `openrouter`;
  const deploymentId = `deployment-${key}`;
  await getDb().insert(inferencePublishers).values({
    slug: publisher,
    displayName: 'Synthetic commissioning publisher',
  });
  const [model] = await getDb()
    .insert(inferenceModels)
    .values({
      publisherSlug: publisher,
      slug: 'fixture',
      displayName: 'Synthetic commissioning model',
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: true,
      supportsJsonMode: true,
      supportsReasoning: false,
      supportsStreaming: false,
      supportsPromptCaching: false,
      apiFormats: ['decisions'],
      inputModalities: ['text'],
      outputModalities: ['decisions'],
      maxContextTokens: 32000,
      maxOutputTokens: 8192,
      licenseId: 'synthetic-reviewed',
      licenseDisplayName: 'Fixture',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    })
    .returning();
  const [revision] = await getDb()
    .insert(inferenceModelRevisions)
    .values({
      modelId: model.id,
      revision: 'fixture-v1',
      releasedAt: new Date(),
      isCurrent: true,
    })
    .returning();
  await getDb()
    .insert(inferenceProviders)
    .values({
      slug: provider,
      displayName: 'Synthetic commissioning provider',
      kind: 'third_party',
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    })
    .onConflictDoNothing();
  const modelReference = `${model.modelId}@fixture-v1`;
  const [price] = await getDb()
    .insert(priceVersions)
    .values({
      provider,
      modelReference,
      currency: 'USD',
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60000),
    })
    .returning();
  await getDb()
    .insert(priceVersionUnitPrices)
    .values(
      ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'requests'].map(
        (unit) => ({
          priceVersionId: price.id,
          unit: unit as 'input_tokens',
          amount: unit === 'input_tokens' ? '0.04' : '0',
          per: 1000000,
        }),
      ),
    );
  const policy = await resolveEffectiveRoutingPolicy(identity.applicationId);
  if (policy.status !== 'resolved') throw new Error('Synthetic policy missing');
  const audience = scopedExecutionAudienceSchema.parse({
    permitId: `permit-${key}`,
    idempotencyKey: `key-${key}`,
    fixtureSha256: scoped.hashScopedInput({
      format: 'decisions',
      decisions: {
        state,
        questions: [{ id: 'q', kind: 'noul', question: 'Synthetic?' }],
      },
    }),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    principal: {
      accountId: identity.ownerAccountId,
      applicationId: identity.applicationId,
      credentialId: identity.credentialId,
      environment: 'production',
    },
    policy: {
      routingPolicyId: policy.stored.policy.routingPolicyId,
      policyVersion: policy.stored.policy.policyVersion,
    },
    deploymentId,
    provider,
    keyId: `provider-key-${key}`,
    modelReference,
    upstreamModelId: 'fixture-v1',
    priceVersionId: price.id,
    providerRateCardVersionId: `card-${key}`,
    providerSourceVersion: `source-${key}`,
    maxCostUsd: '0.01',
  });
  const [deployment] = await getDb()
    .insert(inferenceDeployments)
    .values({
      modelRevisionId: revision.id,
      providerSlug: provider,
      internalRouteId: deploymentId,
      priceVersionId: price.id,
      scopedExecution: audience,
      regions: [],
      availabilityScope: 'platform_internal',
      commercialPermission: 'standard_application_use',
      permissionState: 'pending_review',
      status: 'disabled',
      legalReviewStatus: 'approved',
      legalReviewEvidenceRef: 'synthetic-legal-review',
      legalReviewedAt: new Date(),
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    })
    .returning();
  await getDb()
    .insert(inferenceDeploymentRoutingScores)
    .values({
      deploymentId,
      priceVersionId: price.id,
      priceScore: 42,
      priceSource: 'reviewed_scorecard',
      priceEvidenceRef: 'synthetic-real-price',
      latencySource: 'reviewed_scorecard',
      latencyEvidenceRef: 'synthetic-not-measured',
      latencyMeasurementWindowStart: new Date(0),
      latencyMeasurementWindowEnd: new Date(1),
      latencyValidUntil: new Date(2),
      throughputSource: 'reviewed_scorecard',
      throughputEvidenceRef: 'synthetic-not-measured',
      throughputMeasurementWindowStart: new Date(0),
      throughputMeasurementWindowEnd: new Date(1),
      throughputValidUntil: new Date(2),
      balancedSource: 'reviewed_scorecard',
      balancedEvidenceRef: 'synthetic-not-measured',
      balancedFormulaRef: 'synthetic-unmeasured',
      balancedValidUntil: new Date(2),
      changedAt: new Date(),
      fundingClass: 'standard_payg',
      fundingState: 'available',
      fundingEvidenceRef: 'synthetic-provider-price',
      reason: 'Private commissioning fixture; no measured benchmark',
      changedByUserId: 'fixture',
    });
  const resolve = (
    optimiseFor: 'price' | 'latency' | 'throughput' | 'balanced' = 'price',
    scope = audience,
  ) =>
    resolveEdgeRoute(
      viewer,
      modelReference,
      UNCONSTRAINED_ROUTING,
      TEXT_COMPLETION_MODALITY,
      optimiseFor,
      UNCONSTRAINED_EDGE_CAPACITY,
      {
        applicationId: audience.principal.applicationId,
        environment: 'production',
        scopedExecution: scope,
      },
    );
  const authorizeFixture = () =>
    jest
      .spyOn(scoped, 'privateCommissioningAudience')
      .mockImplementation((input, now = Date.now()) =>
        input !== undefined &&
        JSON.stringify(input) === JSON.stringify(audience) &&
        Date.parse(audience.expiresAt) > now
          ? audience
          : undefined,
      );
  return {
    state,
    audience,
    deployment,
    resolve,
    authorizeFixture,
    modelReference,
    price,
  };
}
it.each([false, true])(
  'admits own-role private classifier without funds or hold, commercial charging=%s',
  async (charging) => {
    const f = await authorizedFixture();
    jest.spyOn(rollout, 'isChargingAuthorized').mockReturnValue(charging);
    const result = await post(f);
    if (result.status !== 200) throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ status: 200 });
    expect(executions).toBe(1);
    const rows = await getDb()
      .select()
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      economicTreatment: 'internal_metered',
      economicRelationshipId: 'mention-jev-kaana',
      applicationCredentialId: identity.credentialId,
    });
    expect(
      await getDb()
        .select()
        .from(usageReservations)
        .where(eq(usageReservations.applicationId, identity.applicationId)),
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(usageReceipts)
        .where(eq(usageReceipts.applicationId, identity.applicationId)),
    ).toHaveLength(0);
    expect(await post(f)).toMatchObject({
      status: 429,
      body: { code: 'quota_exceeded' },
    });
    expect(executions).toBe(1);
  },
);
it.each([
  'binding-scope',
  'app-suspended',
  'foreign-role',
  'expired-approval',
  'missing-approval',
  'wrong-price',
  'legal-withdrawn',
  'privacy-drift',
  'expensive-quote',
] as const)('refuses %s without usage, reservation or provider execution', async (kind) => {
  const f = await authorizedFixture();
  jest.spyOn(rollout, 'isChargingAuthorized').mockReturnValue(false);
  if (kind === 'binding-scope')
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ scopes: ['inference:usage:read'] })
      .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
  if (kind === 'app-suspended')
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, identity.applicationId));
  if (kind === 'foreign-role')
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ subject: 'arn:aws:iam::237343248947:role/foreign-fixture' })
      .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
  if (kind === 'expired-approval')
    jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
      ...approvalConfig.mentionClassifierApproval()!,
      expiresAt: new Date(0).toISOString(),
    });
  if (kind === 'missing-approval')
    jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue(undefined);
  if (kind === 'wrong-price')
    jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
      ...approvalConfig.mentionClassifierApproval()!,
      priceVersionId: 'foreign',
    });
  if (kind === 'legal-withdrawn')
    await getDb()
      .update(inferenceDeployments)
      .set({ legalReviewStatus: 'not_started', legalReviewEvidenceRef: null })
      .where(eq(inferenceDeployments.id, f.deployment.id));
  if (kind === 'privacy-drift')
    await getDb()
      .update(inferenceDeployments)
      .set({ retainsPayloads: true, retentionDays: 30 })
      .where(eq(inferenceDeployments.id, f.deployment.id));
  if (kind === 'expensive-quote')
    await getDb()
      .update(priceVersionUnitPrices)
      .set({ amount: '100000' })
      .where(eq(priceVersionUnitPrices.priceVersionId, f.price.id));
  const r = await post(f);
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(executions).toBe(0);
  expect(
    await getDb()
      .select()
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
  ).toHaveLength(0);
  expect(
    await getDb()
      .select()
      .from(usageReservations)
      .where(eq(usageReservations.applicationId, identity.applicationId)),
  ).toHaveLength(0);
});
it('keeps the ordinary catalogue and unrelated Mention approval closed', async () => {
  jest.spyOn(approvalConfig, 'mentionClassifierApproval').mockReturnValue(undefined);
  expect(approvalConfig.mentionClassifierApproval()).toBeUndefined();
  expect(scoped.sourceReviewedScopedAudience(Number.POSITIVE_INFINITY)).toBeUndefined();
  const f = await fixture();
  expect(
    await selectRouteForViewer(viewer, f.modelReference, UNCONSTRAINED_ROUTING),
  ).toBeUndefined();
});
it('rechecks exact binding after attestation before durable admission', async () => {
  const f = await authorizedFixture();
  const original = client.attestDeployments!;
  jest.spyOn(client, 'attestDeployments').mockImplementation(async (...args) => {
    const result = await original(...args);
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ scopes: ['inference:usage:read'] })
      .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
    return result;
  });
  expect((await post(f)).status).toBeGreaterThanOrEqual(400);
  expect(executions).toBe(0);
  expect(
    await getDb()
      .select()
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
  ).toHaveLength(0);
});
it('preserves relationship concurrency while the first synthetic execution is in flight', async () => {
  const f = await authorizedFixture();
  jest.spyOn(rollout, 'isChargingAuthorized').mockReturnValue(false);
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const original = client.execute;
  jest.spyOn(client, 'execute').mockImplementation(async (...args) => {
    started();
    await wait;
    return original(...args);
  });
  const first = post(f);
  await Promise.race([
    entered,
    first.then((result) => {
      if (result.status !== 200) throw new Error(JSON.stringify(result));
    }),
  ]);
  try {
    expect(await post(f)).toMatchObject({
      status: 429,
      body: { code: 'rate_limited' },
    });
  } finally {
    release();
  }
  expect((await first).status).toBe(200);
  expect(executions).toBe(1);
  expect(
    await getDb()
      .select()
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
  ).toHaveLength(1);
});

it('counts the original failed request across the explicit review and admits only one additional distinct permit', async () => {
  const first = await authorizedFixture();
  const firstApproval = approvalConfig.mentionClassifierApproval();
  if (firstApproval === undefined) throw new Error('fixture approval missing');
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
    ...firstApproval,
    economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
  });
  expect((await post(first)).status).toBe(200);
  const [original] = await getDb()
    .select({ id: inferenceMeteredUsage.id })
    .from(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
  // A provider-processed failed row remains spent. Never mark it refused or delete it.
  await getDb()
    .update(inferenceMeteredUsage)
    .set({ outcome: 'failed' })
    .where(eq(inferenceMeteredUsage.id, original.id));
  const second = await authorizedFixture('SYNTHETIC DISTINCT PUBLIC POST');
  expect(second.audience.idempotencyKey).not.toBe(first.audience.idempotencyKey);
  expect(second.audience.fixtureSha256).not.toBe(first.audience.fixtureSha256); // synthetic inputs, not live post-selection evidence
  expect((await post(second)).status).toBe(429); // original cap1 remains unchanged
  const secondApproval = approvalConfig.mentionClassifierApproval();
  if (secondApproval === undefined) throw new Error('fixture approval missing');
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
    ...secondApproval,
    economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
    evidenceRef: `oxy1519/1572/mention-native-source-review/sha256:${'a'.repeat(64)}`,
    expiresAt: '2026-10-05T23:59:59Z',
    qualificationBudget: {
      utcDay: '2026-10-05',
      maxTotalRequests: 2,
      previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
    },
  });
  const secondResult = await post(second);
  // This source-reviewed qualification intentionally expires on its fixed UTC
  // day. Subsequent CI must verify refusal, never broaden the day to keep green.
  const [clock] = await getDb().execute<{ day: string }>(sql`select
    to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as day`);
  if (clock.day !== '2026-10-05') {
    expect(secondResult.status).toBeGreaterThanOrEqual(400);
    expect(executions).toBe(1);
    expect(
      await getDb()
        .select({ id: inferenceMeteredUsage.id })
        .from(inferenceMeteredUsage)
        .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
    ).toHaveLength(1);
    return;
  }
  expect(secondResult.status).toBe(200);
  const third = await authorizedFixture('SYNTHETIC THIRD POST');
  const thirdApproval = approvalConfig.mentionClassifierApproval();
  if (thirdApproval === undefined) throw new Error('fixture approval missing');
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
    ...thirdApproval,
    economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
    evidenceRef: `oxy1519/1572/mention-native-source-review/sha256:${'a'.repeat(64)}`,
    expiresAt: '2026-10-05T23:59:59Z',
    qualificationBudget: {
      utcDay: '2026-10-05',
      maxTotalRequests: 2,
      previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
    },
  });
  expect((await post(third)).status).toBe(429);
  expect(executions).toBe(2);
  const rows = await getDb()
    .select({
      id: inferenceMeteredUsage.id,
      outcome: inferenceMeteredUsage.outcome,
      relationship: inferenceMeteredUsage.economicRelationshipId,
      version: inferenceMeteredUsage.economicPolicyVersion,
    })
    .from(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.id === original.id)).toMatchObject({
    outcome: 'failed',
    version: 'oxy-mention-jev-native/2026-10-05.1',
  });
  expect(rows.every((r) => r.relationship === 'mention-jev-kaana')).toBe(true);
  expect(rows.some((r) => r.version === 'oxy-mention-jev-native/2026-10-05.2')).toBe(true);
});

function boundedAdmission(expiresAt: string): MeteredAdmissionInput {
  const id = randomUUID();
  const economics: EconomicTreatmentDecision = {
    treatment: 'internal_metered',
    policyVersion: 'oxy-mention-jev-native/2026-10-05.2',
    relationship: {
      relationshipId: 'mention-jev-kaana',
      consumerApplicationId: identity.applicationId,
      consumerProduct: 'mention',
      providerProduct: 'kaana',
      lane: 'service_token',
      environments: ['production'],
      capacity: {
        scope: 'relationship',
        maxConcurrentRequests: 1,
        maxRequestsPerUtcDay: 2,
        qualificationBudget: { utcDay: '2026-10-05', expiresAt },
      },
    },
  };
  return {
    requestId: id,
    idempotencyKey: `synthetic-qualified-${id}`,
    economics,
    accountId: identity.ownerAccountId,
    applicationId: identity.applicationId,
    applicationCredentialId: identity.credentialId,
    environment: 'production',
    endpoint: '/v1/decisions',
    requestedModelReference: 'synthetic/model@fixture',
    admittedModelReference: 'synthetic/model@fixture',
    admittedProvider: 'openrouter',
    admittedDeploymentId: 'synthetic-deployment',
    routingPolicyVersionId: undefined,
    ceiling: { amount: '0.01', currency: 'USD' },
    expiresInSeconds: 900,
  };
}
it('checks actual source expiry after waiting on the canonical capacity advisory lock', async () => {
  const lockKey = createHash('sha256')
    .update(`inference-capacity:${identity.applicationId}:production`)
    .digest()
    .readBigInt64BE();
  let entered!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((r) => {
    entered = r;
  });
  const untilRelease = new Promise<void>((r) => {
    release = r;
  });
  const blocker = getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lockKey.toString()}::bigint)`);
    entered();
    await untilRelease;
  });
  await locked;
  const input = boundedAdmission(new Date(Date.now() + 250).toISOString());
  const pending = claimMeteredAdmission(input);
  try {
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    release();
  }
  await blocker;
  expect(await pending).toMatchObject({ status: 'capacity-exceeded', limit: 'daily' });
  expect(
    await getDb()
      .select({ id: inferenceMeteredUsage.id })
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
  ).toHaveLength(0);
});
it.each([
  'foreign-owner',
  'foreign-credential',
  'other-day',
  'third-cap',
  'delegation',
  'missing-budget',
])('rejects closed qualification inputs in actual SQL before any claim: %s', async (kind) => {
  const input = boundedAdmission('2026-10-05T23:59:59Z');
  if (kind === 'foreign-owner') Object.assign(input, { accountId: 'foreign' });
  if (kind === 'foreign-credential') Object.assign(input, { applicationCredentialId: 'foreign' });
  if (kind === 'delegation') Object.assign(input, { delegatedUserId: 'foreign' });
  if (input.economics.treatment !== 'internal_metered') throw new Error('fixture');
  const capacity = input.economics.relationship.capacity;
  if (capacity.qualificationBudget === undefined) throw new Error('fixture budget missing');
  if (kind === 'other-day') Object.assign(capacity.qualificationBudget, { utcDay: '2026-10-06' });
  if (kind === 'missing-budget') Object.assign(capacity, { qualificationBudget: undefined });
  if (kind === 'third-cap') Object.assign(capacity, { maxRequestsPerUtcDay: 3 });
  expect(await claimMeteredAdmission(input)).toMatchObject({
    status: 'capacity-exceeded',
    limit: 'daily',
  });
  expect(
    await getDb()
      .select({ id: inferenceMeteredUsage.id })
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
  ).toHaveLength(0);
});

it('counts both prior settled failures under one relationship and admits only the explicit third qualification', async () => {
  const first = await authorizedFixture('SYNTHETIC CONSUMED FIRST POST');
  const firstApproval = approvalConfig.mentionClassifierApproval();
  if (firstApproval === undefined) throw new Error('fixture approval missing');
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
    ...firstApproval,
    economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
  });
  expect((await post(first)).status).toBe(200);
  const second = await authorizedFixture('SYNTHETIC CONSUMED SECOND POST');
  const secondApproval = approvalConfig.mentionClassifierApproval();
  if (secondApproval === undefined) throw new Error('fixture approval missing');
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
    ...secondApproval,
    economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
    evidenceRef: `oxy1519/1572/mention-native-source-review/sha256:${'a'.repeat(64)}`,
    expiresAt: '2026-10-05T23:59:59Z',
    qualificationBudget: {
      utcDay: '2026-10-05',
      maxTotalRequests: 2,
      previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
    },
  });
  const secondResult = await post(second);
  const [clock] = await getDb().execute<{ day: string }>(sql`select
    to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as day`);
  if (clock.day !== '2026-10-05') {
    expect(secondResult.status).toBeGreaterThanOrEqual(400);
    expect(executions).toBe(1);
    return; // This approval is intentionally not broadened to future CI days.
  }
  expect(secondResult.status).toBe(200);
  await getDb()
    .update(inferenceMeteredUsage)
    .set({ outcome: 'failed' })
    .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
  const previous = await getDb()
    .select({
      id: inferenceMeteredUsage.id,
      outcome: inferenceMeteredUsage.outcome,
      version: inferenceMeteredUsage.economicPolicyVersion,
    })
    .from(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
  expect(previous).toHaveLength(2);
  expect(previous.every((row) => row.outcome === 'failed')).toBe(true);
  const third = await authorizedFixture('SYNTHETIC DISTINCT THIRD POST');
  const thirdApproval = approvalConfig.mentionClassifierApproval();
  if (thirdApproval === undefined) throw new Error('fixture approval missing');
  expect((await post(third)).status).toBe(429); // .1 default cannot erase two failures.
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
    ...thirdApproval,
    economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
    evidenceRef: `oxy1519/1572/mention-native-source-review/sha256:${'a'.repeat(64)}`,
    expiresAt: '2026-10-05T23:59:59Z',
    qualificationBudget: {
      utcDay: '2026-10-05',
      maxTotalRequests: 2,
      previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
    },
  });
  expect((await post(third)).status).toBe(429); // .2 still has total2, no version reset.
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
    ...thirdApproval,
    economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.3',
    evidenceRef: `oxy1519/1572/mention-native-source-review/sha256:${'b'.repeat(64)}`,
    expiresAt: '2026-10-05T23:59:59Z',
    qualificationBudget: {
      utcDay: '2026-10-05',
      maxTotalRequests: 3,
      previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
    },
  });
  expect((await post(third)).status).toBe(200);
  const fourth = await authorizedFixture('SYNTHETIC FOURTH POST');
  const fourthApproval = approvalConfig.mentionClassifierApproval();
  if (fourthApproval === undefined) throw new Error('fixture approval missing');
  jest.mocked(approvalConfig.mentionClassifierApproval).mockReturnValue({
    ...fourthApproval,
    economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.3',
    evidenceRef: `oxy1519/1572/mention-native-source-review/sha256:${'b'.repeat(64)}`,
    expiresAt: '2026-10-05T23:59:59Z',
    qualificationBudget: {
      utcDay: '2026-10-05',
      maxTotalRequests: 3,
      previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
    },
  });
  expect((await post(fourth)).status).toBe(429);
  expect(executions).toBe(3);
  const rows = await getDb()
    .select({
      id: inferenceMeteredUsage.id,
      outcome: inferenceMeteredUsage.outcome,
      version: inferenceMeteredUsage.economicPolicyVersion,
      relationship: inferenceMeteredUsage.economicRelationshipId,
    })
    .from(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId));
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.relationship === 'mention-jev-kaana')).toBe(true);
  for (const old of previous) expect(rows.find((row) => row.id === old.id)).toMatchObject(old);
  expect(rows.filter((row) => row.version === 'oxy-mention-jev-native/2026-10-05.3')).toHaveLength(
    1,
  );
});

function thirdBoundedAdmission(expiresAt: string): MeteredAdmissionInput {
  const input = boundedAdmission(expiresAt);
  if (input.economics.treatment !== 'internal_metered') throw new Error('fixture');
  Object.assign(input.economics, { policyVersion: 'oxy-mention-jev-native/2026-10-05.3' });
  Object.assign(input.economics.relationship.capacity, { maxRequestsPerUtcDay: 3 });
  return input;
}
it.each(['expiry', 'day-drift'])(
  'rechecks third qualification after an actual advisory-lock wait: %s',
  async (kind) => {
    const lockKey = createHash('sha256')
      .update(`inference-capacity:${identity.applicationId}:production`)
      .digest()
      .readBigInt64BE();
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((r) => {
      entered = r;
    });
    const untilRelease = new Promise<void>((r) => {
      release = r;
    });
    const blocker = getDb().transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${lockKey.toString()}::bigint)`);
      entered();
      await untilRelease;
    });
    await locked;
    const input = thirdBoundedAdmission(
      kind === 'expiry' ? new Date(Date.now() + 250).toISOString() : '2026-10-05T23:59:59Z',
    );
    const pending = claimMeteredAdmission(input);
    try {
      let waiterObserved = false;
      for (let i = 0; i < 100; i++) {
        const [waiter] = await getDb().execute<{
          waiting: boolean;
        }>(sql`select exists(select 1 from pg_stat_activity
        where datname=current_database() and wait_event='advisory') as waiting`);
        if (waiter.waiting) {
          waiterObserved = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiterObserved).toBe(true);
      if (kind === 'expiry') await new Promise((r) => setTimeout(r, 400));
      else {
        if (input.economics.treatment !== 'internal_metered') throw new Error('fixture');
        const budget = input.economics.relationship.capacity.qualificationBudget;
        if (budget === undefined) throw new Error('fixture budget missing');
        Object.assign(budget, { utcDay: '2026-10-06' });
        // Adversarial queued day drift; DB clock is real, not advanced or mocked.
      }
    } finally {
      release();
    }
    await blocker;
    expect(await pending).toMatchObject({ status: 'capacity-exceeded', limit: 'daily' });
    expect(
      await getDb()
        .select({ id: inferenceMeteredUsage.id })
        .from(inferenceMeteredUsage)
        .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
    ).toHaveLength(0);
  },
);
it.each([
  'foreign-owner',
  'foreign-credential',
  'other-day',
  'fourth-cap',
  'wrong-version',
  'delegation',
  'missing-budget',
])('rejects closed third qualification inputs before SQL claim: %s', async (kind) => {
  const input = thirdBoundedAdmission('2026-10-05T23:59:59Z');
  if (kind === 'foreign-owner') Object.assign(input, { accountId: 'foreign' });
  if (kind === 'foreign-credential') Object.assign(input, { applicationCredentialId: 'foreign' });
  if (kind === 'delegation') Object.assign(input, { delegatedUserId: 'foreign' });
  if (input.economics.treatment !== 'internal_metered') throw new Error('fixture');
  const capacity = input.economics.relationship.capacity;
  if (capacity.qualificationBudget === undefined) throw new Error('fixture budget missing');
  if (kind === 'other-day') Object.assign(capacity.qualificationBudget, { utcDay: '2026-10-06' });
  if (kind === 'missing-budget') Object.assign(capacity, { qualificationBudget: undefined });
  if (kind === 'fourth-cap') Object.assign(capacity, { maxRequestsPerUtcDay: 4 });
  if (kind === 'wrong-version')
    Object.assign(input.economics, { policyVersion: 'oxy-mention-jev-native/2026-10-05.4' });
  expect(await claimMeteredAdmission(input)).toMatchObject({
    status: 'capacity-exceeded',
    limit: 'daily',
  });
  expect(
    await getDb()
      .select({ id: inferenceMeteredUsage.id })
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, identity.applicationId)),
  ).toHaveLength(0);
});
