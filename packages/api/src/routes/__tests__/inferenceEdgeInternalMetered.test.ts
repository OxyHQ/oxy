/**
 * `internal_metered` at the REAL edge, beside `commercial`, in ONE installation
 * with charging armed (#1526, plan item I09). Real Postgres, real ledger, real
 * credential lanes; only the data plane is fake.
 */

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import { normalizeResponsesRequest, responsesRequestSchema } from '../../schemas/inferenceEdge.schemas';
import { controlledInputBudget } from '../../services/inferenceInternalPilot';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { InferenceRequest } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { ALIA_INFERENCE_CONSUMER_APPLICATION_ID } from '../../config/inferenceEconomicPolicy';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import {
  accountBalances,
  applicationCredentials,
  applications,
  inferenceDeployments,
  inferenceMeteredUsage,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  priceVersions,
  priceVersionUnitPrices,
  usageReceipts,
  usageReservations,
  users,
} from '../../db/schema';
import { provisionBillingProfile, recordTopUp, recordPromotionalGrant } from '../../services/inferenceLedger.service';
import { reconcileMeteredReceipts } from '../../services/inferenceMeteredUsage.service';
import type { KaanaClient, KaanaCompletion } from '../../services/kaanaClient';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { createInferenceEdgeRouter } from '../inferenceEdge';
import * as economicPolicy from '../../config/inferenceEconomicPolicy';
import * as autoConfig from '../../config/autoClassification';
import * as decisionConfig from '../../config/decisionAvailability';
import * as catalogue from '../../services/inferenceCatalogue.service';
import * as powerLevels from '../../services/inferencePowerLevels.service';
import * as scoped from '../../services/scopedExecution.service';
import * as rollout from '../../config/rolloutFlags';
import { executeInferenceRequest, readGenerationReceipt, readGenerationReceiptByIdempotencyKey, type EdgeExecutionContext } from '../../services/inferenceEdge.service';
import { resolveEffectiveRoutingPolicy } from '../../services/inferenceRoutingPolicy.service';
import {
  attestFixtureDeployments,
  createNeutralRoutingPolicy,
  insertValidRoutingScorecard,
} from '../__fixtures__/kaanaRuntimeFixtures';

jest.setTimeout(60_000);

const ROLLOUT_ENVIRONMENT = {
  ACCESS_TOKEN_SECRET: 'inference-edge-internal-metered-test-secret-32-chars',
  INFERENCE_EDGE_AUDIENCE: 'public',
  INFERENCE_MACHINE_CREDENTIAL_AUTH: 'enabled',
  // Charging ARMED: the internal path must hold nothing even so.
  INFERENCE_CHARGING_AUTHORIZED: 'internal-metered-fixture:2026-10-02',
  INFERENCE_PRIVACY_REVIEW: 'internal-metered-fixture:2026-10-02',
} as const;
const ORIGINAL = Object.fromEntries(Object.keys(ROLLOUT_ENVIRONMENT).map((k) => [k, process.env[k]]));

let server: http.Server;
let executions = 0;
let pilotEnvelopes: InferenceRequest[] = [];
let behaviour: 'complete' | 'fail' = 'complete';
let nextGenerationId: string | undefined;

beforeAll(async () => {
  Object.assign(process.env, ROLLOUT_ENVIRONMENT);
  await connectPostgres();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', createInferenceEdgeRouter({ kaanaClient: fakeKaana() }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(() => {
  executions = 0;
  pilotEnvelopes = [];
  behaviour = 'complete';
  nextGenerationId = undefined;
});

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

interface RawResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function post(body: unknown, headers: Record<string, string>): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/responses',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        );
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getGeneration(id: string, headers: Record<string, string>): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port,
      path: `/v1/generations/${encodeURIComponent(id)}`, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function completionFor(envelope: InferenceRequest): KaanaCompletion {
  const route = envelope.authorizedRoutes[0];
  const now = new Date().toISOString();
  return {
    generationId: nextGenerationId ?? `gen-${randomUUID()}`,
    output: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }],
    finishReason: 'stop',
    usage: {
      schemaVersion: 2,
      requestId: envelope.attribution.requestId,
      attribution: envelope.attribution,
      outcome: 'completed',
      units: [
        { unit: 'input_tokens', quantity: 1000 },
        { unit: 'output_tokens', quantity: 2000 },
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
}

/** The fake data plane. Counts executions; fails on demand. */
function fakeKaana(): KaanaClient {
  return {
    attestDeployments: attestFixtureDeployments,
    execute: async (envelope) => {
      executions += 1;
      pilotEnvelopes.push(envelope);
      // Give concurrent duplicates a window to race the one that got in.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (behaviour === 'fail') throw new Error('synthetic transport failure');
      return completionFor(envelope);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const tag = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

async function makeAccount(kind: 'personal' | 'bot' = 'personal', parentAccountId?: string): Promise<string> {
  const t = tag();
  const [account] = await getDb()
    .insert(users)
    .values({
      username: `im-${t}`,
      email: `im-${t}@example.test`,
      kind,
      ...(parentAccountId === undefined ? {} : { parentAccountId }),
    })
    .returning({ id: users.id });
  return account.id;
}

/** An active machine credential; the service lane re-reads this same row. */
async function makeCredential(
  applicationId: string,
  ownerAccountId: string,
  environment: 'production' | 'development',
  scopes: string[] = ['inference:invoke']
): Promise<{ credentialId: string; token: string }> {
  const minted = generateMachineCredentialToken();
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: `key-${tag()}`,
      publicKey: `oxy_dk_${tag()}`,
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      type: 'machine',
      environment,
      scopes,
      status: 'active',
      createdByUserId: ownerAccountId,
    })
    .returning({ id: applicationCredentials.id });
  return { credentialId: credential.id, token: minted.token };
}

/** One priced ($3/M in, $15/M out), approved, servable route and a neutral policy. */
async function makeRoute(ownerAccountId: string, applicationId: string, createPolicy = true, pilot = false): Promise<string> {
  const db = getDb();
  const t = tag();
  const publisherSlug = pilot ? 'openai' : `pub${t}`;
  const modelSlug = pilot ? 'gpt-oss-120b' : `model-${t}`;
  const providerSlug = pilot ? 'cerebras' : `prov${t}`;
  const revision = pilot ? 'observed-2026-09-01' : '2026-01-01';
  await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: `Publisher ${t}` });
  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug, slug: modelSlug, displayName: `Model ${t}`,
      inputModalities: ['text'], outputModalities: ['text'],
      supportsTools: true, supportsParallelToolCalls: false, supportsStructuredOutput: true,
      supportsJsonMode: true, supportsReasoning: false, supportsStreaming: true, supportsPromptCaching: false,
      maxContextTokens: 200_000, maxOutputTokens: 8192,
      licenseId: 'apache-2.0', licenseDisplayName: 'Apache 2.0',
      commercialUseAllowed: true, requiresAttribution: false, releaseKind: 'open_weight',
    })
    .returning({ id: inferenceModels.id });
  const [revisionRow] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });
  await db.insert(inferenceProviders).values({
    slug: providerSlug, displayName: `Provider ${t}`, kind: 'third_party',
    retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true,
  });
  const [price] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${publisherSlug}/${modelSlug}@${revision}`, provider: providerSlug,
      status: 'active', effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });
  await db.insert(priceVersionUnitPrices).values([
    { priceVersionId: price.id, unit: 'requests', amount: '0.000000000000', per: 1 },
    { priceVersionId: price.id, unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 },
    { priceVersionId: price.id, unit: 'cached_input_tokens', amount: '3.000000000000', per: 1_000_000 },
    { priceVersionId: price.id, unit: 'output_tokens', amount: '15.000000000000', per: 1_000_000 },
    { priceVersionId: price.id, unit: 'reasoning_tokens', amount: '15.000000000000', per: 1_000_000 },
  ]);
  const kaanaDeploymentId = pilot ? 'dep_cerebras_gpt_oss_120b_observed_2026_09_01' : `kaana-im-${t}`;
  await db.insert(inferenceDeployments).values({
    modelRevisionId: revisionRow.id, providerSlug, internalRouteId: kaanaDeploymentId, regions: ['us-west-2'],
    retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true,
    availabilityScope: 'public_payg', commercialPermission: 'public_resale_approved', status: 'active',
    legalReviewStatus: 'approved', legalReviewedAt: new Date(), legalReviewEvidenceRef: `contract-register/${t}`,
    permissionState: 'approved', priceVersionId: price.id,
  });
  await insertValidRoutingScorecard({
    deploymentId: kaanaDeploymentId,
    priceVersionId: price.id,
    changedByUserId: ownerAccountId,
  });
  if (createPolicy) await createNeutralRoutingPolicy({ accountId: ownerAccountId, applicationId });
  return `${publisherSlug}/${modelSlug}`;
}

interface Caller {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly machineToken: string;
  readonly modelReference: string;
}

let aliaFixture: Promise<Caller> | undefined;

/**
 * Alia's application, at its PINNED id, internal, with NO billing profile at
 * all — the owner has no balance, no grant and no commercial profile. Created
 * once per suite: a routing policy is per application.
 */
function alia(): Promise<Caller> {
  aliaFixture ??= (async () => {
    const accountId = await makeAccount();
    await getDb()
      .insert(applications)
      .values({
        id: ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
        name: `Alia ${tag()}`,
        type: 'internal',
        isInternal: true,
        ownerAccountId: accountId,
        createdByUserId: accountId,
        scopes: ['inference:invoke'],
      })
      .onConflictDoUpdate({
        target: applications.id,
        set: { type: 'internal', isInternal: true, ownerAccountId: accountId, scopes: ['inference:invoke'] },
      });
    const credential = await makeCredential(ALIA_INFERENCE_CONSUMER_APPLICATION_ID, accountId, 'production');
    const modelReference = await makeRoute(accountId, ALIA_INFERENCE_CONSUMER_APPLICATION_ID);
    return {
      accountId,
      applicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
      credentialId: credential.credentialId,
      machineToken: credential.token,
      modelReference,
    };
  })();
  return aliaFixture;
}

/** An ordinary customer application on the machine lane, optionally funded. */
async function customer(fund?: string): Promise<Caller> {
  const accountId = await makeAccount();
  const [application] = await getDb()
    .insert(applications)
    .values({ name: `Customer ${tag()}`, ownerAccountId: accountId, createdByUserId: accountId, scopes: ['inference:invoke'] })
    .returning({ id: applications.id });
  // A machine key must match the runtime environment (`machine_environment_mismatch`).
  const credential = await makeCredential(application.id, accountId, 'development');
  const modelReference = await makeRoute(accountId, application.id);
  await provisionBillingProfile({ accountId });
  if (fund !== undefined) {
    await recordTopUp({
      idempotencyKey: `im-top-up-${tag()}`, accountId, currency: 'USD', amount: fund, actor: { kind: 'machine' },
    });
  }
  return { accountId, applicationId: application.id, credentialId: credential.credentialId, machineToken: credential.token, modelReference };
}

/** A service JWT as `POST /auth/service-token` mints one; the edge re-reads the row. */
function serviceToken(caller: Caller, scopes: string[] = ['inference:invoke']): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signServiceTokenEd25519({
    type: 'service',
    appId: caller.applicationId,
    appName: 'Alia',
    credentialId: caller.credentialId,
    ownerAccountId: caller.accountId,
    environment: 'production',
    scopes,
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: issuedAt,
    exp: issuedAt + 300,
  });
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const body = (caller: Caller) => ({ model: caller.modelReference, input: 'Say hello.', maxOutputTokens: 3000 });

async function meteredFor(requestId: unknown) {
  const [row] = await getDb()
    .select()
    .from(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.requestId, String(requestId)));
  return row;
}

async function moneyRowsFor(accountId: string) {
  const db = getDb();
  return {
    reservations: await db.select().from(usageReservations).where(eq(usageReservations.accountId, accountId)),
    receipts: await db.select().from(usageReceipts).where(eq(usageReceipts.accountId, accountId)),
    balances: await db.select().from(accountBalances).where(eq(accountBalances.accountId, accountId)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Cases                                                                     */
/* -------------------------------------------------------------------------- */

// Mechanism fixtures deliberately use a synthetic relationship with no production
// pilot. They verify durable metering/capacity/Auto, not deployment allowlisting.
const resolveProductionEconomics = economicPolicy.resolveEconomicTreatment;
function useMechanismRelationship() {
  jest.spyOn(economicPolicy, 'resolveEconomicTreatment').mockImplementation((principal) =>
    resolveProductionEconomics(principal, economicPolicy.INTERNAL_METERED_RELATIONSHIPS.map((relationship) => {
      const { pilot: _pilot, ...mechanism } = relationship;
      return mechanism;
    }), 'synthetic-metering-mechanism'));
}
afterEach(() => jest.restoreAllMocks());

describe('one installation, charging armed', () => {
  beforeEach(useMechanismRelationship);
  it('serves Alia internal_metered with no money at all, and charges an external customer', async () => {
    const internal = await alia();
    const internalResponse = await post(body(internal), bearer(serviceToken(internal)));
    expect(internalResponse).toMatchObject({ status: 200 });

    const internalRow = await meteredFor(internalResponse.body.requestId);
    expect(internalRow).toMatchObject({
      status: 'settled',
      economicTreatment: 'internal_metered',
      economicRelationshipId: 'alia-kaana',
      outcome: 'completed',
      inputTokens: 1000,
      outputTokens: 2000,
      tariffStatus: 'quoted',
      // A positive cost-equivalent is recorded…
      tariffAmount: '0.033000000000',
      // …and nothing is charged: no receipt, no hold, no balance, no profile.
      usageReceiptId: null,
    });
    expect(await moneyRowsFor(internal.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });

    const external = await customer('10.000000000000');
    const externalResponse = await post(body(external), bearer(external.machineToken));
    expect(externalResponse).toMatchObject({ status: 200 });
    const externalRow = await meteredFor(externalResponse.body.requestId);
    const money = await moneyRowsFor(external.accountId);
    expect(money.receipts).toHaveLength(1);
    expect(money.receipts[0].billedAmount).toBe('0.033000000000');
    expect(externalRow).toMatchObject({
      economicTreatment: 'commercial',
      economicRelationshipId: null,
      tariffAmount: '0.033000000000',
      usageReceiptId: money.receipts[0].id,
    });
    expect(executions).toBe(2);
  });

  it('reads a delegated commercial receipt after key rotation without requiring the attribution header', async () => {
    const external = await customer('10.000000000000');
    const delegated = await makeAccount();
    const response = await post(body(external), { ...bearer(external.machineToken), 'X-Oxy-User-Id': delegated });
    expect(response.status).toBe(200);
    const money = await moneyRowsFor(external.accountId);
    expect(money.receipts).toHaveLength(1);
    expect(money.receipts[0].delegatedUserId).toBe(delegated);
    await getDb().update(applications).set({ scopes: ['inference:invoke', 'inference:usage:read'] }).where(eq(applications.id, external.applicationId));
    const rotated = await makeCredential(external.applicationId, external.accountId, 'development', ['inference:invoke', 'inference:usage:read']);
    await getDb().update(applicationCredentials).set({ status: 'revoked' }).where(eq(applicationCredentials.id, external.credentialId));
    const id = String(response.body.requestId);
    const record = await getGeneration(id, bearer(rotated.token));
    expect(record).toMatchObject({ status: 200, body: { data: { schemaVersion: 1, requestId: id,
      credentialId: external.credentialId, delegatedUserId: delegated, billedAmount: '0.033000000000' } } });
    expect(await getGeneration(id, { ...bearer(rotated.token), 'X-Oxy-User-Id': delegated })).toEqual(record);
    expect(await getGeneration(id, { ...bearer(rotated.token), 'X-Oxy-User-Id': await makeAccount() })).toMatchObject({ status: 404 });
    expect(await getGeneration(id, bearer(external.machineToken))).toMatchObject({ status: 401 });
    const noReadScope = await makeCredential(external.applicationId, external.accountId, 'development');
    expect(await getGeneration(id, bearer(noReadScope.token))).toMatchObject({ status: 404 });
    const other = await customer();
    await getDb().update(applications).set({ scopes: ['inference:invoke', 'inference:usage:read'] }).where(eq(applications.id, other.applicationId));
    const otherCredential = await makeCredential(other.applicationId, other.accountId, 'development', ['inference:invoke', 'inference:usage:read']);
    expect(await getGeneration(id, bearer(otherCredential.token))).toMatchObject({ status: 404 });
    // Authentication validates each credential's own environment. Application
    // entitlement can then read a historical receipt from another environment.
    const production = await makeCredential(external.applicationId, external.accountId, 'production', ['inference:invoke', 'inference:usage:read']);
    const productionCaller = { ...external, credentialId: production.credentialId, machineToken: production.token };
    expect(await getGeneration(id, bearer(serviceToken(productionCaller, ['inference:invoke', 'inference:usage:read'])))).toEqual(record);
    const newOwner = await makeAccount();
    await getDb().update(applications).set({ ownerAccountId: newOwner }).where(eq(applications.id, external.applicationId));
    const transferred = await makeCredential(external.applicationId, newOwner, 'development', ['inference:invoke', 'inference:usage:read']);
    expect(await getGeneration(id, bearer(transferred.token))).toEqual(record);
    expect((await moneyRowsFor(external.accountId)).receipts).toEqual(money.receipts);
    expect(executions).toBe(1);
  });

  it('recovers an actual metering write failure after the edge committed its receipt without re-executing or charging twice', async () => {
    const external = await customer('10.000000000000');
    const key = `recovery-${tag()}`;
    const db = getDb();
    const triggerName = `metering_failure_${tag()}`;
    await db.execute(sql`
      create function ${sql.raw(triggerName)}() returns trigger language plpgsql as $$
      begin raise exception 'synthetic terminal metering write failure'; end $$`);
    await db.execute(sql`create trigger ${sql.raw(triggerName)} before update on inference_metered_usage
      for each row when (new.status = 'settled' and old.account_id = '${sql.raw(external.accountId)}')
      execute function ${sql.raw(triggerName)}()`);
    let response: RawResponse | undefined;
    try {
      response = await post(body(external), { ...bearer(external.machineToken), 'Idempotency-Key': key });
      expect(response.status).toBe(200);
      expect(executions).toBe(1);
      const usage = await meteredFor(response.body.requestId);
      const money = await moneyRowsFor(external.accountId);
      expect(usage).toMatchObject({ status: 'admitted', usageReceiptId: null });
      expect(money.receipts).toHaveLength(1);
      expect(money.receipts[0]).toMatchObject({ inputTokens: 1000, outputTokens: 2000,
        billedAmount: '0.033000000000' });
    } finally {
      await db.execute(sql`drop trigger ${sql.raw(triggerName)} on inference_metered_usage`);
      await db.execute(sql`drop function ${sql.raw(triggerName)}()`);
    }
    expect(await reconcileMeteredReceipts()).toBe(1);
    if (response === undefined) throw new Error('missing completed edge response');
    const recovered = await meteredFor(response.body.requestId);
    expect(recovered).toMatchObject({ status: 'settled', inputTokens: 1000, outputTokens: 2000,
      tariffAmount: '0.033000000000' });
    expect(recovered.usageReceiptId).not.toBeNull();
    expect(await reconcileMeteredReceipts()).toBe(0);
    const replay = await post(body(external), { ...bearer(external.machineToken), 'Idempotency-Key': key });
    expect(replay).toMatchObject({ status: 409, body: { code: 'idempotency_conflict' } });
    expect(executions).toBe(1);
    const money = await moneyRowsFor(external.accountId);
    expect(money.receipts).toHaveLength(1);
    expect(money.balances[0].purchasedBalance).toBe('9.967000000000');
  });

  it('still refuses an external customer with no funds, before anything is forwarded', async () => {
    const external = await customer();
    const response = await post(body(external), bearer(external.machineToken));
    expect(response).toMatchObject({ status: 402, body: { code: 'insufficient_balance' } });
    expect(executions).toBe(0);
    // The claim was released: refused, holding neither the key nor a slot.
    const [row] = await getDb()
      .select()
      .from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, external.applicationId));
    expect(row).toMatchObject({ status: 'refused', economicTreatment: 'commercial' });
  });
});

describe('nothing a caller sends selects the internal treatment', () => {
  beforeEach(useMechanismRelationship);
  it('ignores a forged treatment header and an internal or bot delegated user', async () => {
    const internal = await alia();
    const external = await customer('10.000000000000');
    const bot = await makeAccount('bot', external.accountId);
    for (const delegated of [internal.accountId, bot]) {
      const response = await post(body(external), {
        ...bearer(external.machineToken),
        'X-Oxy-Economic-Treatment': 'internal_metered',
        'X-Oxy-User-Id': delegated,
      });
      expect(response).toMatchObject({ status: 200 });
      const row = await meteredFor(response.body.requestId);
      expect(row).toMatchObject({ economicTreatment: 'commercial', delegatedUserId: delegated });
      expect(row.usageReceiptId).not.toBeNull();
    }
    expect((await moneyRowsFor(external.accountId)).receipts).toHaveLength(2);
  });

  it('refuses a treatment field in the body rather than reading it', async () => {
    const external = await customer('10.000000000000');
    const response = await post(
      { ...body(external), economicTreatment: 'internal_metered' },
      bearer(external.machineToken)
    );
    expect(response.status).toBe(400);
    expect(executions).toBe(0);
  });

  it('drops Alia to commercial the moment its application is no longer internal', async () => {
    const internal = await alia();
    const flip = (isInternal: boolean) =>
      getDb().update(applications).set({ isInternal }).where(eq(applications.id, internal.applicationId));
    await flip(false);
    try {
      const response = await post(body(internal), bearer(serviceToken(internal)));
      // Commercial, and Alia's owner has no billing profile: refused, not served.
      expect(response).toMatchObject({ status: 402, body: { code: 'insufficient_balance' } });
      expect(executions).toBe(0);
    } finally {
      await flip(true);
    }
  });
});

describe('internal_metered keeps the guards a hold used to imply', () => {
  beforeEach(useMechanismRelationship);
  it('runs N concurrent retries of one Idempotency-Key exactly once', async () => {
    const internal = await alia();
    const key = `retry-${tag()}`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(body(internal), { ...bearer(serviceToken(internal)), 'Idempotency-Key': key })
      )
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.body.code === 'idempotency_conflict')).toHaveLength(4);
    expect(executions).toBe(1);

    // A NEW deliberate request (new key) is a new execution.
    const fresh = await post(body(internal), { ...bearer(serviceToken(internal)), 'Idempotency-Key': `retry-${tag()}` });
    expect(fresh.status).toBe(200);
    expect(executions).toBe(2);
  });

  it('blocks on exhausted technical capacity without ever asking for a top-up', async () => {
    const internal = await alia();
    // Fill the relationship's concurrency budget with in-flight claims.
    await getDb().execute(sql`
      insert into inference_metered_usage (
        id, request_id, idempotency_key, economic_treatment, economic_policy_version,
        economic_relationship_id, account_id, application_id, application_credential_id,
        environment, endpoint, requested_model_reference, admitted_model_reference,
        admitted_provider, admitted_deployment_id, expires_at
      )
      select gen_random_uuid()::text, 'fill-' || g || '-' || ${tag()}, 'fill-' || g || '-' || ${tag()},
        'internal_metered', 'fixture', 'alia-kaana', ${internal.accountId}, ${internal.applicationId},
        ${internal.credentialId}, 'production', '/v1/responses', 'x/y', 'x/y', 'p', 'd',
        now() + interval '10 minutes'
      from generate_series(1, 32) g
    `);
    try {
      const response = await post(body(internal), bearer(serviceToken(internal)));
      expect(response).toMatchObject({ status: 429, body: { code: 'rate_limited' } });
      expect(JSON.stringify(response.body)).not.toMatch(/balance|fund|top.?up/i);
      expect(executions).toBe(0);
    } finally {
      await getDb()
        .update(inferenceMeteredUsage)
        .set({ status: 'refused' })
        .where(and(eq(inferenceMeteredUsage.economicPolicyVersion, 'fixture'), eq(inferenceMeteredUsage.status, 'admitted')));
    }
  });

  it('records a failed execution durably, with no receipt', async () => {
    const internal = await alia();
    behaviour = 'fail';
    const response = await post(body(internal), bearer(serviceToken(internal)));
    expect(response.status).toBeGreaterThanOrEqual(500);
    const row = await meteredFor(response.body.requestId);
    expect(row).toMatchObject({ status: 'settled', outcome: 'failed', usageReceiptId: null });
    expect((await moneyRowsFor(internal.accountId)).receipts).toEqual([]);
  });
});


/** Real claims/metering/ledger; catalogue review and data plane are synthetic. */
async function internalAutoFixture() {
  const caller = await alia();
  const highModel = await makeRoute(caller.accountId, caller.applicationId, false);
  const db = getDb();
  const routeFor = async (model: string): Promise<catalogue.EdgeRoute> => {
    const [price] = await db.select().from(priceVersions).where(sql`${priceVersions.modelReference} like ${`${model}@%`}`).limit(1);
    const [deployment] = await db.select().from(inferenceDeployments).where(eq(inferenceDeployments.priceVersionId, price.id)).limit(1);
    if (deployment.internalRouteId === null) throw new Error('Fixture lacks deployment');
    return { modelReference: price.modelReference, provider: price.provider, priceVersionId: price.id,
      deploymentId: deployment.internalRouteId, regions: ['us-west-2'], maxContextTokens: 200_000, maxOutputTokens: 8192,
      fundingPriority: 4, routingScore: 100, reasoning: false, availabilityScope: 'public_payg',
      inputModalities: ['text'], outputModalities: ['text'], reasoningEfforts: [], acceptedParameters: null,
      apiFormats: ['responses', 'decisions'] };
  };
  const floor = await routeFor(caller.modelReference);
  const high = await routeFor(highModel);
  await db.update(priceVersionUnitPrices).set({ amount: '0.010000000000' }).where(and(eq(priceVersionUnitPrices.priceVersionId, floor.priceVersionId), eq(priceVersionUnitPrices.unit, 'input_tokens')));
  await db.update(priceVersionUnitPrices).set({ amount: '0.000000000000' }).where(and(eq(priceVersionUnitPrices.priceVersionId, floor.priceVersionId), eq(priceVersionUnitPrices.unit, 'output_tokens')));
  const principal = { lane: 'service_token' as const, ownerAccountId: caller.accountId,
    applicationId: caller.applicationId, credentialId: caller.credentialId, environment: 'production' as const,
    scopes: ['inference:invoke', 'inference:usage:read'], applicationIsInternal: true, applicationType: 'internal' as const };
  const pinned = await resolveEffectiveRoutingPolicy(principal.applicationId);
  if (pinned.status !== 'resolved') throw new Error('Fixture lacks policy');
  jest.spyOn(autoConfig, 'autoClassifierApproval').mockReturnValue({ reviewId: 'synthetic-only', reviewVersion: 1,
    deploymentId: floor.deploymentId, modelReference: floor.modelReference, provider: floor.provider, regions: floor.regions,
    routingPolicy: { routingPolicyId: pinned.stored.policy.routingPolicyId, policyVersion: pinned.stored.policy.policyVersion },
    commercial: true, internalEligibility: true, privacy: true, zdr: true });
  jest.spyOn(decisionConfig, 'decisionAvailability').mockReturnValue({ available: true, reason: 'synthetic-only' });
  jest.spyOn(catalogue, 'resolveRoutingProfileForEdgeById').mockResolvedValue({ status: 'power-level', routingProfileId: 'fixture-auto', powerLevel: 'auto', slug: 'auto', optimiseFor: 'price' });
  jest.spyOn(powerLevels, 'powerLevelProfileIds').mockResolvedValue(new Map([['instant', 'fixture-instant'], ['medium', 'fixture-medium'], ['high', 'fixture-high'], ['xhigh', 'fixture-xhigh']]));
  jest.spyOn(powerLevels, 'powerLevelEfforts').mockResolvedValue(new Map());
  jest.spyOn(catalogue, 'powerLevelCandidates').mockImplementation(async (_viewer, levels) => [{ modelReference: floor.modelReference, priority: 0, level: 'instant' as const }, { modelReference: high.modelReference, priority: 2, level: 'high' as const }].filter(candidate => levels.includes(candidate.level)));
  const routes = jest.spyOn(catalogue, 'resolveEdgeRoute').mockImplementation(async (_viewer, reference) => ({ status: 'resolved', route: reference === high.modelReference ? high : floor, alternates: [] }));
  const forwarded: InferenceRequest[] = [];
  let afterChild: (() => Promise<void>) | undefined;
  const client: KaanaClient = {
    attestDeployments: async (ids) => ({ snapshotId: 'synthetic-only', deployments: ids.map(id => id === high.deploymentId ? high : floor) }),
    execute: async (envelope) => {
      forwarded.push(envelope);
      await new Promise(resolve => setTimeout(resolve, 30));
      const result = completionFor(envelope);
      if (envelope.input.format === 'decisions') {
        await afterChild?.();
        return { ...result, output: [], usage: { ...result.usage, units: [{ unit: 'input_tokens', quantity: 1000 }, { unit: 'output_tokens', quantity: 0 }] }, decisions: [{ id: 'auto-power-level', kind: 'choice', reply: 'high', confidence: 1, probabilities: [0, 0, 1, 0] }] };
      }
      return result;
    },
  };
  const context: EdgeExecutionContext = { requestId: `auto-${tag()}`, receivedAt: performance.now(), principal,
    delegatedUserId: caller.accountId, idempotencyKey: `auto-key-${tag()}`,
    request: { operation: { kind: 'completion' }, target: { kind: 'routing_profile_id', routingProfileId: 'fixture-auto' }, input: { format: 'text', text: 'Synthetic puzzle' }, tools: [], sampling: {}, stream: false, maxOutputTokens: 3000 },
    signal: new AbortController().signal, kaanaClient: client, endpoint: '/v1/responses', apiFormat: 'responses' };
  return { caller, context, floor, high, routes, forwarded, setAfterChild: (f: () => Promise<void>) => { afterChild = f; } };
}

describe('I10 durable internal Auto and generation records', () => {
  beforeEach(useMechanismRelationship);
  afterEach(() => jest.restoreAllMocks());
  it('claims parent before a racing child, meters both and takes no financial hold', async () => {
    const f = await internalAutoFixture();
    const results = await Promise.all([executeInferenceRequest(f.context), executeInferenceRequest({ ...f.context, requestId: `raced-${tag()}` })]);
    if (!results.some(r => r.status === 'completed')) throw new Error(JSON.stringify(results));
    expect(results.filter(r => r.status === 'completed')).toHaveLength(1);
    expect(results.filter(r => r.status === 'refused')).toHaveLength(1);
    expect(f.forwarded).toHaveLength(2);
    const [parent] = await getDb().select().from(inferenceMeteredUsage).where(and(eq(inferenceMeteredUsage.idempotencyKey, `oxy-edge:idem:${f.context.principal.credentialId}:${f.context.idempotencyKey}`), eq(inferenceMeteredUsage.status, 'settled')));
    if (parent === undefined) throw new Error(JSON.stringify(results));
    expect(parent).toMatchObject({ admittedModelReference: f.floor.modelReference, finalAuthorizedModelReference: f.high.modelReference, resolvedModelReference: f.high.modelReference, inputTokens: 1000, outputTokens: 2000, usageReceiptId: null });
    const children = await getDb().select().from(inferenceMeteredUsage).where(eq(inferenceMeteredUsage.parentRequestId, parent.requestId));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ status: 'settled', economicTreatment: 'internal_metered', inputTokens: 1000, outputTokens: 0, usageReceiptId: null, delegatedUserId: f.caller.accountId });
    expect(children[0].idempotencyKey).toMatch(/^oxy-edge:auto:/);
    expect(await moneyRowsFor(f.caller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
    const record = await readGenerationReceipt(f.context.principal, parent.requestId, f.context.delegatedUserId);
    expect(record).toMatchObject({ status: 'found', receipt: { schemaVersion: 2, kind: 'metered_usage', customerCharge: { status: 'not_charged' } } });
    expect(JSON.stringify(record)).not.toContain('receiptId');
    const rotated = await makeCredential(f.caller.applicationId, f.caller.accountId, 'production', ['inference:invoke', 'inference:usage:read']);
    expect(await readGenerationReceipt({ ...f.context.principal, credentialId: rotated.credentialId }, parent.requestId)).toEqual(record);
    expect(await readGenerationReceipt(f.context.principal, parent.requestId)).toEqual(record);
    expect(await readGenerationReceipt(f.context.principal, parent.requestId, `foreign-${tag()}`)).toEqual({ status: 'not-found' });
    const childRecord = await readGenerationReceipt(f.context.principal, children[0].requestId, f.context.delegatedUserId);
    expect(childRecord).toMatchObject({ status: 'found', receipt: { parentRequestId: parent.requestId, requestId: children[0].requestId } });

    expect(await readGenerationReceipt({ ...f.context.principal, applicationId: `foreign-${tag()}` }, parent.requestId)).toEqual({ status: 'not-found' });
    expect(await readGenerationReceipt({ ...f.context.principal, scopes: ['inference:invoke'] }, parent.requestId)).toEqual({ status: 'not-found' });
    await getDb().update(applications).set({ scopes: ['inference:invoke', 'inference:usage:read'] }).where(eq(applications.id, f.caller.applicationId));
    const rotatedCaller = { ...f.caller, credentialId: rotated.credentialId, machineToken: rotated.token };
    expect(await getGeneration(parent.requestId, bearer(serviceToken(rotatedCaller, ['inference:invoke', 'inference:usage:read'])))).toMatchObject({ status: 200, body: { data: record.status === 'found' ? record.receipt : {} } });
    const development = await makeCredential(f.caller.applicationId, f.caller.accountId, 'development', ['inference:invoke', 'inference:usage:read']);
    expect(await getGeneration(parent.requestId, bearer(development.token))).toMatchObject({ status: 200, body: { data: record.status === 'found' ? record.receipt : {} } });
    const newOwner = await makeAccount();
    await getDb().update(applications).set({ ownerAccountId: newOwner }).where(eq(applications.id, f.caller.applicationId));
    const transferred = await makeCredential(f.caller.applicationId, newOwner, 'development', ['inference:invoke', 'inference:usage:read']);
    expect(await getGeneration(parent.requestId, bearer(transferred.token))).toMatchObject({ status: 200, body: { data: record.status === 'found' ? record.receipt : {} } });
    // This shared Alia fixture belongs to later tests too; restore its owner.
    await getDb().update(applications).set({ ownerAccountId: f.caller.accountId }).where(eq(applications.id, f.caller.applicationId));
  });
  it('retains parent key and child units when final qualification refuses after child execution', async () => {
    const f = await internalAutoFixture();
    f.setAfterChild(async () => { f.routes.mockResolvedValue({ status: 'capacity-unavailable', modelReference: f.high.modelReference }); });
    expect(await executeInferenceRequest(f.context)).toMatchObject({ status: 'refused' });
    expect(f.forwarded).toHaveLength(1);
    const parent = await meteredFor(f.context.requestId);
    expect(parent).toMatchObject({ status: 'settled', outcome: 'failed', usageReceiptId: null });
    const [child] = await getDb().select().from(inferenceMeteredUsage).where(eq(inferenceMeteredUsage.parentRequestId, parent.requestId));
    expect(child).toMatchObject({ status: 'settled', inputTokens: 1000, outputTokens: 0, usageReceiptId: null });
    f.routes.mockImplementation(async (_viewer, reference) => ({ status: 'resolved', route: reference === f.high.modelReference ? f.high : f.floor, alternates: [] }));
    expect(await executeInferenceRequest({ ...f.context, requestId: `replay-${tag()}` })).toMatchObject({ status: 'refused', error: { code: 'idempotency_conflict' } });
    expect(f.forwarded).toHaveLength(1);
  });
  it('preserves missing independent review despite internal accounting readiness', async () => {
    const f = await internalAutoFixture();
    jest.mocked(decisionConfig.decisionAvailability).mockReturnValue({ available: false, reason: 'review missing' });
    const result = await executeInferenceRequest(f.context);
    if (result.status !== 'completed') throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ status: 'completed' });
    expect(f.forwarded).toHaveLength(1);
    expect(f.forwarded[0].input.format).toBe('text');
    expect(await moneyRowsFor(f.caller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
  });
});


async function scopedFixture(commercial = false) {
  const f = await internalAutoFixture();
  const caller = commercial ? await customer() : f.caller;
  const principal = commercial ? { ...f.context.principal, lane: 'machine_credential' as const,
    ownerAccountId: caller.accountId, applicationId: caller.applicationId, credentialId: caller.credentialId,
    environment: 'development' as const, applicationIsInternal: false } : f.context.principal;
  const policy = await resolveEffectiveRoutingPolicy(caller.applicationId);
  if (policy.status !== 'resolved') throw new Error('Scoped fixture lacks policy');
  const context: EdgeExecutionContext = { ...f.context, principal, delegatedUserId: undefined,
    request: { operation: { kind: 'decisions' }, target: { kind: 'model', modelReference: f.floor.modelReference },
      input: { format: 'decisions', decisions: { state: 'SYNTHETIC'.repeat(1200), questions: [{ id: 'auto-power-level', kind: 'choice',
        question: 'Synthetic?', options: ['instant', 'medium', 'high', 'xhigh'] }] } }, tools: [], sampling: {}, stream: false },
    endpoint: '/v1/decisions', apiFormat: 'decisions' };
  const permit = { permitId: `fixture-${tag()}`, idempotencyKey: context.idempotencyKey ?? '',
    fixtureSha256: scoped.hashScopedInput(context.request.input), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    principal: { accountId: principal.ownerAccountId, applicationId: principal.applicationId, credentialId: principal.credentialId, environment: principal.environment },
    policy: { routingPolicyId: policy.stored.policy.routingPolicyId, policyVersion: policy.stored.policy.policyVersion },
    deploymentId: f.floor.deploymentId, provider: f.floor.provider, keyId: 'synthetic-provider-key',
    modelReference: f.floor.modelReference, upstreamModelId: 'fixture', priceVersionId: f.floor.priceVersionId,
    providerRateCardVersionId: 'synthetic-card', providerSourceVersion: 'synthetic-source', maxCostUsd: '0.01' };
  const route: catalogue.EdgeRoute = { ...f.floor, scopedCatalogueEvidence: {
    modelRevisionId: 'synthetic-revision', deploymentId: permit.deploymentId, priceVersionId: permit.priceVersionId,
    commercialPermission: 'standard_application_use', permissionState: 'approved', legalReviewStatus: 'approved', legalReviewEvidenceRef: 'synthetic-only',
    eligibility: { availabilityScope: 'platform_internal', licenseId: 'apache-2.0', commercialUseAllowed: true,
      retainsPayloads: false, retentionDays: 0, trainsOnCustomerData: false, zeroDataRetentionAvailable: true,
      policyAdmitted: true, capabilityAdmitted: true, privacyAdmitted: true } } };
  f.routes.mockResolvedValue({ status: 'resolved', route, alternates: [] });
  jest.spyOn(scoped, 'scopedPermitForContext').mockImplementation(c => scoped.bindScopedPermit(permit, c));
  jest.mocked(decisionConfig.decisionAvailability).mockReturnValue({ available: false, reason: 'general review remains closed' });
  if (context.kaanaClient === undefined) throw new Error('Missing fixture client');
  const client = { ...context.kaanaClient, attestDeployments: async () => ({ snapshotId: 'synthetic-only',
    scopedExecutionContractVersion: '3.6.0' as const, deployments: [{ ...permit, regions: route.regions, scopedExecution: permit }] }) };
  return { ...f, caller, context: { ...context, kaanaClient: client } };
}

describe('I10 scoped execution with durable economic admission', () => {
  beforeEach(useMechanismRelationship);
  afterEach(() => jest.restoreAllMocks());
  it('executes an exact reviewed internal scoped claim without money even with charging off, then refuses replay', async () => {
    const f = await scopedFixture();
    jest.spyOn(rollout, 'isChargingAuthorized').mockReturnValue(false);
    expect(await executeInferenceRequest(f.context)).toMatchObject({ status: 'completed' });
    expect(f.forwarded).toHaveLength(1);
    expect(f.forwarded[0].schemaVersion).toBe(3);
    expect(await meteredFor(f.context.requestId)).toMatchObject({ status: 'settled', economicTreatment: 'internal_metered', inputTokens: 1000, outputTokens: 0, usageReceiptId: null });
    expect(await moneyRowsFor(f.caller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
    expect(await executeInferenceRequest({ ...f.context, requestId: `replay-${tag()}` })).toMatchObject({ status: 'refused', error: { code: 'idempotency_conflict' } });
    expect(f.forwarded).toHaveLength(1);
  });
  it('retains commercial promotional-only reserve/settlement and charging gates for an external caller', async () => {
    let f = await scopedFixture(true);
    const charging = jest.spyOn(rollout, 'isChargingAuthorized').mockReturnValue(false);
    expect(await executeInferenceRequest(f.context)).toMatchObject({ status: 'refused' });
    expect(f.forwarded).toHaveLength(0);
    charging.mockReturnValue(true);
    expect(await executeInferenceRequest(f.context)).toMatchObject({ status: 'refused', error: { code: 'insufficient_balance' } });
    f = await scopedFixture(true);
    await recordPromotionalGrant({ idempotencyKey: `scoped-grant-${tag()}`, accountId: f.caller.accountId,
      currency: 'USD', amount: '1.000000000000', actor: { kind: 'staff', userId: f.caller.accountId } });
    const result = await executeInferenceRequest({ ...f.context, requestId: `funded-${tag()}` });
    if (result.status !== 'completed') throw new Error(JSON.stringify(result));
    expect(result).toMatchObject({ status: 'completed' });
    expect(f.forwarded).toHaveLength(1);
    const money = await moneyRowsFor(f.caller.accountId);
    expect(money.receipts).toHaveLength(1);
    expect(money.receipts[0].billedAmount).toBe('0.000010000000');
    expect(money.reservations).toHaveLength(1);
    expect(money.reservations[0].status).toBe('settled');
  });
  it('refuses mismatched scoped identity before dispatch despite internal treatment', async () => {
    const f = await scopedFixture();
    expect(await executeInferenceRequest({ ...f.context, principal: { ...f.context.principal, credentialId: `foreign-${tag()}` } })).toMatchObject({ status: 'refused' });
    expect(f.forwarded).toHaveLength(0);
  });
});


describe('approved production pilot admission', () => {
  let approvedCaller: Caller;
  beforeAll(async () => {
    const caller = await alia();
    approvedCaller = { ...caller, modelReference: await makeRoute(caller.accountId, caller.applicationId, false, true) };
  });

  it.each([
    ['ASCII', 'a'.repeat(126_977)],
    ['Unicode UTF-8', '\u0800'.repeat(42_326)],
  ])('refuses oversized controlled input (%s) before execution or durable claim', async (_label, input) => {
    const caller = await alia();
    const before = await getDb().select().from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, caller.applicationId));
    const response = await post({ ...body(caller), input, maxOutputTokens: 2048 }, bearer(serviceToken(caller)));
    expect(response.status).toBe(400);
    expect(executions).toBe(0);
    expect(await getDb().select().from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, caller.applicationId))).toEqual(before);
    expect(await moneyRowsFor(caller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
  });

  it('serves a complete assistant context above the retired 8KiB pilot cap without replay or money holds', async () => {
    const input = 'Synthetic assistant context and conversation. '.repeat(1500);
    expect(Buffer.byteLength(input)).toBeGreaterThan(8192);
    const headers = { ...bearer(serviceToken(approvedCaller)), 'Idempotency-Key': `production-context-${tag()}` };
    const payload = { model: approvedCaller.modelReference, input, maxOutputTokens: 4096 };
    expect((await post(payload, headers)).status).toBe(200);
    expect(pilotEnvelopes).toHaveLength(1);
    expect(pilotEnvelopes[0].maxOutputTokens).toBe(2048);
    expect(JSON.stringify(pilotEnvelopes[0].input)).toContain(input);
    expect((await post(payload, headers)).status).toBe(409);
    expect(executions).toBe(1);
    expect(await moneyRowsFor(approvedCaller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
  });

  it('admits the exact complete UTF-8 budget and refuses one additional byte before metering', async () => {
    const payload = { model: approvedCaller.modelReference, input: 'x', maxOutputTokens: 2048 };
    const overhead = controlledInputBudget(normalizeResponsesRequest(responsesRequestSchema.parse(payload)));
    if (overhead === undefined) throw new Error('Missing completion budget');
    const input = 'x'.repeat(126_976 - overhead + 1);
    expect(controlledInputBudget(normalizeResponsesRequest(responsesRequestSchema.parse({ ...payload, input })))).toBe(126_976);
    expect((await post({ ...payload, input }, bearer(serviceToken(approvedCaller)))).status).toBe(200);
    const before = await getDb().select().from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, approvedCaller.applicationId));
    expect((await post({ ...payload, input: input + 'x' }, bearer(serviceToken(approvedCaller)))).status).toBe(400);
    expect(executions).toBe(1);
    expect(await getDb().select().from(inferenceMeteredUsage)
      .where(eq(inferenceMeteredUsage.applicationId, approvedCaller.applicationId))).toEqual(before);
  });

  it('keeps the selected model context bound below the product completion ceiling', async () => {
    const [model] = await getDb().select().from(inferenceModels)
      .where(and(eq(inferenceModels.publisherSlug, 'openai'), eq(inferenceModels.slug, 'gpt-oss-120b')));
    await getDb().update(inferenceModels).set({ maxContextTokens: 16_384 }).where(eq(inferenceModels.id, model.id));
    try {
      const response = await post({ model: approvedCaller.modelReference, input: 'x'.repeat(32_000), maxOutputTokens: 2048 },
        bearer(serviceToken(approvedCaller)));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(executions).toBe(0);
      expect(await moneyRowsFor(approvedCaller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
    } finally {
      await getDb().update(inferenceModels).set({ maxContextTokens: model.maxContextTokens }).where(eq(inferenceModels.id, model.id));
    }
  });

  it('refuses a catalogue deployment outside the exact approved pilot tuples', async () => {
    const caller = await alia();
    const response = await post({ ...body(caller), maxOutputTokens: 2048 }, bearer(serviceToken(caller)));
    expect(response.status).toBe(503);
    expect(executions).toBe(0);
    expect(await moneyRowsFor(caller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
  });
  it.each([[4096, 2048], [3000, 2048], [512, 512], [undefined, 2048]])(
    'caps caller output ceiling %s to effective signed %s', async (requested, expected) => {
      const response = await post({ model: approvedCaller.modelReference, input: 'Hello',
        ...(requested === undefined ? {} : { maxOutputTokens: requested }) }, bearer(serviceToken(approvedCaller)));
      expect(response.status).toBe(200);
      expect(pilotEnvelopes).toHaveLength(1);
      expect(pilotEnvelopes[0].maxOutputTokens).toBe(expected);
      expect(pilotEnvelopes[0].authorizedRoutes.every((route) =>
        route.deploymentId === 'dep_cerebras_gpt_oss_120b_observed_2026_09_01')).toBe(true);
      expect(await moneyRowsFor(approvedCaller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
    });

  it('preserves a commercial caller output ceiling of 4096', async () => {
    const caller = await customer('10.000000000000');
    const response = await post({ ...body(caller), maxOutputTokens: 4096 }, bearer(caller.machineToken));
    expect(response.status).toBe(200);
    expect(pilotEnvelopes[0].maxOutputTokens).toBe(4096);
    expect((await moneyRowsFor(caller.accountId)).receipts).toHaveLength(1);
  });

  it.each(['tool', 'response schema'])('refuses an oversized %s before the provider', async (kind) => {
    const schema = { type: 'object', description: 'x'.repeat(126_977) };
    const response = await post({ model: approvedCaller.modelReference, input: 'Hello',
      ...(kind === 'tool' ? { tools: [{ type: 'function', name: 'lookup', parameters: schema }] }
        : { responseFormat: { type: 'json_schema', name: 'result', schema, strict: true } }) },
      bearer(serviceToken(approvedCaller)));
    expect(response.status).toBe(400);
    expect(executions).toBe(0);
  });

  it('does not execute or claim a duplicate pilot request twice', async () => {
    const headers = { ...bearer(serviceToken(approvedCaller)), 'Idempotency-Key': `pilot-${tag()}` };
    const input = { model: approvedCaller.modelReference, input: 'Hello', maxOutputTokens: 4096 };
    const results = await Promise.all([post(input, headers), post(input, headers)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(executions).toBe(1);
    expect(pilotEnvelopes[0].maxOutputTokens).toBe(2048);
  });

  it('excludes an unapproved alternate from the actual signed authorization set', async () => {
    const original = catalogue.resolveEdgeRoute;
    jest.spyOn(catalogue, 'resolveEdgeRoute').mockImplementation(async (...args) => {
      const result = await original(...args);
      return result.status !== 'resolved' ? result : { ...result, alternates: [
        ...result.alternates, { ...result.route, deploymentId: 'synthetic-unapproved-alternate' },
      ] };
    });
    const response = await post({ model: approvedCaller.modelReference, input: 'Hello' }, bearer(serviceToken(approvedCaller)));
    expect(response.status).toBe(200);
    expect(pilotEnvelopes[0].authorizedRoutes.map((route) => route.deploymentId))
      .toEqual(['dep_cerebras_gpt_oss_120b_observed_2026_09_01']);
  });

  it.each(['modelReference', 'provider'] as const)('rejects an approved deployment ID with mismatched %s', async (field) => {
    const original = catalogue.resolveEdgeRoute;
    jest.spyOn(catalogue, 'resolveEdgeRoute').mockImplementation(async (...args) => {
      const result = await original(...args);
      return result.status !== 'resolved' ? result : { ...result, route: { ...result.route,
        [field]: field === 'provider' ? 'other' : 'openai/gpt-oss-120b@other' }, alternates: [] };
    });
    const response = await post({ model: approvedCaller.modelReference, input: 'Hello' }, bearer(serviceToken(approvedCaller)));
    expect(response.status).toBe(503);
    expect(executions).toBe(0);
  });

});


describe('original-key receipt recovery', () => {
  async function recoveryCaller() {
    const caller = await customer('1.000000000000');
    const scopes = ['inference:invoke', 'inference:usage:read'];
    await getDb().update(applications).set({ scopes }).where(eq(applications.id, caller.applicationId));
    await getDb().update(applicationCredentials).set({ scopes }).where(eq(applicationCredentials.id, caller.credentialId));
    return caller;
  }
  const readOriginal = (caller: Caller, key: string, extra: Record<string, string> = {}) =>
    getGeneration('by-idempotency-key', { ...bearer(caller.machineToken), 'Idempotency-Key': key, ...extra });

  it('recovers settled usage with GET only and leaves money and execution count unchanged', async () => {
    const caller = await recoveryCaller(); const key = `lost-${tag()}`;
    const first = await post(body(caller), { ...bearer(caller.machineToken), 'Idempotency-Key': key });
    expect(first.status).toBe(200);
    const before = await moneyRowsFor(caller.accountId);
    const recovered = await readOriginal(caller, key);
    expect(recovered).toMatchObject({ status: 200, body: { data: { requestId: first.body.requestId, schemaVersion: 1 } } });
    expect(await readOriginal(caller, key)).toEqual(recovered);
    expect(await moneyRowsFor(caller.accountId)).toEqual(before);
    expect(executions).toBe(1);
    expect(await readOriginal(caller, `unknown-${tag()}`)).toMatchObject({ status: 404 });
    expect(await readOriginal(caller, '')).toMatchObject({ status: 400 });
  });
  it('separates identical keys across apps, credentials and delegation', async () => {
    const caller = await recoveryCaller(); const foreign = await recoveryCaller(); const key = `collision-${tag()}`;
    const first = await post(body(caller), { ...bearer(caller.machineToken), 'Idempotency-Key': key });
    expect(first.status).toBe(200);
    expect(await readOriginal(foreign, key)).toMatchObject({ status: 404 });
    const second = await post(body(foreign), { ...bearer(foreign.machineToken), 'Idempotency-Key': key });
    expect(second.status).toBe(200);
    expect(second.body.requestId).not.toBe(first.body.requestId);
    expect(await readOriginal(foreign, key)).toMatchObject({ status: 200, body: { data: { requestId: second.body.requestId } } });
    const rotated = await makeCredential(caller.applicationId, caller.accountId, 'development', ['inference:invoke', 'inference:usage:read']);
    expect(await readOriginal({ ...caller, credentialId: rotated.credentialId, machineToken: rotated.token }, key)).toMatchObject({ status: 404 });
    expect(await readOriginal(caller, key, { 'X-Oxy-User-Id': `foreign-${tag()}` })).toMatchObject({ status: 404 });
    expect(executions).toBe(2);
  });
  it('keeps pending and unknown usage unresolved even when an unrelated receipt exists', async () => {
    const caller = await recoveryCaller(); const key = `pending-${tag()}`;
    const first = await post(body(caller), { ...bearer(caller.machineToken), 'Idempotency-Key': key });
    expect(first.status).toBe(200);
    const row = await meteredFor(first.body.requestId);
    await getDb().update(inferenceMeteredUsage).set({ status: 'admitted', outcome: null, usageSource: null, settledAt: null })
      .where(eq(inferenceMeteredUsage.id, row.id));
    const pending = await meteredFor(first.body.requestId);
    const money = await moneyRowsFor(caller.accountId);
    expect(await readOriginal(caller, key)).toMatchObject({ status: 404 });
    expect(await meteredFor(first.body.requestId)).toEqual(pending);
    expect(await moneyRowsFor(caller.accountId)).toEqual(money);
    expect(executions).toBe(1);
  });
  it('recovers internal technical usage without inventing a financial receipt and fences exact principal fields', async () => {
    useMechanismRelationship();
    const caller = await alia(); const scopes = ['inference:invoke', 'inference:usage:read'];
    await getDb().update(applications).set({ scopes }).where(eq(applications.id, caller.applicationId));
    await getDb().update(applicationCredentials).set({ scopes }).where(eq(applicationCredentials.id, caller.credentialId));
    const token = serviceToken(caller, scopes); const key = `internal-${tag()}`;
    const first = await post(body(caller), { ...bearer(token), 'Idempotency-Key': key });
    expect(first.status).toBe(200);
    const record = await getGeneration('by-idempotency-key', { ...bearer(token), 'Idempotency-Key': key });
    expect(record).toMatchObject({ status: 200, body: { data: { schemaVersion: 2, requestId: first.body.requestId,
      economicTreatment: 'internal_metered', customerCharge: { status: 'not_charged' } } } });
    expect(JSON.stringify(record)).not.toContain('receiptId');
    expect(await moneyRowsFor(caller.accountId)).toEqual({ reservations: [], receipts: [], balances: [] });
    const principal = { lane: 'service_token' as const, ownerAccountId: caller.accountId, applicationId: caller.applicationId,
      credentialId: caller.credentialId, environment: 'production' as const, scopes: ['inference:invoke', 'inference:usage:read'] as const,
      applicationIsInternal: true, applicationType: 'internal' as const };
    for (const changed of [{ environment: 'development' as const }, { ownerAccountId: 'foreign' },
      { applicationId: 'foreign' }, { credentialId: 'foreign' }, { scopes: ['inference:invoke'] as const }]) {
      expect(await readGenerationReceiptByIdempotencyKey({ ...principal, ...changed }, key)).toEqual({ status: 'not-found' });
    }
    expect(executions).toBe(1);
  });
  it.each(['revoked', 'expired'] as const)('denies %s credentials at the real authentication boundary', async state => {
    const caller = await recoveryCaller(); const key = `retired-${tag()}`;
    expect((await post(body(caller), { ...bearer(caller.machineToken), 'Idempotency-Key': key })).status).toBe(200);
    expect((await readOriginal(caller, key)).status).toBe(200);
    await getDb().update(applicationCredentials).set(state === 'revoked' ? { status: 'revoked' } : { expiresAt: new Date(Date.now() - 1000) })
      .where(eq(applicationCredentials.id, caller.credentialId));
    expect((await readOriginal(caller, key)).status).toBe(401);
    expect(executions).toBe(1);
  });
  it.each([
    ['commercial', 'commercial'], ['internal_metered', 'commercial'],
    ['internal_metered', 'internal_metered'], ['commercial', 'internal_metered'],
  ] as const)('keeps original %s identity when a newer %s generation alias collides', async (aKind, bKind) => {
    useMechanismRelationship();
    const base = await alia();
    const scopes = ['inference:invoke', 'inference:usage:read'];
    await getDb().update(applications).set({ scopes }).where(eq(applications.id, base.applicationId));
    await provisionBillingProfile({ accountId: base.accountId });
    await recordTopUp({ idempotencyKey: `alias-fund-${tag()}`, accountId: base.accountId,
      currency: 'USD', amount: '1.000000000000', actor: { kind: 'machine' } });
    async function identity(kind: typeof aKind) {
      const environment = kind === 'internal_metered' ? 'production' : 'development';
      const minted = await makeCredential(base.applicationId, base.accountId, environment, scopes);
      const caller = { ...base, credentialId: minted.credentialId, machineToken: minted.token };
      return { caller, environment, token: kind === 'internal_metered' ? serviceToken(caller, scopes) : minted.token };
    }
    const a = await identity(aKind); const b = await identity(bKind);
    const key = `alias-original-${tag()}`;
    const originalHeaders = { ...bearer(a.token), 'Idempotency-Key': key };
    const first = await post(body(a.caller), originalHeaders);
    expect(first.status).toBe(200);
    const original = await getGeneration('by-idempotency-key', originalHeaders);
    expect(original).toMatchObject({ status: 200, body: { data: {
      requestId: first.body.requestId, credentialId: a.caller.credentialId, environment: a.environment,
      schemaVersion: aKind === 'commercial' ? 1 : 2,
    } } });
    expect(original.body.data).not.toHaveProperty('delegatedUserId');
    // Opaque provider ids may collide with another request id. Both records
    // are settled through the canonical API/ledger, never hand-written receipts.
    nextGenerationId = String(first.body.requestId);
    const second = await post(body(b.caller), { ...bearer(b.token), 'Idempotency-Key': `alias-newer-${tag()}`,
      'X-Oxy-User-Id': base.accountId });
    expect(second.status).toBe(200);
    expect(second.body.requestId).not.toBe(first.body.requestId);
    const money = await moneyRowsFor(base.accountId);
    const aMeter = await meteredFor(first.body.requestId); const bMeter = await meteredFor(second.body.requestId);
    expect(bMeter).toMatchObject({ generationId: first.body.requestId, delegatedUserId: base.accountId });
    expect(await getGeneration('by-idempotency-key', originalHeaders)).toEqual(original);
    expect(await meteredFor(first.body.requestId)).toEqual(aMeter);
    expect(await meteredFor(second.body.requestId)).toEqual(bMeter);
    expect(await moneyRowsFor(base.accountId)).toEqual(money);
    expect(executions).toBe(2);
  });


});
