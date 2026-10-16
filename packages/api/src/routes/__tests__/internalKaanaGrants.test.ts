/**
 * `/internal/kaana/v1` — the grant and settlement API Kaana calls to serve
 * `kaana.ai/v1` (Kaana ADR 0002, phase 2) — over HTTP, against a REAL
 * Postgres: real applications, credentials, catalogue routes, prices,
 * routing policies, the ledger and the metered-usage table. Only Kaana is
 * simulated, by signing what Kaana would sign.
 *
 * What it holds, lane by lane, is the payer matrix: who the grant names as
 * payer, what it holds, under which treatment, and that a settlement charges
 * exactly once at the price the grant admitted.
 */

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  GRANT_SIGNATURE_DOMAIN,
  SETTLEMENT_SIGNATURE_DOMAIN,
  grantSchema,
  signatureInput,
  type Grant,
} from '@kaana.ai/contracts/internal';
import { USAGE_UNITS, type UsageUnit } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  KAANA_BASE_URL_VARIABLE,
  KAANA_SIGNING_KEY_ID_VARIABLE,
  KAANA_SIGNING_PRIVATE_KEY_VARIABLE,
} from '../../config/kaanaDataPlane';
import { KAANA_SETTLEMENT_PUBLIC_KEYS_VARIABLE } from '../../config/kaanaSettlementKeys';
import {
  ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
  CLARITY_INFERENCE_CONSUMER_APPLICATION_ID,
  INTERNAL_METERED_RELATIONSHIPS,
} from '../../config/inferenceEconomicPolicy';
import * as economicPolicy from '../../config/inferenceEconomicPolicy';
import {
  KAANA_CONTROL_APPLICATION_ID,
  KAANA_CONTROL_AUDIENCE,
  KAANA_PUBLIC_AUDIENCE,
  OXY_API_AUDIENCE,
} from '../../config/serviceTokenAudiences';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import {
  applicationCredentials,
  applicationInferenceLimits,
  applications,
  inferenceDeployments,
  inferenceMeteredUsage,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviderConnections,
  inferenceProviders,
  inferencePublishers,
  inferenceRoutingPolicies,
  inferenceUsageEvents,
  kaanaGrantAdmittedLines,
  kaanaGrantLineUnitPrices,
  kaanaGrants,
  priceVersions,
  priceVersionUnitPrices,
  spendingLimits,
  usageReceiptUnitPrices,
  usageReceipts,
  usageReservations,
  users,
} from '../../db/schema';
import { clearPowerClassesForTest, setPowerClass } from '../../db/testServableEvidence';
import {
  expireLapsedGrants,
  syncKaanaSettlementFeed,
  type SettlementFeedReader,
} from '../../services/kaanaSettlement.service';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { logger } from '../../utils/logger';
import {
  AUDIO_REVISION,
  EDGE_ROLLOUT_ENVIRONMENT,
  XAI_REALTIME_PRICES,
  makeAudioFixture,
  type AudioFixture,
  type FixturePrice,
} from '../__fixtures__/kaanaAudioFixtures';
import {
  CUSTOMER_KEY,
  KaanaStub,
  PUBLIC_RESALE,
  declaredModel,
} from '../__fixtures__/kaanaDeclaredStub';
import * as platformFee from '../../config/inferencePlatformFee';
import {
  createNeutralRoutingPolicy,
  insertValidRoutingScorecard,
} from '../__fixtures__/kaanaRuntimeFixtures';
import internalKaanaRoutes from '../internalKaana';

jest.setTimeout(60_000);

const oxyEdge = generateKeyPairSync('ed25519');
const kaanaSettlementKey = generateKeyPairSync('ed25519');
const EDGE_KEY_ID = 'oxy-edge-grant-test';
const SETTLEMENT_KEY_ID = 'kaana-settle-test';

function rawPublicKey(publicKey: typeof kaanaSettlementKey.publicKey): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

const ENVIRONMENT = {
  ...EDGE_ROLLOUT_ENVIRONMENT,
  [KAANA_BASE_URL_VARIABLE]: 'https://kaana.ai',
  [KAANA_SIGNING_KEY_ID_VARIABLE]: EDGE_KEY_ID,
  [KAANA_SIGNING_PRIVATE_KEY_VARIABLE]: oxyEdge.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString(),
  [KAANA_SETTLEMENT_PUBLIC_KEYS_VARIABLE]: `${SETTLEMENT_KEY_ID}:${rawPublicKey(kaanaSettlementKey.publicKey)}`,
} as Record<string, string>;
const ORIGINAL = Object.fromEntries(Object.keys(ENVIRONMENT).map((key) => [key, process.env[key]]));

const TEXT_PRICES: Readonly<Partial<Record<UsageUnit, FixturePrice>>> = {
  requests: '0',
  input_tokens: '3',
  cached_input_tokens: '1',
  output_tokens: '15',
  reasoning_tokens: '15',
};

let server: http.Server;
let kaanaToken: string;
/**
 * Kaana, as the grant API reads it: the catalogue it declares (identity,
 * audience, capabilities, list prices) and the deployments it publishes. It
 * starts as the one-time export of the fixture rows Oxy's old catalogue holds,
 * and a case overrides what it says to prove the grant follows Kaana.
 */
const kaanaStub = new KaanaStub();
let restoreKaana: () => void;

const tag = (): string => randomUUID().replace(/-/g, '').slice(0, 10);
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface HttpResult {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly raw: Buffer;
  readonly body: Record<string, unknown>;
}

function call(path: string, body: Buffer, headers: Record<string, string>): Promise<HttpResult> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            raw,
            body:
              raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as Record<string, unknown>),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function authorize(request: Record<string, unknown>, token = kaanaToken): Promise<HttpResult> {
  return call('/internal/kaana/v1/authorizations', Buffer.from(JSON.stringify(request)), {
    authorization: `Bearer ${token}`,
  });
}

interface InferenceAuthorizationOptions {
  readonly credential: string;
  readonly operation?: string;
  readonly target?: Record<string, unknown>;
  readonly facts?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly onBehalfOfUserId?: string;
  readonly canonicalInputSha256?: string;
}

function inferenceRequest(options: InferenceAuthorizationOptions): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'inference',
    credential: options.credential,
    requestId: `kreq_${tag()}`,
    operation: options.operation ?? 'responses',
    ...(options.target === undefined ? {} : { target: options.target }),
    facts: options.facts ?? {
      estimatedInputTokens: 1000,
      maxOutputTokens: 500,
      declaredTools: 0,
      stream: false,
    },
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options.onBehalfOfUserId === undefined
      ? {}
      : { onBehalfOfUserId: options.onBehalfOfUserId }),
    ...(options.canonicalInputSha256 === undefined
      ? {}
      : { canonicalInputSha256: options.canonicalInputSha256 }),
    bodySha256: sha256(`body-${tag()}`),
    client: { endpoint: '/v1/responses', receivedAt: new Date().toISOString() },
  };
}

/** Verify a grant the way Kaana does, and return it parsed by the contract. */
function verifiedGrant(result: HttpResult): Grant {
  expect(result.status).toBe(200);
  expect(result.headers['x-oxy-kaana-key-id']).toBe(EDGE_KEY_ID);
  const timestamp = Number(result.headers['x-oxy-kaana-timestamp']);
  const signature = String(result.headers['x-oxy-kaana-signature']);
  expect(signature.startsWith('v1=')).toBe(true);
  const input = signatureInput(GRANT_SIGNATURE_DOMAIN, EDGE_KEY_ID, timestamp, sha256(result.raw));
  expect(
    verify(
      null,
      Buffer.from(input, 'utf8'),
      oxyEdge.publicKey,
      Buffer.from(signature.slice(3), 'base64'),
    ),
  ).toBe(true);
  return grantSchema.parse(JSON.parse(result.raw.toString('utf8')));
}

interface SettlementOptions {
  readonly grant: Grant;
  readonly outcome?: 'completed' | 'partial' | 'cancelled' | 'failed';
  readonly units?: Partial<Record<UsageUnit, number>>;
  readonly modelReference?: string;
  readonly provider?: string;
  readonly deploymentId?: string;
  readonly servedStep?: number | null;
  readonly fundingTier?: 'free' | 'credit' | 'paid';
  readonly settlementId?: string;
  readonly generationId?: string;
}

function settlementOf(options: SettlementOptions): Record<string, unknown> {
  const { grant } = options;
  const started = new Date(Date.now() - 2_000).toISOString();
  return {
    schemaVersion: 1,
    settlementId: options.settlementId ?? `stl_${tag()}`,
    grantId: grant.grantId,
    requestId: grant.requestId,
    ...(grant.reservation === undefined ? {} : { reservationId: grant.reservation.reservationId }),
    ...(grant.capacity === undefined ? {} : { meteredUsageId: grant.capacity.meteredUsageId }),
    ...(options.servedStep === null ? {} : { servedStep: options.servedStep ?? 0 }),
    report: {
      schemaVersion: 2,
      requestId: grant.requestId,
      ...(options.generationId === undefined ? {} : { generationId: options.generationId }),
      attribution: {
        principal: {
          billing: { accountId: grant.principal.billingAccountId },
          applicationId: grant.principal.applicationId,
          credentialId: grant.principal.credentialId,
          environment: grant.principal.environment,
          inferenceScopes: grant.principal.scopes,
        },
        requestId: grant.requestId,
      },
      outcome: options.outcome ?? 'completed',
      units: Object.entries(options.units ?? { input_tokens: 800, output_tokens: 400 }).map(
        ([unit, quantity]) => ({
          unit,
          quantity,
        }),
      ),
      usageSource: 'provider_reported',
      resolvedModelReference: options.modelReference ?? 'unset/unset',
      servingProvider: options.provider ?? 'unset',
      deploymentId: options.deploymentId ?? 'unset',
      routeSwitches: 0,
      ...(options.fundingTier === undefined ? {} : { fundingTier: options.fundingTier }),
      startedAt: started,
      completedAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  };
}

function settle(
  settlement: Record<string, unknown>,
  keyId = SETTLEMENT_KEY_ID,
  privateKey = kaanaSettlementKey.privateKey,
) {
  const body = Buffer.from(JSON.stringify(settlement), 'utf8');
  const timestamp = Date.now();
  const input = signatureInput(SETTLEMENT_SIGNATURE_DOMAIN, keyId, timestamp, sha256(body));
  return call('/internal/kaana/v1/settlements', body, {
    authorization: `Bearer ${kaanaToken}`,
    'x-oxy-kaana-key-id': keyId,
    'x-oxy-kaana-timestamp': String(timestamp),
    'x-oxy-kaana-signature': `v1=${sign(null, Buffer.from(input, 'utf8'), privateKey).toString('base64')}`,
  });
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

async function makeAccount(): Promise<string> {
  const t = tag();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `kg-${t}`, email: `kg-${t}@example.test` })
    .returning({ id: users.id });
  return account.id;
}

async function makeCredential(
  applicationId: string,
  ownerAccountId: string,
  environment: 'production' | 'development',
  scopes: string[] = ['inference:invoke'],
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

function serviceToken(input: {
  readonly applicationId: string;
  readonly credentialId: string;
  readonly ownerAccountId: string;
  readonly audience: string;
  readonly environment?: 'production' | 'development';
  readonly scopes?: string[];
}): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  return signServiceTokenEd25519({
    type: 'service',
    appId: input.applicationId,
    appName: 'fixture',
    credentialId: input.credentialId,
    ownerAccountId: input.ownerAccountId,
    environment: input.environment ?? 'production',
    scopes: input.scopes ?? ['inference:invoke'],
    iss: 'oxy-auth',
    aud: input.audience,
    iat: issuedAt,
    exp: issuedAt + 300,
  });
}

/** An application at a pinned id (Kaana, Alia), internal, with a fresh credential. */
async function pinnedApplication(id: string, name: string, scopes: string[]) {
  const accountId = await makeAccount();
  await getDb()
    .insert(applications)
    .values({
      id,
      name: `${name} ${tag()}`,
      type: 'internal',
      isInternal: true,
      ownerAccountId: accountId,
      scopes,
    })
    .onConflictDoUpdate({
      target: applications.id,
      set: {
        type: 'internal',
        isInternal: true,
        ownerAccountId: accountId,
        scopes,
        status: 'active',
      },
    });
  const credential = await makeCredential(id, accountId, 'production', scopes);
  return { accountId, ...credential };
}

interface ExtraLine {
  readonly modelLine: string;
  readonly deploymentId: string;
  readonly provider: string;
  readonly priceVersionId: string;
}

/** One more approved, priced, public model line with one route. */
async function addModelLine(
  ownerAccountId: string,
  options: {
    readonly prices: Readonly<Partial<Record<UsageUnit, FixturePrice>>>;
    readonly inputModalities?: string[];
    readonly outputModalities?: string[];
    readonly apiFormats?: string[];
    readonly powerClass?: 'instant' | 'medium' | 'high' | 'pro' | 'ultra';
    readonly provider?: string;
  },
): Promise<ExtraLine> {
  const db = getDb();
  const t = tag();
  const publisherSlug = `kgpub${t}`;
  const modelSlug = `line-${t}`;
  const provider = options.provider ?? `kgprov${t}`;
  await db
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: `Publisher ${t}` });
  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: `Line ${t}`,
      inputModalities: options.inputModalities ?? ['text'],
      outputModalities: options.outputModalities ?? ['text'],
      ...(options.apiFormats === undefined ? {} : { apiFormats: options.apiFormats }),
      supportsTools: true,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsJsonMode: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      maxContextTokens: 32_000,
      maxOutputTokens: 4_096,
      licenseId: 'LicenseRef-Fixture',
      licenseDisplayName: 'Fixture',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'third_party_hosted',
    })
    .returning({ id: inferenceModels.id });
  const [revision] = await db
    .insert(inferenceModelRevisions)
    .values({
      modelId: model.id,
      revision: AUDIO_REVISION,
      releasedAt: new Date(),
      isCurrent: true,
      provenanceMarking: 'none',
      contentFilteringDefault: 'none',
    })
    .returning({ id: inferenceModelRevisions.id });
  await db
    .insert(inferenceProviders)
    .values({
      slug: provider,
      displayName: `Provider ${provider}`,
      kind: 'third_party',
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    })
    .onConflictDoNothing();
  const [price] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${publisherSlug}/${modelSlug}@${AUDIO_REVISION}`,
      provider,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });
  await db.insert(priceVersionUnitPrices).values(
    Object.entries(options.prices).map(([unit, value]) => ({
      priceVersionId: price.id,
      unit: unit as UsageUnit,
      amount:
        typeof value === 'string'
          ? value.includes('.')
            ? value
            : `${value}.000000000000`
          : value.amount,
      per: typeof value === 'string' ? (unit === 'requests' ? 1 : 1_000_000) : value.per,
    })),
  );
  const deploymentId = `kg-dep-${t}`;
  await db.insert(inferenceDeployments).values({
    modelRevisionId: revision.id,
    providerSlug: provider,
    internalRouteId: deploymentId,
    regions: ['us-west-2'],
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    availabilityScope: 'public_payg',
    commercialPermission: 'public_resale_approved',
    status: 'active',
    legalReviewStatus: 'approved',
    legalReviewedAt: new Date(),
    legalReviewEvidenceRef: `contract-register/${t}`,
    permissionState: 'approved',
    priceVersionId: price.id,
  });
  await insertValidRoutingScorecard({
    deploymentId,
    priceVersionId: price.id,
    changedByUserId: ownerAccountId,
  });
  const modelLine = `${publisherSlug}/${modelSlug}`;
  if (options.powerClass !== undefined) await setPowerClass(modelLine, options.powerClass);
  return { modelLine, deploymentId, provider, priceVersionId: price.id };
}

async function textCustomer(topUp = '100.000000000000'): Promise<AudioFixture> {
  return makeAudioFixture({
    inputModalities: ['text'],
    outputModalities: ['text'],
    prices: TEXT_PRICES,
    topUp,
  });
}

async function grantRow(grantId: string) {
  const [row] = await getDb().select().from(kaanaGrants).where(eq(kaanaGrants.id, grantId));
  return row;
}

async function meteredRow(requestId: string) {
  const [row] = await getDb()
    .select()
    .from(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.requestId, requestId));
  return row;
}

async function receiptsOf(accountId: string) {
  return getDb().select().from(usageReceipts).where(eq(usageReceipts.accountId, accountId));
}

async function reservationsForRequest(requestId: string) {
  return getDb().select().from(usageReservations).where(eq(usageReservations.requestId, requestId));
}

async function reservationOf(reservationId: string) {
  const [row] = await getDb()
    .select()
    .from(usageReservations)
    .where(eq(usageReservations.id, reservationId));
  return row;
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  Object.assign(process.env, ENVIRONMENT);
  await connectPostgres();
  kaanaStub.followFixtures();
  restoreKaana = kaanaStub.install();
  const kaana = await pinnedApplication(KAANA_CONTROL_APPLICATION_ID, 'Kaana', []);
  kaanaToken = serviceToken({
    applicationId: KAANA_CONTROL_APPLICATION_ID,
    credentialId: kaana.credentialId,
    ownerAccountId: kaana.accountId,
    audience: KAANA_CONTROL_AUDIENCE,
    scopes: [],
  });
  const app = express();
  app.use(
    '/internal/kaana/v1/settlements',
    express.raw({ type: 'application/json', limit: '256kb' }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use('/internal/kaana/v1', internalKaanaRoutes);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  restoreKaana();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

afterEach(() => {
  jest.restoreAllMocks();
  kaanaStub.clearOverrides();
  kaanaStub.routes.clear();
  kaanaStub.failing = false;
});

/* -------------------------------------------------------------------------- */
/*  Kaana, as a workload                                                       */
/* -------------------------------------------------------------------------- */

describe('who may call /internal/kaana/v1', () => {
  it('refuses a request with no token, an oxy-api token, and a control token of another application', async () => {
    const customer = await textCustomer();
    const request = inferenceRequest({ credential: customer.token });
    const body = Buffer.from(JSON.stringify(request));
    expect((await call('/internal/kaana/v1/authorizations', body, {})).status).toBe(401);

    const [kaanaCredential] = await getDb()
      .select({ id: applicationCredentials.id })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, KAANA_CONTROL_APPLICATION_ID))
      .limit(1);
    const [kaanaApp] = await getDb()
      .select({ owner: applications.ownerAccountId })
      .from(applications)
      .where(eq(applications.id, KAANA_CONTROL_APPLICATION_ID));
    const oxyApiToken = serviceToken({
      applicationId: KAANA_CONTROL_APPLICATION_ID,
      credentialId: kaanaCredential.id,
      ownerAccountId: kaanaApp.owner,
      audience: OXY_API_AUDIENCE,
    });
    expect((await authorize(request, oxyApiToken)).status).toBe(401);

    // A control-audience token naming Kaana's app id but another app's credential:
    // the ROW decides, and it is not Kaana's.
    const forged = serviceToken({
      applicationId: KAANA_CONTROL_APPLICATION_ID,
      credentialId: customer.credentialId,
      ownerAccountId: customer.accountId,
      audience: KAANA_CONTROL_AUDIENCE,
    });
    expect((await authorize(request, forged)).status).toBe(403);
  });

  it('answers a malformed authorization body as Kaana’s own error, not a client one', async () => {
    const result = await authorize({ schemaVersion: 1, kind: 'inference' });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'invalid_authorization_request' });
  });
});

/* -------------------------------------------------------------------------- */
/*  The customer's credential                                                  */
/* -------------------------------------------------------------------------- */

describe('the credential Kaana forwards', () => {
  it('refuses an unknown credential with a public authentication_failed naming Console', async () => {
    const request = inferenceRequest({ credential: 'oxy_sk_live_not_a_real_key' });
    const result = await authorize(request);
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({
      schemaVersion: 1,
      code: 'authentication_failed',
      retryable: false,
      requestId: request.requestId,
    });
    expect(String(result.body.message)).toContain('https://console.oxy.so');
  });

  it('refuses a service token minted for oxy-api; accepts one minted for kaana.ai', async () => {
    const customer = await textCustomer();
    const [application] = await getDb()
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.id, customer.applicationId));
    const credential = await makeCredential(application.id, customer.accountId, 'development');
    const forApi = serviceToken({
      applicationId: customer.applicationId,
      credentialId: credential.credentialId,
      ownerAccountId: customer.accountId,
      audience: OXY_API_AUDIENCE,
      environment: 'development',
    });
    const refused = await authorize(
      inferenceRequest({
        credential: forApi,
        target: { kind: 'model', modelLine: customer.modelReference },
      }),
    );
    expect(refused.status).toBe(401);

    const forKaana = serviceToken({
      applicationId: customer.applicationId,
      credentialId: credential.credentialId,
      ownerAccountId: customer.accountId,
      audience: KAANA_PUBLIC_AUDIENCE,
      environment: 'development',
    });
    const grant = verifiedGrant(
      await authorize(
        inferenceRequest({
          credential: forKaana,
          target: { kind: 'model', modelLine: customer.modelReference },
        }),
      ),
    );
    expect(grant.principal.lane).toBe('service_token');
    expect(grant.principal.billingAccountId).toBe(customer.accountId);
  });

  it('refuses a credential without inference:invoke', async () => {
    const customer = await textCustomer();
    const reader = await makeCredential(customer.applicationId, customer.accountId, 'development', [
      'inference:usage:read',
    ]);
    const result = await authorize(
      inferenceRequest({
        credential: reader.token,
        target: { kind: 'model', modelLine: customer.modelReference },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('insufficient_scope');
  });
});

/* -------------------------------------------------------------------------- */
/*  Commercial: the machine lane                                               */
/* -------------------------------------------------------------------------- */

describe('a commercial grant (oxy_sk_, machine_credential)', () => {
  it('names the application owner as payer, holds the dearest admitted quote and records the grant', async () => {
    const customer = await textCustomer();
    const request = inferenceRequest({
      credential: customer.token,
      target: { kind: 'model', modelLine: customer.modelReference },
      onBehalfOfUserId: 'end-user-17',
    });
    const grant = verifiedGrant(await authorize(request));

    expect(grant).toMatchObject({
      requestId: request.requestId,
      operation: 'responses',
      bodySha256: request.bodySha256,
      principal: {
        billingAccountId: customer.accountId,
        applicationId: customer.applicationId,
        credentialId: customer.credentialId,
        lane: 'machine_credential',
        scopes: ['inference:invoke', 'inference:usage:read'],
      },
      userId: 'end-user-17',
      economics: { treatment: 'commercial' },
    });
    expect(grant.capacity).toBeUndefined();
    expect(Date.parse(grant.executeBy) - Date.parse(grant.issuedAt)).toBe(60_000);
    // 1000 in × $3/M + 500 out × $15/M.
    expect(grant.reservation?.ceiling).toEqual({ amount: '0.010500000000', currency: 'USD' });
    expect(grant.steps).toHaveLength(1);
    expect(grant.steps[0]).toMatchObject({
      target: { kind: 'model', modelLine: customer.modelReference },
      limits: {
        providerAllowlist: [customer.providers[0]],
        admittedModelLines: [{ modelLine: customer.modelReference }],
      },
    });
    expect(grant.steps[0].limits.maxFundingTier).toBeUndefined();

    const row = await grantRow(grant.grantId);
    expect(row).toMatchObject({
      status: 'issued',
      lane: 'machine_credential',
      accountId: customer.accountId,
      economicTreatment: 'commercial',
      reservationId: grant.reservation?.reservationId,
      endpoint: '/v1/responses',
      delegatedUserId: 'end-user-17',
      signingKeyId: EDGE_KEY_ID,
    });
    expect(row.grantSha256).toMatch(/^[0-9a-f]{64}$/);
    const lines = await getDb()
      .select()
      .from(kaanaGrantAdmittedLines)
      .where(eq(kaanaGrantAdmittedLines.grantId, grant.grantId));
    expect(lines).toEqual([
      expect.objectContaining({
        stepIndex: 0,
        modelLine: customer.modelReference,
        priceVersionId: grant.steps[0].limits.admittedModelLines[0].priceVersionId,
      }),
    ]);
    const hold = await reservationOf(grant.reservation?.reservationId ?? '');
    expect(hold).toMatchObject({
      status: 'held',
      accountId: customer.accountId,
      delegatedUserId: 'end-user-17',
    });
    expect(await meteredRow(request.requestId as string)).toMatchObject({
      status: 'admitted',
      economicTreatment: 'commercial',
      endpoint: '/v1/responses',
    });
  });

  it('uses the application’s default target when Kaana names none', async () => {
    const customer = await textCustomer();
    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(eq(inferenceRoutingPolicies.applicationId, customer.applicationId));
    await createNeutralRoutingPolicy({
      accountId: customer.accountId,
      applicationId: customer.applicationId,
      overrides: { defaultTarget: { kind: 'model', modelReference: customer.modelReference } },
    });
    const grant = verifiedGrant(await authorize(inferenceRequest({ credential: customer.token })));
    expect(grant.steps[0].target).toEqual({ kind: 'model', modelLine: customer.modelReference });
  });

  it('refuses a reused Idempotency-Key without taking a second hold', async () => {
    const customer = await textCustomer();
    const target = { kind: 'model', modelLine: customer.modelReference };
    verifiedGrant(
      await authorize(
        inferenceRequest({ credential: customer.token, target, idempotencyKey: 'idem-1' }),
      ),
    );
    const again = await authorize(
      inferenceRequest({ credential: customer.token, target, idempotencyKey: 'idem-1' }),
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('idempotency_conflict');
    const holds = await getDb()
      .select()
      .from(usageReservations)
      .where(eq(usageReservations.accountId, customer.accountId));
    expect(holds).toHaveLength(1);
  });

  it('refuses an account that cannot cover the hold, and frees what it claimed', async () => {
    const customer = await textCustomer('0.000001000000');
    const request = inferenceRequest({
      credential: customer.token,
      target: { kind: 'model', modelLine: customer.modelReference },
    });
    const result = await authorize(request);
    expect(result.status).toBe(402);
    expect(result.body.code).toBe('insufficient_balance');
    expect((await meteredRow(request.requestId as string))?.status).toBe('refused');
    expect(
      await getDb()
        .select()
        .from(kaanaGrants)
        .where(eq(kaanaGrants.requestId, request.requestId as string)),
    ).toEqual([]);
  });

  it('refuses a request a hard spending limit stops', async () => {
    const customer = await textCustomer();
    await getDb().insert(spendingLimits).values({
      accountId: customer.accountId,
      scope: 'application',
      scopeApplicationId: customer.applicationId,
      period: 'monthly',
      enforcement: 'hard_stop',
      currency: 'USD',
      limitAmount: '0.001000000000',
    });
    const result = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
      }),
    );
    expect(result.status).toBe(402);
    expect(result.body.code).toBe('spending_limit_exceeded');
  });

  it('refuses when the policy’s maxPricePerRequest excludes every route', async () => {
    const customer = await textCustomer();
    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(eq(inferenceRoutingPolicies.applicationId, customer.applicationId));
    await createNeutralRoutingPolicy({
      accountId: customer.accountId,
      applicationId: customer.applicationId,
      overrides: { maxPricePerRequest: { amount: '0.000001', currency: 'USD' } },
    });
    const result = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('policy_violation');
  });

  it('answers model_not_found for a line the caller cannot see', async () => {
    const customer = await textCustomer();
    const result = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: 'nobody/nothing' },
      }),
    );
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('model_not_found');
  });

  it('refuses decisions and source-approved inputs until their approvals are re-issued', async () => {
    const customer = await textCustomer();
    for (const request of [
      inferenceRequest({ credential: customer.token, operation: 'decisions' }),
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
        canonicalInputSha256: sha256('approved'),
      }),
    ]) {
      const result = await authorize(request);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('service_unavailable');
    }
  });

  it('refuses a commercial realtime session: its facts bound no hold', async () => {
    const customer = await makeAudioFixture({
      realtime: { transports: ['websocket'], sessionKinds: ['conversation'] },
      prices: XAI_REALTIME_PRICES,
    });
    const result = await authorize(
      inferenceRequest({
        credential: customer.token,
        operation: 'realtime_session',
        target: { kind: 'model', modelLine: customer.modelReference },
        facts: { declaredTools: 0, stream: true, realtimeSessionKind: 'conversation' },
      }),
    );
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('unsupported_modality');
  });

  it('refuses charged inference on a deployment where charging is not authorized', async () => {
    const customer = await textCustomer();
    const previous = process.env.INFERENCE_CHARGING_AUTHORIZED;
    delete process.env.INFERENCE_CHARGING_AUTHORIZED;
    try {
      const result = await authorize(
        inferenceRequest({
          credential: customer.token,
          target: { kind: 'model', modelLine: customer.modelReference },
        }),
      );
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('service_unavailable');
    } finally {
      process.env.INFERENCE_CHARGING_AUTHORIZED = previous;
    }
  });

  it('requires the facts the hold is sized from', async () => {
    const customer = await textCustomer();
    const result = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
        facts: { declaredTools: 0, stream: false },
      }),
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: 'invalid_request',
      param: 'facts.estimatedInputTokens',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Settlement                                                                 */
/* -------------------------------------------------------------------------- */

describe('settlement', () => {
  async function grantFor(customer: AudioFixture) {
    return verifiedGrant(
      await authorize(
        inferenceRequest({
          credential: customer.token,
          target: { kind: 'model', modelLine: customer.modelReference },
        }),
      ),
    );
  }

  it('charges exactly once, at the price the grant admitted, and releases the rest of the hold', async () => {
    const customer = await textCustomer();
    const grant = await grantFor(customer);
    const settlement = settlementOf({
      grant,
      modelReference: customer.pinnedModelReference,
      provider: customer.providers[0],
      deploymentId: customer.deploymentIds[0],
      generationId: `gen_${tag()}`,
    });
    const first = await settle(settlement);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      schemaVersion: 1,
      settlementId: settlement.settlementId,
      status: 'settled',
    });

    const receipts = await receiptsOf(customer.accountId);
    expect(receipts).toHaveLength(1);
    // 800 in × $3/M + 400 out × $15/M.
    expect(receipts[0]).toMatchObject({
      billedAmount: '0.008400000000',
      priceVersionId: grant.steps[0].limits.admittedModelLines[0].priceVersionId,
      requestId: grant.requestId,
    });
    expect((await reservationOf(grant.reservation?.reservationId ?? ''))?.status).toBe('settled');
    expect(await meteredRow(grant.requestId)).toMatchObject({
      status: 'settled',
      outcome: 'completed',
    });
    expect(await grantRow(grant.grantId)).toMatchObject({
      status: 'settled',
      settlementId: settlement.settlementId,
      servedStep: 0,
      servedOutsideGrant: false,
    });
    const events = await getDb()
      .select()
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.requestId, grant.requestId));
    expect(events).toHaveLength(1);

    // Redelivered, and delivered again under a new outbox id: duplicates, no second charge.
    const again = await settle(settlement);
    expect(again.body).toMatchObject({ status: 'duplicate' });
    const other = await settle({ ...settlement, settlementId: `stl_${tag()}` });
    expect(other.body).toMatchObject({ status: 'duplicate' });
    expect(await receiptsOf(customer.accountId)).toHaveLength(1);
  });

  it('settles a request Kaana served outside the grant at the served deployment’s price, as a violation', async () => {
    const customer = await textCustomer();
    const outside = await addModelLine(customer.accountId, { prices: TEXT_PRICES });
    const grant = await grantFor(customer);
    const result = await settle(
      settlementOf({
        grant,
        modelReference: `${outside.modelLine}@${AUDIO_REVISION}`,
        provider: outside.provider,
        deploymentId: outside.deploymentId,
      }),
    );
    expect(result.body).toMatchObject({ status: 'settled' });
    expect((await receiptsOf(customer.accountId))[0]?.priceVersionId).toBe(outside.priceVersionId);
    expect((await grantRow(grant.grantId))?.servedOutsideGrant).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      'inference.settlement.policy_violation',
      expect.any(Error),
      expect.objectContaining({ grantId: grant.grantId }),
    );
  });

  it('settles a failure that served nothing at zero, releasing the whole hold', async () => {
    const customer = await textCustomer();
    const grant = await grantFor(customer);
    const result = await settle(
      settlementOf({ grant, outcome: 'failed', units: {}, servedStep: null }),
    );
    expect(result.body).toMatchObject({ status: 'settled' });
    expect((await receiptsOf(customer.accountId))[0]?.billedAmount).toBe('0.000000000000');
  });

  it('refuses an unsigned, mis-signed or foreign-key settlement', async () => {
    const customer = await textCustomer();
    const grant = await grantFor(customer);
    const settlement = settlementOf({ grant, modelReference: customer.pinnedModelReference });
    const body = Buffer.from(JSON.stringify(settlement));
    expect(
      (
        await call('/internal/kaana/v1/settlements', body, {
          authorization: `Bearer ${kaanaToken}`,
        })
      ).status,
    ).toBe(401);
    const stranger = generateKeyPairSync('ed25519');
    expect((await settle(settlement, SETTLEMENT_KEY_ID, stranger.privateKey)).status).toBe(401);
    expect((await settle(settlement, 'unknown-key')).status).toBe(401);
    expect((await grantRow(grant.grantId))?.status).toBe('issued');
  });

  it('rejects, permanently, a settlement naming no grant or the wrong hold', async () => {
    const customer = await textCustomer();
    const grant = await grantFor(customer);
    const unknown = await settle({ ...settlementOf({ grant }), grantId: 'not-a-grant' });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toEqual({ error: 'unknown-grant' });
    const wrongHold = await settle({ ...settlementOf({ grant }), reservationId: 'another-hold' });
    expect(wrongHold.status).toBe(422);
    expect(wrongHold.body).toEqual({ error: 'grant-mismatch' });
  });

  it('answers 503 when this deployment trusts no settlement key', async () => {
    const customer = await textCustomer();
    const grant = await grantFor(customer);
    const previous = process.env[KAANA_SETTLEMENT_PUBLIC_KEYS_VARIABLE];
    delete process.env[KAANA_SETTLEMENT_PUBLIC_KEYS_VARIABLE];
    try {
      expect((await settle(settlementOf({ grant }))).status).toBe(503);
    } finally {
      process.env[KAANA_SETTLEMENT_PUBLIC_KEYS_VARIABLE] = previous;
    }
  });

  it('closes a grant nothing settled, and a late settlement still settles it once', async () => {
    const customer = await textCustomer();
    const grant = await grantFor(customer);
    // One clock read: `execute_by` may be at most 60 s after `issued_at`
    // (kaana_grants_window_check), and two reads a millisecond apart broke it.
    const now = Date.now();
    await getDb()
      .update(kaanaGrants)
      .set({
        issuedAt: new Date(now - 30 * 60_000),
        executeBy: new Date(now - 29 * 60_000),
        expiresAt: new Date(now - 10 * 60_000),
      })
      .where(eq(kaanaGrants.id, grant.grantId));
    expect(await expireLapsedGrants()).toBeGreaterThanOrEqual(1);
    expect((await grantRow(grant.grantId))?.status).toBe('expired');
    const late = await settle(
      settlementOf({ grant, modelReference: customer.pinnedModelReference }),
    );
    expect(late.body).toMatchObject({ status: 'settled' });
    expect((await grantRow(grant.grantId))?.status).toBe('settled');
  });

  it('reconciles from Kaana’s outbox: a lost delivery settles once, a delivered one is a duplicate', async () => {
    const customer = await textCustomer();
    const lost = await grantFor(customer);
    const delivered = await grantFor(customer);
    const deliveredSettlement = settlementOf({
      grant: delivered,
      modelReference: customer.pinnedModelReference,
    });
    expect((await settle(deliveredSettlement)).body).toMatchObject({ status: 'settled' });

    const pages = [
      {
        data: [
          settlementOf({ grant: lost, modelReference: customer.pinnedModelReference }),
          deliveredSettlement,
        ],
        nextCursor: `cursor-${tag()}`,
      },
      { data: [] },
    ];
    const reader: SettlementFeedReader = {
      readPage: async () => {
        const { settlementPageSchema } = await import('@kaana.ai/contracts/internal');
        return settlementPageSchema.parse(pages.shift() ?? { data: [] });
      },
    };
    const result = await syncKaanaSettlementFeed(reader);
    expect(result).toMatchObject({ settled: 1, duplicates: 1, rejected: 0 });
    expect((await grantRow(lost.grantId))?.status).toBe('settled');
    expect(await receiptsOf(customer.accountId)).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  internal_metered: alia-kaana                                               */
/* -------------------------------------------------------------------------- */

describe('the alia-kaana relationship (service_token, internal_metered)', () => {
  let alia: { accountId: string; credentialId: string; token: string };
  let aliaToken: string;

  beforeAll(async () => {
    alia = await pinnedApplication(ALIA_INFERENCE_CONSUMER_APPLICATION_ID, 'Alia', [
      'inference:invoke',
    ]);
    // Served under the internal default policy: no other suite's policy shapes these grants.
    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(
        and(
          eq(inferenceRoutingPolicies.applicationId, ALIA_INFERENCE_CONSUMER_APPLICATION_ID),
          eq(inferenceRoutingPolicies.status, 'active'),
        ),
      );
    aliaToken = serviceToken({
      applicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
      credentialId: alia.credentialId,
      ownerAccountId: alia.accountId,
      audience: KAANA_PUBLIC_AUDIENCE,
    });
  });

  beforeEach(async () => {
    await getDb()
      .delete(applicationInferenceLimits)
      .where(eq(applicationInferenceLimits.applicationId, ALIA_INFERENCE_CONSUMER_APPLICATION_ID));
    // Each case counts only the sessions it opens: earlier cases' slots lapse.
    await getDb()
      .update(inferenceMeteredUsage)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(
        and(
          eq(inferenceMeteredUsage.applicationId, ALIA_INFERENCE_CONSUMER_APPLICATION_ID),
          eq(inferenceMeteredUsage.status, 'admitted'),
        ),
      );
  });

  async function realtimeLine(prices = XAI_REALTIME_PRICES) {
    const line = await addModelLine(alia.accountId, {
      prices,
      inputModalities: ['text', 'audio'],
      outputModalities: ['text', 'audio'],
    });
    await getDb()
      .update(inferenceModels)
      .set({ realtimeTransports: ['websocket'], realtimeSessionKinds: ['conversation'] })
      .where(eq(inferenceModels.modelId, line.modelLine));
    return line;
  }

  const realtimeRequest = (modelLine: string, kind = 'conversation') =>
    inferenceRequest({
      credential: aliaToken,
      operation: 'realtime_session',
      target: { kind: 'model', modelLine },
      facts: { declaredTools: 3, stream: true, realtimeSessionKind: kind },
    });

  it('grants a realtime session with no hold, its capacity slot named, priced per minute', async () => {
    const line = await realtimeLine();
    const request = realtimeRequest(line.modelLine);
    const grant = verifiedGrant(await authorize(request));
    expect(grant).toMatchObject({
      operation: 'realtime_session',
      principal: { lane: 'service_token', billingAccountId: alia.accountId },
      economics: { treatment: 'internal_metered', relationshipId: 'alia-kaana' },
    });
    expect(grant.reservation).toBeUndefined();
    expect(grant.capacity?.meteredUsageId).toEqual(expect.any(String));
    expect(grant.steps[0].limits.maxPricePerRequest).toEqual({ amount: '0.25', currency: 'USD' });
    expect(
      await getDb()
        .select()
        .from(usageReservations)
        .where(eq(usageReservations.requestId, request.requestId as string)),
    ).toEqual([]);
    expect(await meteredRow(request.requestId as string)).toMatchObject({
      endpoint: '/v1/realtime',
      economicTreatment: 'internal_metered',
      economicRelationshipId: 'alia-kaana',
      status: 'admitted',
    });
    expect(await grantRow(grant.grantId)).toMatchObject({
      ceilingAmount: null,
      reservationId: null,
    });
  });

  it('admits no realtime line dearer than USD 0.25 a minute, and no kind outside the terms', async () => {
    const dear = await realtimeLine({
      audio_input_milliseconds: { amount: '0.20', per: 60_000 },
      audio_output_milliseconds: { amount: '0.20', per: 60_000 },
      session_milliseconds: { amount: '0', per: 60_000 },
      requests: { amount: '0', per: 1 },
    });
    const priced = await authorize(realtimeRequest(dear.modelLine));
    expect(priced.status).toBe(403);
    expect(priced.body.code).toBe('policy_violation');

    const line = await realtimeLine();
    const translation = await authorize(realtimeRequest(line.modelLine, 'translation'));
    expect(translation.status).toBe(400);
    expect(translation.body.code).toBe('unsupported_modality');
  });

  it('bounds open sessions by the application’s Console limit, not by a constant, and frees a slot at settlement', async () => {
    const line = await realtimeLine();
    // Unset in Console: sessions are bounded by nothing here.
    const unbounded = [
      verifiedGrant(await authorize(realtimeRequest(line.modelLine))),
      verifiedGrant(await authorize(realtimeRequest(line.modelLine))),
    ];
    for (const grant of unbounded) {
      await settle(
        settlementOf({
          grant,
          units: { session_milliseconds: 1_000 },
          modelReference: `${line.modelLine}@${AUDIO_REVISION}`,
        }),
      );
    }

    await getDb().insert(applicationInferenceLimits).values({
      applicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
      maxConcurrentRealtimeSessions: 1,
      // The relationship's request concurrency does not count sessions.
      maxConcurrentRequests: 1,
    });
    const first = verifiedGrant(await authorize(realtimeRequest(line.modelLine)));
    const second = await authorize(realtimeRequest(line.modelLine));
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ code: 'rate_limited', retryable: true });

    await settle(
      settlementOf({
        grant: first,
        units: { session_milliseconds: 60_000 },
        modelReference: `${line.modelLine}@${AUDIO_REVISION}`,
      }),
    );
    verifiedGrant(await authorize(realtimeRequest(line.modelLine)));
  });

  it('applies a per-credential session limit apart from the application’s', async () => {
    const line = await realtimeLine();
    await getDb().insert(applicationInferenceLimits).values({
      applicationId: ALIA_INFERENCE_CONSUMER_APPLICATION_ID,
      maxConcurrentRealtimeSessions: 5,
      maxConcurrentRealtimeSessionsPerCredential: 1,
    });
    const open = verifiedGrant(await authorize(realtimeRequest(line.modelLine)));
    const refused = await authorize(realtimeRequest(line.modelLine));
    expect(refused.status).toBe(429);
    await settle(
      settlementOf({
        grant: open,
        units: { session_milliseconds: 1 },
        modelReference: `${line.modelLine}@${AUDIO_REVISION}`,
      }),
    );
  });

  it('counts input transcription billed apart in the per-minute ceiling, and settles the unit', async () => {
    // An OpenAI-shaped session: audio by the minute plus its ASR model's minute.
    const transcribed = await realtimeLine({
      audio_input_milliseconds: { amount: '0.06', per: 60_000 },
      audio_output_milliseconds: { amount: '0.12', per: 60_000 },
      session_milliseconds: { amount: '0', per: 60_000 },
      input_transcription_milliseconds: { amount: '0.006', per: 60_000 },
      requests: { amount: '0', per: 1 },
    });
    const grant = verifiedGrant(await authorize(realtimeRequest(transcribed.modelLine)));
    const settled = await settle(
      settlementOf({
        grant,
        units: {
          audio_input_milliseconds: 30_000,
          audio_output_milliseconds: 20_000,
          input_transcription_milliseconds: 30_000,
        },
        modelReference: `${transcribed.modelLine}@${AUDIO_REVISION}`,
        provider: transcribed.provider,
        deploymentId: transcribed.deploymentId,
      }),
    );
    expect(settled.body).toMatchObject({ status: 'settled' });
    // 0.03 + 0.04 + 0.003, recorded as a tariff, charged to nobody.
    expect(await meteredRow(grant.requestId)).toMatchObject({
      status: 'settled',
      inputTranscriptionMilliseconds: 30_000,
      tariffStatus: 'quoted',
      tariffAmount: '0.073000000000',
    });

    // The same line with a dearer ASR minute is over USD 0.25 a minute once it counts.
    const dearTranscription = await realtimeLine({
      audio_input_milliseconds: { amount: '0.06', per: 60_000 },
      audio_output_milliseconds: { amount: '0.12', per: 60_000 },
      session_milliseconds: { amount: '0', per: 60_000 },
      input_transcription_milliseconds: { amount: '0.10', per: 60_000 },
      requests: { amount: '0', per: 1 },
    });
    expect((await authorize(realtimeRequest(dearTranscription.modelLine))).body.code).toBe(
      'policy_violation',
    );
  });

  it('grants a transcription under the dictation terms: duration-bounded, no hold, no priced transcript', async () => {
    const free = await addModelLine(alia.accountId, {
      prices: { requests: '0', audio_input_milliseconds: { amount: '0.006', per: 60_000 } },
      inputModalities: ['audio'],
      outputModalities: ['text'],
      apiFormats: ['audio_transcriptions'],
    });
    const transcription = (modelLine: string, milliseconds: number) =>
      inferenceRequest({
        credential: aliaToken,
        operation: 'audio_transcriptions',
        target: { kind: 'model', modelLine },
        facts: { declaredTools: 0, stream: false, audioInputMilliseconds: milliseconds },
      });
    const grant = verifiedGrant(await authorize(transcription(free.modelLine, 60_000)));
    expect(grant).toMatchObject({
      operation: 'audio_transcriptions',
      economics: { treatment: 'internal_metered' },
    });
    expect(grant.steps[0].limits.maxPricePerRequest).toEqual({ amount: '0.05', currency: 'USD' });

    const tooLong = await authorize(transcription(free.modelLine, 300_001));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('context_length_exceeded');

    const pricedTranscript = await addModelLine(alia.accountId, {
      prices: {
        requests: '0',
        audio_input_milliseconds: { amount: '0.006', per: 60_000 },
        output_tokens: '10',
      },
      inputModalities: ['audio'],
      outputModalities: ['text'],
      apiFormats: ['audio_transcriptions'],
    });
    expect((await authorize(transcription(pricedTranscript.modelLine, 60_000))).body.code).toBe(
      'no_route_available',
    );
  });

  it('grants a transcription whose line prices the duration alone, as xAI grok-voice-transcribe does', async () => {
    // Kaana's xAI adapter settles only `audio_input_milliseconds`, and its
    // catalogue publishes no `requests` price. The hold must not demand one:
    // it did, and every dictation was refused `no_admissible_line`.
    const durationOnly = await addModelLine(alia.accountId, {
      prices: { audio_input_milliseconds: { amount: '0.10', per: 3_600_000 } },
      inputModalities: ['audio'],
      outputModalities: ['text'],
      apiFormats: ['audio_transcriptions'],
    });
    const grant = verifiedGrant(
      await authorize(
        inferenceRequest({
          credential: aliaToken,
          operation: 'audio_transcriptions',
          target: { kind: 'model', modelLine: durationOnly.modelLine },
          facts: { declaredTools: 0, stream: false, audioInputMilliseconds: 3_178 },
        }),
      ),
    );
    expect(grant).toMatchObject({
      operation: 'audio_transcriptions',
      economics: { treatment: 'internal_metered' },
    });
    expect(grant.steps[0].limits.admittedModelLines).toEqual([
      expect.objectContaining({ modelLine: durationOnly.modelLine }),
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  ADR 0037: a named promotional level is two steps                           */
/* -------------------------------------------------------------------------- */

describe('the clarity-kaana relationship (service_token, embeddings only)', () => {
  /** qwen/qwen3-embedding-8b's declared list: $0.01 per 1M input tokens, nothing per request or vector. */
  const EMBEDDING_PRICES: Readonly<Partial<Record<UsageUnit, FixturePrice>>> = {
    requests: '0',
    input_tokens: '0.01',
    embeddings: { amount: '0', per: 1 },
  };
  const relationship = INTERNAL_METERED_RELATIONSHIPS.find(
    (candidate) => candidate.relationshipId === 'clarity-kaana',
  );
  let clarity: { accountId: string; credentialId: string; token: string };
  let clarityToken: string;

  beforeAll(async () => {
    clarity = await pinnedApplication(
      CLARITY_INFERENCE_CONSUMER_APPLICATION_ID,
      'Clarity Backend',
      ['inference:invoke'],
    );
    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(
        and(
          eq(inferenceRoutingPolicies.applicationId, CLARITY_INFERENCE_CONSUMER_APPLICATION_ID),
          eq(inferenceRoutingPolicies.status, 'active'),
        ),
      );
    clarityToken = serviceToken({
      applicationId: CLARITY_INFERENCE_CONSUMER_APPLICATION_ID,
      credentialId: clarity.credentialId,
      ownerAccountId: clarity.accountId,
      audience: KAANA_PUBLIC_AUDIENCE,
    });
  });

  async function embeddingLine() {
    return addModelLine(clarity.accountId, {
      prices: EMBEDDING_PRICES,
      inputModalities: ['text'],
      outputModalities: ['embedding'],
      apiFormats: ['embeddings'],
    });
  }

  /** The production relationship, its pilot naming this fixture's route instead of production's. */
  function onRoute(line: ExtraLine) {
    if (relationship?.pilot?.embeddings === undefined)
      throw new Error('clarity-kaana terms missing');
    jest.spyOn(economicPolicy, 'resolveEconomicTreatment').mockReturnValue({
      treatment: 'internal_metered',
      policyVersion: economicPolicy.INFERENCE_ECONOMIC_POLICY_VERSION,
      relationship: {
        ...relationship,
        pilot: {
          embeddings: {
            ...relationship.pilot.embeddings,
            deployments: [
              {
                deploymentId: line.deploymentId,
                modelReference: `${line.modelLine}@${AUDIO_REVISION}`,
                provider: line.provider,
              },
            ],
          },
        },
      },
    });
  }

  const embeddingsRequest = (
    modelLine: string,
    estimatedInputTokens: number,
    embeddingInputs = 4,
  ) =>
    inferenceRequest({
      credential: clarityToken,
      operation: 'embeddings',
      target: { kind: 'model', modelLine },
      facts: { estimatedInputTokens, embeddingInputs, declaredTools: 0, stream: false },
    });

  /** Kaana's estimate of a batch: `utf16Length/4 + 1` per input (`internal/publicapi`). */
  const kaanaEstimate = (inputs: number, characters: number) =>
    inputs * (Math.floor(characters / 4) + 1);

  // The route below declares a 32,000-token context, as qwen/qwen3-embedding-8b
  // does in production. A context window bounds EACH input: every input is
  // embedded on its own, so a batch's total says nothing about whether it fits.
  it('admits Clarity’s full batch, 128 inputs of 2,000 characters, though their total exceeds the context', async () => {
    const line = await embeddingLine();
    onRoute(line);
    const total = kaanaEstimate(128, 2_000);
    expect(total).toBe(64_128);
    const grant = verifiedGrant(await authorize(embeddingsRequest(line.modelLine, total, 128)));
    expect(grant.operation).toBe('embeddings');
  });

  it('refuses a single input longer than the route’s context', async () => {
    jest.mocked(logger.warn).mockClear();
    const line = await embeddingLine();
    onRoute(line);
    const refused = await authorize(embeddingsRequest(line.modelLine, 32_001, 1));
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('context_length_exceeded');
    expect(refused.body.message).toBe(
      'No authorized route can fit this request and its output ceiling.',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'inference.grant.refused',
      expect.objectContaining({ code: 'context_length_exceeded', reason: 'route-context' }),
    );
  });

  it('refuses a batch whose total exceeds the pilot’s budget, though every input fits', async () => {
    jest.mocked(logger.warn).mockClear();
    const line = await embeddingLine();
    onRoute(line);
    const refused = await authorize(
      embeddingsRequest(line.modelLine, kaanaEstimate(132, 2_000), 132),
    );
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('context_length_exceeded');
    expect(refused.body.message).toBe('The input exceeds the internal pilot budget.');
    expect(logger.warn).toHaveBeenCalledWith(
      'inference.grant.refused',
      expect.objectContaining({ code: 'context_length_exceeded', reason: 'pilot-input' }),
    );
  });

  it('grants an embeddings request with no hold, on the pilot’s route, under its USD 0.001 ceiling', async () => {
    const line = await embeddingLine();
    onRoute(line);
    const request = embeddingsRequest(line.modelLine, 1_610);
    const grant = verifiedGrant(await authorize(request));
    expect(grant).toMatchObject({
      operation: 'embeddings',
      principal: { lane: 'service_token', billingAccountId: clarity.accountId },
      economics: { treatment: 'internal_metered', relationshipId: 'clarity-kaana' },
    });
    expect(grant.reservation).toBeUndefined();
    expect(grant.steps[0].limits.maxPricePerRequest).toEqual({ amount: '0.001', currency: 'USD' });
    expect(await meteredRow(request.requestId as string)).toMatchObject({
      economicTreatment: 'internal_metered',
      economicRelationshipId: 'clarity-kaana',
      status: 'admitted',
    });
  });

  it('refuses an embeddings request above the pilot’s 65,536 estimated tokens', async () => {
    const line = await embeddingLine();
    onRoute(line);
    const refused = await authorize(embeddingsRequest(line.modelLine, 65_537));
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('context_length_exceeded');
  });

  it('admits no route but the pilot’s own', async () => {
    const line = await embeddingLine();
    const other = await embeddingLine();
    onRoute(other);
    const refused = await authorize(embeddingsRequest(line.modelLine, 1_610));
    expect(refused.status).not.toBe(200);
  });

  it('refuses every operation but embeddings, under the production terms as written', async () => {
    const text = await addModelLine(clarity.accountId, { prices: TEXT_PRICES });
    const completion = await authorize(
      inferenceRequest({
        credential: clarityToken,
        target: { kind: 'model', modelLine: text.modelLine },
      }),
    );
    expect(completion.status).toBe(400);
    expect(completion.body.code).toBe('unsupported_modality');
    expect(completion.body.message).toBe('The operation is outside the controlled internal pilot.');
  });
});

describe('an internal pilot naming a promotional level (ADR 0037)', () => {
  it('signs the level on credit only, then the pilot’s xhigh routes', async () => {
    await clearPowerClassesForTest();
    const customer = await textCustomer();
    const pro = await addModelLine(customer.accountId, { prices: TEXT_PRICES, powerClass: 'pro' });
    const high = await addModelLine(customer.accountId, {
      prices: TEXT_PRICES,
      powerClass: 'high',
    });
    const pilotRelationship = {
      relationshipId: 'grant-test-pilot',
      consumerApplicationId: customer.applicationId,
      consumerProduct: 'test',
      providerProduct: 'kaana',
      environments: ['development'],
      lane: 'service_token',
      capacity: { maxConcurrentRequests: 32, maxRequestsPerUtcDay: 5000 },
      pilot: {
        maxControlledInputBudget: 8192,
        maxOutputTokens: 2048,
        maxPricePerRequestUsd: '0.05',
        deployments: [
          {
            deploymentId: high.deploymentId,
            modelReference: `${high.modelLine}@${AUDIO_REVISION}`,
            provider: high.provider,
          },
        ],
        promotionalCredit: {
          levels: ['pro', 'ultra'],
          fallbackLevel: 'xhigh',
          maxPricePerRequestUsd: '1.00',
        },
      },
    } as const;
    jest.spyOn(economicPolicy, 'resolveEconomicTreatment').mockReturnValue({
      treatment: 'internal_metered',
      policyVersion: 'grant-test',
      relationship: pilotRelationship as unknown as economicPolicy.InternalMeteredRelationship,
    });

    const grant = verifiedGrant(
      await authorize(
        inferenceRequest({ credential: customer.token, target: { kind: 'level', level: 'pro' } }),
      ),
    );
    expect(grant.economics).toMatchObject({
      treatment: 'internal_metered',
      relationshipId: 'grant-test-pilot',
    });
    expect(grant.steps).toHaveLength(2);
    expect(grant.steps[0]).toMatchObject({
      target: { kind: 'level', level: 'pro' },
      limits: {
        maxFundingTier: 'credit',
        maxPricePerRequest: { amount: '1.00', currency: 'USD' },
        admittedModelLines: [{ modelLine: pro.modelLine }],
      },
    });
    expect(grant.steps[1]).toMatchObject({
      target: { kind: 'level', level: 'xhigh' },
      limits: {
        maxPricePerRequest: { amount: '0.05', currency: 'USD' },
        admittedModelLines: [{ modelLine: high.modelLine }],
        providerAllowlist: [high.provider],
      },
    });
    expect(grant.steps[1].limits.maxFundingTier).toBeUndefined();

    // The pilot needs the caller's own output limit inside the bound body.
    const unbounded = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'level', level: 'pro' },
        facts: { estimatedInputTokens: 100, declaredTools: 0, stream: false },
      }),
    );
    expect(unbounded.status).toBe(400);
    expect(unbounded.body.code).toBe('output_limit_exceeded');
  });

  it('logs a settlement that spent above the step’s funding ceiling, and still settles it', async () => {
    await clearPowerClassesForTest();
    const customer = await textCustomer();
    const pro = await addModelLine(customer.accountId, { prices: TEXT_PRICES, powerClass: 'pro' });
    jest.spyOn(economicPolicy, 'resolveEconomicTreatment').mockReturnValue({
      treatment: 'internal_metered',
      policyVersion: 'grant-test',
      relationship: {
        relationshipId: 'grant-test-pilot',
        consumerApplicationId: customer.applicationId,
        consumerProduct: 'test',
        providerProduct: 'kaana',
        environments: ['development'],
        lane: 'service_token',
        capacity: { maxConcurrentRequests: 32, maxRequestsPerUtcDay: 5000 },
        pilot: {
          maxControlledInputBudget: 8192,
          maxOutputTokens: 2048,
          maxPricePerRequestUsd: '0.05',
          deployments: [],
          promotionalCredit: {
            levels: ['pro'],
            fallbackLevel: 'xhigh',
            maxPricePerRequestUsd: '1.00',
          },
        },
      },
    });
    const grant = verifiedGrant(
      await authorize(
        inferenceRequest({ credential: customer.token, target: { kind: 'level', level: 'pro' } }),
      ),
    );
    const result = await settle(
      settlementOf({
        grant,
        modelReference: `${pro.modelLine}@${AUDIO_REVISION}`,
        provider: pro.provider,
        deploymentId: pro.deploymentId,
        fundingTier: 'paid',
      }),
    );
    expect(result.body).toMatchObject({ status: 'settled' });
    expect(logger.error).toHaveBeenCalledWith(
      'inference.settlement.funding_ceiling_breached',
      expect.any(Error),
      expect.objectContaining({ ceiling: 'credit', served: 'paid' }),
    );
    expect(await grantRow(grant.grantId)).toMatchObject({
      servedFundingTier: 'paid',
      servedOutsideGrant: false,
    });
    // Internal: usage recorded with its tariff, nobody charged.
    expect(await receiptsOf(customer.accountId)).toEqual([]);
    expect(await meteredRow(grant.requestId)).toMatchObject({
      status: 'settled',
      tariffStatus: 'quoted',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Kaana owns the catalogue: price, audience, capabilities (ADR 0002, 2026-10-15) */
/* -------------------------------------------------------------------------- */

describe('a grant is rated from KAANA’s declared catalogue, not from Oxy’s tables', () => {
  /** A list Kaana declares: `input` $/M tokens (the fixtures' text price is 3), the rest as the fixtures. */
  const list = (priceVersionId: string, input: string) => ({
    priceVersionId,
    unitPrices: [
      { unit: 'requests' as const, amount: '0.000000000000', per: 1 },
      { unit: 'input_tokens' as const, amount: input, per: 1_000_000 },
      { unit: 'cached_input_tokens' as const, amount: '1.000000000000', per: 1_000_000 },
      { unit: 'output_tokens' as const, amount: '15.000000000000', per: 1_000_000 },
      { unit: 'reasoning_tokens' as const, amount: '15.000000000000', per: 1_000_000 },
    ],
  });

  async function grantFor(customer: AudioFixture) {
    return verifiedGrant(
      await authorize(
        inferenceRequest({
          credential: customer.token,
          target: { kind: 'model', modelLine: customer.modelReference },
        }),
      ),
    );
  }

  const declared = (customer: AudioFixture, pricing?: ReturnType<typeof list>) =>
    declaredModel({
      modelId: customer.modelReference,
      ...(pricing === undefined ? {} : { pricing }),
    });

  it('holds and charges at the price Kaana declares, though Oxy’s tables say otherwise, and copies the list', async () => {
    const customer = await textCustomer();
    // Oxy's own price table (what the old edge would use) says $3/M input;
    // Kaana declares $6/M under its own version id.
    kaanaStub.override(
      customer.modelReference,
      declared(customer, list('kaana-pv-6', '6.000000000000')),
    );
    const grant = await grantFor(customer);

    // 1000 in × $6/M + 500 out × $15/M — not the 0.0105 of the Oxy table.
    expect(grant.reservation?.ceiling).toEqual({ amount: '0.013500000000', currency: 'USD' });
    expect(grant.steps[0].limits.admittedModelLines).toEqual([
      { modelLine: customer.modelReference, priceVersionId: 'kaana-pv-6' },
    ]);
    const [line] = await getDb()
      .select()
      .from(kaanaGrantAdmittedLines)
      .where(eq(kaanaGrantAdmittedLines.grantId, grant.grantId));
    expect(line).toMatchObject({ priceVersionId: 'kaana-pv-6', currency: 'USD' });
    const copied = await getDb()
      .select()
      .from(kaanaGrantLineUnitPrices)
      .where(eq(kaanaGrantLineUnitPrices.grantId, grant.grantId));
    expect(copied.map((entry) => entry.unit).sort()).toEqual([
      'cached_input_tokens',
      'input_tokens',
      'output_tokens',
      'reasoning_tokens',
      'requests',
    ]);

    const settlement = settlementOf({
      grant,
      modelReference: customer.pinnedModelReference,
      provider: customer.providers[0],
      deploymentId: customer.deploymentIds[0],
    });
    expect((await settle(settlement)).body).toMatchObject({ status: 'settled' });
    // 800 in × $6/M + 400 out × $15/M.
    const [receipt] = await receiptsOf(customer.accountId);
    expect(receipt).toMatchObject({ billedAmount: '0.010800000000', priceVersionId: 'kaana-pv-6' });
    // The receipt carries its own copy of the entries it was charged at.
    const snapshot = await getDb()
      .select()
      .from(usageReceiptUnitPrices)
      .where(eq(usageReceiptUnitPrices.receiptId, receipt.id));
    expect(snapshot.find((entry) => entry.unit === 'input_tokens')?.amount).toBe('6.000000000000');
  });

  it('settles at the version the grant admitted even after Kaana publishes a new one', async () => {
    const customer = await textCustomer();
    kaanaStub.override(
      customer.modelReference,
      declared(customer, list('kaana-pv-a', '6.000000000000')),
    );
    const first = await grantFor(customer);
    // Kaana moves on: a new price is a new priceVersionId.
    kaanaStub.override(
      customer.modelReference,
      declared(customer, list('kaana-pv-b', '9.000000000000')),
    );
    const second = await grantFor(customer);
    expect(second.steps[0].limits.admittedModelLines[0].priceVersionId).toBe('kaana-pv-b');

    for (const grant of [first, second]) {
      await settle(settlementOf({ grant, modelReference: customer.pinnedModelReference }));
    }
    const charged = Object.fromEntries(
      (await receiptsOf(customer.accountId)).map((receipt) => [
        receipt.priceVersionId,
        receipt.billedAmount,
      ]),
    );
    // 800 × $6/M + 400 × $15/M, and 800 × $9/M + 400 × $15/M: each at ITS version.
    expect(charged).toEqual({ 'kaana-pv-a': '0.010800000000', 'kaana-pv-b': '0.013200000000' });
  });

  it('refuses a model Kaana declares no price for, typed, taking no hold and charging nothing', async () => {
    const customer = await textCustomer();
    kaanaStub.override(customer.modelReference, declared(customer));
    const request = inferenceRequest({
      credential: customer.token,
      target: { kind: 'model', modelLine: customer.modelReference },
    });
    const result = await authorize(request);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('no_route_available');
    expect(String(result.body.message)).toContain('cannot be priced per unit');
    expect(await reservationsForRequest(request.requestId as string)).toEqual([]);
    expect(await meteredRow(request.requestId as string)).toBeUndefined();
  });

  it('refuses a model whose published price version was republished with different prices', async () => {
    const customer = await textCustomer();
    kaanaStub.override(
      customer.modelReference,
      declared(customer, list('kaana-pv-once', '6.000000000000')),
    );
    await grantFor(customer);
    // The same id, other prices: a published version never changes.
    kaanaStub.override(
      customer.modelReference,
      declared(customer, list('kaana-pv-once', '7.000000000000')),
    );
    const result = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
      }),
    );
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('no_route_available');
    // A new id is a new price, and it is rated again.
    kaanaStub.override(
      customer.modelReference,
      declared(customer, list('kaana-pv-twice', '7.000000000000')),
    );
    expect((await grantFor(customer)).steps[0].limits.admittedModelLines[0].priceVersionId).toBe(
      'kaana-pv-twice',
    );
  });

  it('rejects, permanently, a settlement in a unit the grant’s list does not price', async () => {
    const customer = await textCustomer();
    const grant = await grantFor(customer);
    const result = await settle(
      settlementOf({
        grant,
        modelReference: customer.pinnedModelReference,
        units: { input_tokens: 800, audio_input_tokens: 50 },
      }),
    );
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: 'unpriced_unit' });
    // Never settled at zero, never partly charged: the grant stands open.
    expect(await receiptsOf(customer.accountId)).toEqual([]);
    expect((await grantRow(grant.grantId))?.status).toBe('issued');
    expect(logger.error).toHaveBeenCalledWith(
      'inference.settlement.unpriced_unit',
      expect.any(Error),
      expect.objectContaining({ grantId: grant.grantId, units: ['audio_input_tokens'] }),
    );
  });

  it('rejects, permanently, a served line outside the grant that Kaana declares no price for', async () => {
    const customer = await textCustomer();
    const outside = await addModelLine(customer.accountId, { prices: TEXT_PRICES });
    const grant = await grantFor(customer);
    kaanaStub.override(outside.modelLine, 'drop');
    const result = await settle(
      settlementOf({
        grant,
        modelReference: `${outside.modelLine}@${AUDIO_REVISION}`,
        provider: outside.provider,
        deploymentId: outside.deploymentId,
      }),
    );
    expect(result.status).toBe(422);
    expect(result.body).toEqual({ error: 'model_not_priced' });
    expect(await receiptsOf(customer.accountId)).toEqual([]);
  });

  it('defers, without rejecting, a settlement outside the grant while Kaana’s catalogue cannot be read', async () => {
    const customer = await textCustomer();
    const outside = await addModelLine(customer.accountId, { prices: TEXT_PRICES });
    const grant = await grantFor(customer);
    const settlement = settlementOf({
      grant,
      modelReference: `${outside.modelLine}@${AUDIO_REVISION}`,
      provider: outside.provider,
      deploymentId: outside.deploymentId,
    });
    // A fresh cache that has never read Kaana, and Kaana unreachable.
    const unreachable = new KaanaStub();
    unreachable.failing = true;
    const restore = unreachable.install();
    try {
      const deferred = await settle(settlement);
      expect(deferred.status).toBe(503);
      expect(deferred.body).toEqual({ error: 'catalogue_unavailable' });
      expect((await grantRow(grant.grantId))?.status).toBe('issued');
    } finally {
      restore();
    }
    expect((await settle(settlement)).body).toMatchObject({ status: 'settled' });
  });

  it('refuses every grant while Kaana’s catalogue cannot be read, claiming and holding nothing', async () => {
    const customer = await textCustomer();
    const unreachable = new KaanaStub();
    unreachable.failing = true;
    const restore = unreachable.install();
    try {
      const request = inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
      });
      const result = await authorize(request);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('service_unavailable');
      expect(await reservationsForRequest(request.requestId as string)).toEqual([]);
      expect(await meteredRow(request.requestId as string)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('offers a platform_internal model to official products only, and never a retired one', async () => {
    const customer = await textCustomer();
    kaanaStub.override(
      customer.modelReference,
      declaredModel({
        modelId: customer.modelReference,
        audience: 'platform_internal',
        pricing: list('kaana-pv-internal', '3.000000000000'),
      }),
    );
    const third = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
      }),
    );
    expect(third.status).toBe(404);
    expect(third.body.code).toBe('model_not_found');

    kaanaStub.override(
      customer.modelReference,
      declaredModel({
        modelId: customer.modelReference,
        deprecation: 'retired',
        pricing: list('kaana-pv-retired', '3.000000000000'),
      }),
    );
    expect(
      (
        await authorize(
          inferenceRequest({
            credential: customer.token,
            target: { kind: 'model', modelLine: customer.modelReference },
          }),
        )
      ).body.code,
    ).toBe('model_not_found');
  });

  it('takes a model’s capabilities from what Kaana declares, not from Oxy’s rows', async () => {
    const customer = await textCustomer();
    // Oxy's row says text in/out and 32k context; Kaana declares an audio-only model.
    kaanaStub.override(
      customer.modelReference,
      declaredModel({
        modelId: customer.modelReference,
        inputModalities: ['audio'],
        pricing: list('kaana-pv-audio', '3.000000000000'),
      }),
    );
    const modality = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
      }),
    );
    expect(modality.status).toBe(400);
    expect(modality.body.code).toBe('unsupported_modality');

    kaanaStub.override(
      customer.modelReference,
      declaredModel({
        modelId: customer.modelReference,
        maxContextTokens: 1_200,
        maxOutputTokens: 400,
        pricing: list('kaana-pv-small', '3.000000000000'),
      }),
    );
    const capacity = await authorize(
      inferenceRequest({
        credential: customer.token,
        target: { kind: 'model', modelLine: customer.modelReference },
      }),
    );
    expect(capacity.status).toBe(400);
    expect(capacity.body.code).toBe('output_limit_exceeded');
  });

  it('serves no route Kaana does not publish, and none Oxy has not approved', async () => {
    const customer = await textCustomer();
    kaanaStub.publish({
      deploymentId: 'only-kaana-knows',
      modelReference: `${customer.modelReference}@${AUDIO_REVISION}`,
      provider: 'ghost-provider',
      regions: [],
    });
    const grant = await grantFor(customer);
    // The unapproved deployment never reaches the allowlist.
    expect(grant.steps[0].limits.providerAllowlist).toEqual([customer.providers[0]]);
    kaanaStub.routes.delete('only-kaana-knows');

    // Nothing published: nothing to grant.
    const empty = new KaanaStub();
    empty.declare(declared(customer, list('kaana-pv-x', '3.000000000000')));
    const restore = empty.install();
    try {
      const none = await authorize(
        inferenceRequest({
          credential: customer.token,
          target: { kind: 'model', modelLine: customer.modelReference },
        }),
      );
      expect(none.status).toBe(503);
      expect(none.body.code).toBe('no_route_available');
    } finally {
      restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Kaana chooses the provider; Kaana publishes how a route may be sold          */
/* -------------------------------------------------------------------------- */

describe('the grant admits every eligible route and Kaana chooses among them', () => {
  async function twoProviders() {
    const customer = await makeAudioFixture({
      inputModalities: ['text'],
      outputModalities: ['text'],
      prices: TEXT_PRICES,
      routes: 2,
    });
    return customer;
  }
  const request = (customer: AudioFixture) =>
    inferenceRequest({
      credential: customer.token,
      target: { kind: 'model', modelLine: customer.modelReference },
    });
  const withFallback = async (
    customer: AudioFixture,
    fallback: { disabled: boolean; sameModelDeployment: boolean; authorizedCrossModel: string[] },
  ) => {
    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(eq(inferenceRoutingPolicies.applicationId, customer.applicationId));
    await createNeutralRoutingPolicy({
      accountId: customer.accountId,
      applicationId: customer.applicationId,
      overrides: { fallback },
    });
  };

  it('allows every provider that serves the line, not the first of them', async () => {
    const customer = await twoProviders();
    const grant = verifiedGrant(await authorize(request(customer)));
    expect([...grant.steps[0].limits.providerAllowlist].sort()).toEqual(
      [...customer.providers].sort(),
    );
  });

  it('narrows to the providers the application’s policy allows, and no further', async () => {
    const customer = await twoProviders();
    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(eq(inferenceRoutingPolicies.applicationId, customer.applicationId));
    await createNeutralRoutingPolicy({
      accountId: customer.accountId,
      applicationId: customer.applicationId,
      overrides: { providerDenylist: [customer.providers[1]] },
    });
    const grant = verifiedGrant(await authorize(request(customer)));
    expect(grant.steps[0].limits.providerAllowlist).toEqual([customer.providers[0]]);
  });

  it('sends the policy’s same-model failover to Kaana: on by default, off when the policy turns it off', async () => {
    const byDefault = await twoProviders();
    const defaulted = verifiedGrant(await authorize(request(byDefault)));
    expect(defaulted.steps[0].limits.sameModelFailover).toBe(true);

    // Off: every provider is still admitted, and Kaana is told not to fail over
    // among them. Oxy does not pick the one provider.
    const many = await twoProviders();
    await withFallback(many, {
      disabled: false,
      sameModelDeployment: false,
      authorizedCrossModel: [],
    });
    const off = verifiedGrant(await authorize(request(many)));
    expect([...off.steps[0].limits.providerAllowlist].sort()).toEqual([...many.providers].sort());
    expect(off.steps[0].limits.sameModelFailover).toBe(false);

    // A disabled fallback is the same instruction.
    const disabled = await twoProviders();
    await withFallback(disabled, {
      disabled: true,
      sameModelDeployment: false,
      authorizedCrossModel: [],
    });
    expect(
      verifiedGrant(await authorize(request(disabled))).steps[0].limits.sameModelFailover,
    ).toBe(false);
  });
});

describe('Kaana publishes how a route may be sold', () => {
  const request = (customer: AudioFixture) =>
    inferenceRequest({
      credential: customer.token,
      target: { kind: 'model', modelLine: customer.modelReference },
    });
  const republish = (
    customer: AudioFixture,
    commercial?: Parameters<typeof kaanaStub.publish>[0]['commercial'],
  ) =>
    kaanaStub.publish({
      deploymentId: customer.deploymentIds[0],
      modelReference: customer.pinnedModelReference,
      provider: customer.providers[0],
      regions: ['us-west-2'],
      ...(commercial === undefined ? {} : { commercial }),
    });

  it('sells a route published as resold to this audience, though Oxy’s own deployment rows say nothing of it', async () => {
    const customer = await textCustomer();
    await getDb()
      .update(inferenceDeployments)
      .set({ availabilityScope: 'enterprise', permissionState: 'retired', status: 'retired' })
      .where(eq(inferenceDeployments.internalRouteId, customer.deploymentIds[0]));
    expect(
      verifiedGrant(await authorize(request(customer))).steps[0].limits.providerAllowlist,
    ).toEqual([customer.providers[0]]);
  });

  it('does not sell a route for which Kaana publishes no commercial basis', async () => {
    const customer = await textCustomer();
    republish(customer);
    const result = await authorize(request(customer));
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('no_route_available');
  });

  it.each([
    [
      'an enterprise route to a public application',
      { availabilityScope: 'enterprise', commercialPermission: 'wholesale_contract' },
    ],
    [
      'an internal-only route to a third party',
      { availabilityScope: 'platform_internal', commercialPermission: 'standard_application_use' },
    ],
    [
      'a scope and a permission that disagree',
      { availabilityScope: 'public_payg', commercialPermission: 'customer_byok' },
    ],
  ] as const)('does not sell %s', async (_name, commercial) => {
    const customer = await textCustomer();
    republish(customer, commercial);
    const result = await authorize(request(customer));
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('no_route_available');
  });

  it('honours a dedicated-capacity policy from the published flag', async () => {
    const customer = await textCustomer();
    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(eq(inferenceRoutingPolicies.applicationId, customer.applicationId));
    await createNeutralRoutingPolicy({
      accountId: customer.accountId,
      applicationId: customer.applicationId,
      overrides: { dedicatedCapacity: 'require' },
    });
    republish(customer, { ...PUBLIC_RESALE });
    expect((await authorize(request(customer))).body.code).toBe('policy_violation');
    republish(customer, { ...PUBLIC_RESALE, dedicatedCapacity: true });
    verifiedGrant(await authorize(request(customer)));
  });
});

describe('a customer-key (BYOK) grant is platform_fee_only, rated at Oxy’s platform fee', () => {
  const FEE = {
    feeVersionId: 'oxy-platform-fee/test-1',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    currency: 'USD',
    perRequest: '0.010000000000',
    approvedBy: 'test-suite',
    approvalRef: 'test',
  };

  /** A BYOK-only model Kaana declares with no list price, one customer-key route, and the customer's connection. */
  async function byokCustomer(
    options: { connect?: boolean; policy?: 'prefer' | 'require' | 'disabled' } = {},
  ) {
    const customer = await textCustomer();
    const tagged = tag();
    const modelId = `acmebyok${tagged}/model`;
    const provider = `byokprov${tagged}`;
    const deploymentId = `kaana-byok-${tagged}`;
    kaanaStub.declare(declaredModel({ modelId }));
    kaanaStub.publish({
      deploymentId,
      modelReference: `${modelId}@${AUDIO_REVISION}`,
      provider,
      regions: ['eu-central-1'],
      commercial: CUSTOMER_KEY,
    });
    await getDb()
      .insert(inferenceProviders)
      .values({
        slug: provider,
        displayName: `BYOK ${provider}`,
        kind: 'customer_byok',
        retainsPayloads: false,
        retentionDays: 0,
        trainsOnCustomerData: false,
        zeroDataRetentionAvailable: true,
      });
    const handle = `kcred_${tagged.replace(/[0189]/g, 'a')}${'a'.repeat(16)}`;
    if (options.connect !== false) {
      await getDb().insert(inferenceProviderConnections).values({
        provider,
        ownerAccountId: customer.accountId,
        scopeKind: 'application',
        applicationId: customer.applicationId,
        environment: 'development',
        status: 'active',
        custodyState: 'ready',
        credentialHandle: handle,
        credentialRevision: 1,
        validationState: 'valid',
      });
    }
    if (options.policy !== undefined) {
      await getDb()
        .update(inferenceRoutingPolicies)
        .set({ status: 'archived' })
        .where(eq(inferenceRoutingPolicies.applicationId, customer.applicationId));
      await createNeutralRoutingPolicy({
        accountId: customer.accountId,
        applicationId: customer.applicationId,
        overrides: { byokPreference: options.policy },
      });
    }
    return { customer, modelId, provider, deploymentId, handle };
  }

  const request = (customer: AudioFixture, modelLine: string) =>
    inferenceRequest({ credential: customer.token, target: { kind: 'model', modelLine } });

  it('holds and settles only the platform fee, never a model price', async () => {
    const { customer, modelId, provider, handle } = await byokCustomer({ policy: 'prefer' });
    jest.spyOn(platformFee, 'activePlatformFeeSchedule').mockReturnValue(FEE);
    const grant = verifiedGrant(await authorize(request(customer, modelId)));

    expect(grant.economics.treatment).toBe('platform_fee_only');
    expect(grant.customerProviderCredential).toMatchObject({ credentialHandle: handle });
    // One request at USD 0.01; the provider bills every token to the customer.
    expect(grant.reservation?.ceiling).toEqual({ amount: '0.010000000000', currency: 'USD' });
    expect(grant.steps[0].limits.providerAllowlist).toEqual([provider]);
    expect(grant.steps[0].limits.maxFundingTier).toBeUndefined();
    expect(grant.steps[0].limits.admittedModelLines).toEqual([
      { modelLine: modelId, priceVersionId: FEE.feeVersionId },
    ]);

    const settled = await settle(
      settlementOf({
        grant,
        modelReference: `${modelId}@${AUDIO_REVISION}`,
        provider,
        units: { requests: 1, input_tokens: 800, output_tokens: 400 },
      }),
    );
    expect(settled.body).toMatchObject({ status: 'settled' });
    const [receipt] = await receiptsOf(customer.accountId);
    expect(receipt).toMatchObject({
      billedAmount: '0.010000000000',
      priceVersionId: FEE.feeVersionId,
      platformFeeOnly: true,
    });
  });

  it('refuses a customer-key route while Oxy has no approved platform fee, never at zero', async () => {
    const { customer, modelId } = await byokCustomer({ policy: 'prefer' });
    // The shipped schedule list is empty until the owner approves an amount.
    const result = await authorize(request(customer, modelId));
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('no_route_available');
    expect(await receiptsOf(customer.accountId)).toEqual([]);
  });

  it('offers a customer-key route only to an application that connected a ready key', async () => {
    const { customer, modelId } = await byokCustomer({ policy: 'prefer', connect: false });
    jest.spyOn(platformFee, 'activePlatformFeeSchedule').mockReturnValue(FEE);
    const result = await authorize(request(customer, modelId));
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('no_route_available');
  });

  it('follows the policy: disabled never serves the customer key, require serves nothing else', async () => {
    const off = await byokCustomer({ policy: 'disabled' });
    jest.spyOn(platformFee, 'activePlatformFeeSchedule').mockReturnValue(FEE);
    expect((await authorize(request(off.customer, off.modelId))).body.code).toBe(
      'policy_violation',
    );

    // `require` on a line Kaana serves on its own keys only: nothing qualifies.
    const own = await textCustomer();
    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(eq(inferenceRoutingPolicies.applicationId, own.applicationId));
    await createNeutralRoutingPolicy({
      accountId: own.accountId,
      applicationId: own.applicationId,
      overrides: { byokPreference: 'require' },
    });
    expect((await authorize(request(own, own.modelReference))).body.code).toBe('policy_violation');
  });

  it('keeps Kaana’s own keys, at the declared list, unless the policy prefers the customer key', async () => {
    const own = await textCustomer();
    jest.spyOn(platformFee, 'activePlatformFeeSchedule').mockReturnValue(FEE);
    kaanaStub.publish({
      deploymentId: `kaana-byok-${tag()}`,
      modelReference: own.pinnedModelReference,
      provider: `byokprov${tag()}`,
      regions: [],
      commercial: CUSTOMER_KEY,
    });
    const grant = verifiedGrant(await authorize(request(own, own.modelReference)));
    expect(grant.economics.treatment).toBe('commercial');
    expect(grant.customerProviderCredential).toBeUndefined();
  });
});

describe('the BYOK platform fee schedule', () => {
  const schedule = (feeVersionId: string, effectiveFrom: string, perRequest: string) => ({
    feeVersionId,
    effectiveFrom,
    currency: 'USD',
    perRequest,
    approvedBy: 'owner',
    approvalRef: 'ref',
  });

  it('ships empty: no approved amount, so nothing is rated at a fee until one is', () => {
    expect(platformFee.PLATFORM_FEE_SCHEDULES).toEqual([]);
    expect(platformFee.activePlatformFeeSchedule(Date.now())).toBeUndefined();
  });

  it('applies the latest schedule in force and never one that has not started', () => {
    const list = [
      schedule('fee-1', '2026-01-01T00:00:00.000Z', '0.01'),
      schedule('fee-2', '2026-06-01T00:00:00.000Z', '0.02'),
      schedule('fee-3', '2027-01-01T00:00:00.000Z', '0.03'),
    ];
    const at = Date.parse('2026-10-15T00:00:00.000Z');
    expect(platformFee.activePlatformFeeSchedule(at, list)?.feeVersionId).toBe('fee-2');
    expect(
      platformFee.activePlatformFeeSchedule(Date.parse('2025-01-01T00:00:00.000Z'), list),
    ).toBeUndefined();
  });

  it('rejects a malformed schedule rather than rating at it', () => {
    expect(() =>
      platformFee.activePlatformFeeSchedule(Date.now(), [
        schedule('bad', '2026-01-01T00:00:00.000Z', '-1'),
      ]),
    ).toThrow();
  });

  it('prices the fee on requests and every other unit at an explicit zero', () => {
    const list = platformFee.platformFeePriceList(
      schedule('fee-1', '2026-01-01T00:00:00.000Z', '0.01'),
    );
    expect(list.priceVersionId).toBe('fee-1');
    expect(list.unitPrices.find((entry) => entry.unit === 'requests')).toEqual({
      unit: 'requests',
      amount: '0.01',
      per: 1,
    });
    expect(
      list.unitPrices
        .filter((entry) => entry.unit !== 'requests')
        .every((entry) => Number(entry.amount) === 0),
    ).toBe(true);
    expect(list.unitPrices).toHaveLength(USAGE_UNITS.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  Reads: catalogue audience and receipts                                     */
/* -------------------------------------------------------------------------- */

describe('authorizations that hold nothing', () => {
  it('names the catalogue audience and the policy’s allowed levels', async () => {
    const customer = await textCustomer();
    const access = await authorize({
      schemaVersion: 1,
      kind: 'catalogue.read',
      credential: customer.token,
      requestId: `kreq_${tag()}`,
    });
    expect(access.status).toBe(200);
    expect(access.body).toMatchObject({
      schemaVersion: 1,
      kind: 'catalogue.read',
      audience: 'public',
      allowedLevels: [],
    });
    expect(Date.parse(String(access.body.expiresAt)) - Date.now()).toBeLessThanOrEqual(60_000);

    await getDb()
      .update(inferenceRoutingPolicies)
      .set({ status: 'archived' })
      .where(eq(inferenceRoutingPolicies.applicationId, customer.applicationId));
    await createNeutralRoutingPolicy({
      accountId: customer.accountId,
      applicationId: customer.applicationId,
      overrides: { allowedRoutingProfileIds: ['power-instant', 'power-medium'] },
    });
    const narrowed = await authorize({
      schemaVersion: 1,
      kind: 'catalogue.read',
      credential: customer.token,
      requestId: `kreq_${tag()}`,
    });
    expect(narrowed.body.allowedLevels).toEqual(['instant', 'medium']);
  });

  it('answers a settled generation as the public record — the amount, never the provider', async () => {
    const customer = await textCustomer();
    const grant = verifiedGrant(
      await authorize(
        inferenceRequest({
          credential: customer.token,
          target: { kind: 'model', modelLine: customer.modelReference },
        }),
      ),
    );
    const generationId = `gen_${tag()}`;
    await settle(
      settlementOf({
        grant,
        generationId,
        modelReference: customer.pinnedModelReference,
        provider: customer.providers[0],
        deploymentId: customer.deploymentIds[0],
      }),
    );
    const read = await authorize({
      schemaVersion: 1,
      kind: 'receipt.read',
      credential: customer.token,
      requestId: `kreq_${tag()}`,
      generationId,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      kind: 'receipt.read',
      record: {
        kind: 'charge',
        requestId: grant.requestId,
        model: customer.pinnedModelReference,
        billedAmount: '0.008400000000',
      },
    });
    expect(JSON.stringify(read.body)).not.toContain(customer.providers[0]);

    const missing = await authorize({
      schemaVersion: 1,
      kind: 'receipt.read',
      credential: customer.token,
      requestId: `kreq_${tag()}`,
      generationId: 'gen_nothing',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('model_not_found');
  });
});

/* -------------------------------------------------------------------------- */
/*  The machine lane's own rate limits                                         */
/* -------------------------------------------------------------------------- */

describe('machine-lane rate limits', () => {
  it('refuses the 61st request of a key in a minute with a retryable rate_limited', async () => {
    const customer = await textCustomer();
    const read = () =>
      authorize({
        schemaVersion: 1,
        kind: 'catalogue.read',
        credential: customer.token,
        requestId: `kreq_${tag()}`,
      });
    for (let index = 0; index < 60; index += 1) expect((await read()).status).toBe(200);
    const limited = await read();
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(limited.body.retryAfterMs).toEqual(expect.any(Number));
  });
});
