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
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';
import { reconcileMeteredReceipts } from '../../services/inferenceMeteredUsage.service';
import type { KaanaClient, KaanaCompletion } from '../../services/kaanaClient';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { createInferenceEdgeRouter } from '../inferenceEdge';
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
let behaviour: 'complete' | 'fail' = 'complete';

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
  behaviour = 'complete';
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

function completionFor(envelope: InferenceRequest): KaanaCompletion {
  const route = envelope.authorizedRoutes[0];
  const now = new Date().toISOString();
  return {
    generationId: `gen-${randomUUID()}`,
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
  environment: 'production' | 'development'
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
      scopes: ['inference:invoke'],
      status: 'active',
      createdByUserId: ownerAccountId,
    })
    .returning({ id: applicationCredentials.id });
  return { credentialId: credential.id, token: minted.token };
}

/** One priced ($3/M in, $15/M out), approved, servable route and a neutral policy. */
async function makeRoute(ownerAccountId: string, applicationId: string): Promise<string> {
  const db = getDb();
  const t = tag();
  const publisherSlug = `pub${t}`;
  const modelSlug = `model-${t}`;
  const providerSlug = `prov${t}`;
  const revision = '2026-01-01';
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
  const kaanaDeploymentId = `kaana-im-${t}`;
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
  await createNeutralRoutingPolicy({ accountId: ownerAccountId, applicationId });
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
function serviceToken(caller: Caller): string {
  return signServiceTokenEd25519({
    type: 'service',
    appId: caller.applicationId,
    appName: 'Alia',
    credentialId: caller.credentialId,
    ownerAccountId: caller.accountId,
    environment: 'production',
    scopes: ['inference:invoke'],
    iss: 'oxy-auth',
    aud: 'oxy-api',
    exp: Math.floor(Date.now() / 1_000) + 3_600,
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

describe('one installation, charging armed', () => {
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
      from generate_series(1, 256) g
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
