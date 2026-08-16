/**
 * The public inference edge, against a REAL Postgres, a REAL machine credential
 * and the REAL ledger (issue #972 workstream 4).
 *
 * ## The test this file exists for
 *
 * **There is no data plane, so every invoke must refuse — and refuse without
 * keeping the customer's money.** A 503 alone is a weak assertion: an edge that
 * reserved a hold and then returned 503 without releasing it would satisfy it
 * while quietly freezing a balance on every request. So the no-data-plane case
 * asserts the typed error AND that the account's spendable balance and reserved
 * balance are both exactly what they were before the request. It also asserts
 * the reservation reached `settled` rather than standing `held`, because
 * "released by the sweeper fifteen minutes later" and "released now" look
 * identical in a balance read taken immediately after.
 *
 * ## What makes the money assertions falsifiable
 *
 * Every balance assertion is paired with a case that MOVES the number — the
 * success path, driven by a fake data plane, debits an amount computed from the
 * fixture's own prices. Without it "the balance did not change" would also be
 * what a suite that never reserved anything reports.
 *
 * ## Fixtures are scoped to ids this file owns
 *
 * Every account, application, credential, publisher, model and price version is
 * created per test with a random suffix, and every assertion is scoped to them,
 * so a sibling suite seeding the shared database cannot change an answer here.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq } from 'drizzle-orm';
import type { InferenceRequest } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountBalances } from '../../db/schema/accountBalances';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
} from '../../db/schema';
import { inferenceUsageEvents } from '../../db/schema/inferenceUsageEvents';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { usageReservations } from '../../db/schema/usageReservations';
import { users } from '../../db/schema/users';
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';
import {
  createRoutingPolicy,
  resolveEffectiveRoutingPolicy,
  type RoutingPolicyControls,
} from '../../services/inferenceRoutingPolicy.service';
import type { RelayClient, RelayCompletion } from '../../services/relayClient';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { logger } from '../../utils/logger';
import { createInferenceEdgeRouter } from '../inferenceEdge';

const mockedLogger = logger as jest.Mocked<typeof logger>;

jest.setTimeout(60_000);

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

/** A server per test, so each can be given its own (or no) data plane. */
async function withServer(
  relayClient: RelayClient | undefined,
  run: (
    request: (
      method: 'GET' | 'POST',
      path: string,
      body: unknown,
      headers?: Record<string, string>
    ) => Promise<RawResponse>
  ) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/v1',
    createInferenceEdgeRouter(relayClient === undefined ? {} : { relayClient })
  );

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });

  const request = (
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<RawResponse> => {
    const { port } = server.address() as AddressInfo;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return new Promise<RawResponse>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload === undefined
              ? {}
              : { 'Content-Length': Buffer.byteLength(payload) }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            })
          );
        }
      );
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  };

  try {
    await run(request);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly token: string;
  readonly clientId: string;
  readonly modelReference: string;
  readonly modelId: string;
  readonly priceVersionId: string;
  readonly provider: string;
}

const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

interface FixtureOptions {
  readonly scopes?: string[];
  readonly fund?: string;
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
  /** Publish the route with no price version, so nothing can be quoted. */
  readonly unpriced?: boolean;
  /**
   * Publish the ROUTE as one that retains payloads and trains on them, so a
   * policy carrying the data-handling controls has something to exclude. The
   * default is the zero-retention posture every other case relies on.
   */
  readonly retainsAndTrains?: boolean;
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const db = getDb();
  const tag = suffix();

  const [account] = await db
    .insert(users)
    .values({ username: `edge-${tag}`, email: `edge-${tag}@example.test` })
    .returning({ id: users.id });

  const scopes = options.scopes ?? ['inference:invoke', 'inference:usage:read'];

  const [application] = await db
    .insert(applications)
    .values({ name: `Edge ${tag}`, ownerAccountId: account.id, scopes })
    .returning({ id: applications.id });

  const minted = generateMachineCredentialToken();
  const clientId = `oxy_dk_${tag}`;
  const [credential] = await db
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: `key-${tag}`,
      publicKey: clientId,
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      type: 'machine',
      environment: 'development',
      scopes,
      status: 'active',
    })
    .returning({ id: applicationCredentials.id });

  // Catalogue: one publisher, one model, one current revision, one approved
  // deployment. `permission_state = 'approved'` needs a legal review on the row —
  // the database refuses otherwise, and the fixture obeys the constraint.
  const publisherSlug = `pub${tag}`;
  const modelSlug = `model-${tag}`;
  const providerSlug = `prov${tag}`;

  await db
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: `Publisher ${tag}` });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: `Model ${tag}`,
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: true,
      supportsJsonMode: true,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      maxContextTokens: options.maxContextTokens ?? 200_000,
      maxOutputTokens: options.maxOutputTokens ?? 8192,
      licenseId: 'apache-2.0',
      licenseDisplayName: 'Apache 2.0',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    })
    .returning({ id: inferenceModels.id, modelId: inferenceModels.modelId });

  const revision = '2026-01-01';
  const [revisionRow] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });

  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: `Provider ${tag}`,
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

  // $3 per million input tokens, $15 per million output tokens.
  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${publisherSlug}/${modelSlug}@${revision}`,
      provider: providerSlug,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });

  await db.insert(priceVersionUnitPrices).values([
    { priceVersionId: priceVersion.id, unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 },
    { priceVersionId: priceVersion.id, unit: 'output_tokens', amount: '15.000000000000', per: 1_000_000 },
  ]);

  await db.insert(inferenceDeployments).values({
    modelRevisionId: revisionRow.id,
    providerSlug,
    regions: ['us-west-2'],
    retainsPayloads: options.retainsAndTrains === true,
    retentionDays: options.retainsAndTrains === true ? 30 : 0,
    trainsOnCustomerData: options.retainsAndTrains === true,
    zeroDataRetentionAvailable: options.retainsAndTrains !== true,
    availabilityScope: 'public_payg',
    commercialPermission: 'public_resale_approved',
    status: 'active',
    legalReviewStatus: 'approved',
    legalReviewedAt: new Date(),
    legalReviewEvidenceRef: `contract-register/${tag}`,
    permissionState: 'approved',
    ...(options.unpriced ? {} : { priceVersionId: priceVersion.id }),
  });

  await provisionBillingProfile({ accountId: account.id });
  if (options.fund !== undefined) {
    await recordTopUp({
      idempotencyKey: `edge-top-up-${tag}`,
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
    token: minted.token,
    clientId,
    modelReference: `${publisherSlug}/${modelSlug}`,
    modelId: model.modelId ?? '',
    priceVersionId: priceVersion.id,
    provider: providerSlug,
  };
}

async function balanceOf(accountId: string): Promise<{
  purchased: string;
  reserved: string;
}> {
  const [row] = await getDb()
    .select()
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, 'USD')))
    .limit(1);
  return { purchased: row.purchasedBalance, reserved: row.reservedBalance };
}

const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

/** A minimal, well-formed chat request against a fixture's model. */
const chatBody = (fixture: Fixture, overrides: Record<string, unknown> = {}) => ({
  model: fixture.modelReference,
  messages: [{ role: 'user', content: 'Say hello.' }],
  max_tokens: 100,
  ...overrides,
});

/**
 * Every routing control at its neutral value, so a case can set exactly the one
 * it is about and nothing else can be the reason a test passes.
 */
function policyControls(
  overrides: Partial<RoutingPolicyControls> = {}
): RoutingPolicyControls {
  return {
    providerAllowlist: [],
    providerDenylist: [],
    allowedRegions: [],
    deniedRegions: [],
    requireZeroDataRetention: false,
    prohibitTrainingOnCustomerData: false,
    maxPricePerUnit: [],
    optimiseFor: 'balanced',
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: false,
    fallback: { disabled: false, sameModelDeployment: true, authorizedCrossModel: [] },
    byokPreference: 'disabled',
    dedicatedCapacity: 'disabled',
    ...overrides,
  };
}

/**
 * A fake data plane. TESTS ONLY — `services/relayClient.ts` has no production
 * implementation, and this is the fake its header says belongs here.
 */
function fakeRelay(
  build: (envelope: InferenceRequest) => RelayCompletion,
  seen?: InferenceRequest[]
): RelayClient {
  return {
    execute: async (envelope) => {
      seen?.push(envelope);
      return build(envelope);
    },
  };
}

function completionFor(
  envelope: InferenceRequest,
  units: { input: number; output: number; provider: string }
): RelayCompletion {
  const modelReference =
    envelope.target.kind === 'model' ? envelope.target.modelReference : 'unknown/unknown';
  const now = new Date().toISOString();
  return {
    generationId: `gen-${randomUUID()}`,
    output: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }],
    finishReason: 'stop',
    usage: {
      schemaVersion: 1,
      requestId: envelope.attribution.requestId,
      attribution: envelope.attribution,
      outcome: 'completed',
      units: [
        { unit: 'input_tokens', quantity: units.input },
        { unit: 'output_tokens', quantity: units.output },
      ],
      usageSource: 'provider_reported',
      resolvedModelReference: modelReference,
      servingProvider: units.provider,
      routeSwitches: 0,
      startedAt: now,
      completedAt: now,
    },
  };
}

/**
 * The rollout flags this file runs with, and why it sets them (issue #972
 * workstream 16).
 *
 * All three default to the state that serves and charges nobody, so every
 * assertion here about routing, reservation and settlement would otherwise pass
 * for the wrong reason — a refusal at the gate looks exactly like a refusal
 * downstream once you are only reading the status code. `public` is the audience
 * because the fixtures mint ordinary third-party applications, and it requires
 * an armed charging authorization to resolve at all.
 *
 * The DEFAULTS are asserted in `config/__tests__/rolloutFlags.test.ts`, and
 * their effect on this very edge in `inferenceEdgeRollout.test.ts`. Nothing in
 * this file is evidence about them.
 *
 * The authorization date is comfortably in the past rather than "today": the
 * flag refuses a FUTURE date, and midnight UTC on a runner an hour behind local
 * time is a future date. A past date never expires — that is argued in
 * `config/rolloutFlags.ts` — so this fixture does not rot.
 */
const ROLLOUT_ENVIRONMENT = {
  INFERENCE_EDGE_AUDIENCE: 'public',
  INFERENCE_MACHINE_CREDENTIAL_AUTH: 'enabled',
  INFERENCE_CHARGING_AUTHORIZED: 'edge-suite-fixture:2026-08-01',
} as const;

const ORIGINAL_ROLLOUT_ENVIRONMENT = Object.fromEntries(
  Object.keys(ROLLOUT_ENVIRONMENT).map((key) => [key, process.env[key]])
);

beforeAll(async () => {
  Object.assign(process.env, ROLLOUT_ENVIRONMENT);
  await connectPostgres();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ROLLOUT_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  Authentication                                                            */
/* -------------------------------------------------------------------------- */

describe('authentication', () => {
  it('refuses a request with no bearer, with a traceable request id', async () => {
    await withServer(undefined, async (request) => {
      const response = await request('POST', '/v1/chat/completions', {
        model: 'a/b',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(response.status).toBe(401);
      expect(response.headers['x-oxy-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      // The compatibility surface speaks the OpenAI error shape.
      expect(json(response)).toEqual({
        error: {
          message: expect.any(String),
          type: 'authentication_error',
          param: null,
          code: 'authentication_failed',
        },
      });
    });
  });

  it('refuses a bare oxy_dk_ public identifier presented as a bearer', async () => {
    const fixture = await makeFixture();

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.clientId)
      );

      expect(response.status).toBe(401);
      // Positive control on the fixture itself: the SAME application's real
      // machine token is accepted past authentication, so this 401 is about the
      // credential shape and not about a broken fixture.
      const accepted = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(accepted.status).not.toBe(401);
    });
  });

  it('refuses a machine token whose credential has been revoked', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    await getDb()
      .update(applicationCredentials)
      .set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, fixture.credentialId));

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { model: fixture.modelReference, input: 'hi' },
        bearer(fixture.token)
      );
      expect(response.status).toBe(401);
      expect(json(response)).toMatchObject({ code: 'authentication_failed' });
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Authorization                                                             */
/* -------------------------------------------------------------------------- */

describe('scope authorization', () => {
  it('refuses a credential without inference:invoke before anything is resolved', async () => {
    const fixture = await makeFixture({ scopes: ['inference:models:read'] });
    const seen: InferenceRequest[] = [];

    await withServer(
      fakeRelay(
        (envelope) => completionFor(envelope, { input: 1, output: 1, provider: 'unused' }),
        seen
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi' },
          bearer(fixture.token)
        );

        expect(response.status).toBe(403);
        expect(json(response)).toMatchObject({
          code: 'insufficient_scope',
          retryable: false,
        });
        // Refused BEFORE the data plane, not after.
        expect(seen).toHaveLength(0);
      }
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  The no-data-plane refusal — the point of this PR                          */
/* -------------------------------------------------------------------------- */

describe('no data plane configured', () => {
  it('refuses with a typed, non-retryable service_unavailable', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { model: fixture.modelReference, input: 'Say hello.', maxOutputTokens: 100 },
        bearer(fixture.token)
      );

      expect(response.status).toBe(503);
      expect(json(response)).toMatchObject({
        schemaVersion: 1,
        code: 'service_unavailable',
        // Retrying does not configure a data plane. A `true` here is what turns
        // one misconfiguration into a retry storm across every SDK.
        retryable: false,
      });
      expect(json(response).requestId).toBe(response.headers['x-oxy-request-id']);
      expect(response.headers['retry-after']).toBeUndefined();
    });
  });

  it('releases the hold it took, rather than leaving the balance frozen', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const before = await balanceOf(fixture.accountId);

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { model: fixture.modelReference, input: 'Say hello.', maxOutputTokens: 100 },
        bearer(fixture.token)
      );
      expect(response.status).toBe(503);
    });

    const after = await balanceOf(fixture.accountId);
    expect(after.purchased).toBe(before.purchased);
    expect(after.reserved).toBe(before.reserved);

    // And the release happened NOW, not at the sweeper's deadline: a hold left
    // `held` would also read as an unchanged balance only until it expired.
    const holds = await getDb()
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, fixture.accountId));
    expect(holds).toHaveLength(1);
    expect(holds[0].status).toBe('settled');

    // The zero receipt the release wrote, which is what a customer reads back.
    const receipts = await getDb()
      .select({ billed: usageReceipts.billedAmount, outcome: usageReceipts.outcome })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipts).toHaveLength(1);
    expect(Number(receipts[0].billed)).toBe(0);
    expect(receipts[0].outcome).toBe('failed');
  });

  it('never falls through to the Alia proxy', async () => {
    // The edge router is mounted alone here, so a fall-through would 404 rather
    // than proxy. The assertion that matters is the shape of the answer: a
    // typed inference refusal, never an `ALIA_PROXY_ERROR` or a 404.
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );

      expect(response.status).toBe(503);
      const body = json(response) as { error: { code: string } };
      expect(body.error.code).toBe('service_unavailable');
      expect(response.headers['x-oxy-error-retryable']).toBe('false');
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Admission limits                                                          */
/* -------------------------------------------------------------------------- */

describe('admission', () => {
  it('answers model_not_found for a model that does not exist', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { model: 'nobody/nothing', input: 'hi' },
        bearer(fixture.token)
      );
      expect(response.status).toBe(404);
      expect(json(response)).toMatchObject({ code: 'model_not_found', retryable: false });
    });
  });

  it('refuses a route published with no price rather than serving it unpriced', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000', unpriced: true });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { model: fixture.modelReference, input: 'hi' },
        bearer(fixture.token)
      );
      expect(response.status).toBe(503);
      expect(json(response)).toMatchObject({ code: 'no_route_available' });
    });
  });

  it('refuses an output ceiling above the model’s own', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000', maxOutputTokens: 256 });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { model: fixture.modelReference, input: 'hi', maxOutputTokens: 1000 },
        bearer(fixture.token)
      );
      expect(response.status).toBe(400);
      expect(json(response)).toMatchObject({ code: 'output_limit_exceeded' });
    });
  });

  it('refuses a request whose input plus maximum output exceeds the context', async () => {
    const fixture = await makeFixture({
      fund: '10.000000000000',
      maxContextTokens: 200,
      maxOutputTokens: 100,
    });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { model: fixture.modelReference, input: 'x'.repeat(500), maxOutputTokens: 50 },
        bearer(fixture.token)
      );
      expect(response.status).toBe(400);
      expect(json(response)).toMatchObject({ code: 'context_length_exceeded' });
    });
  });

  it('refuses streaming with a typed error rather than silently answering non-streamed', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture, { stream: true }),
        bearer(fixture.token)
      );
      expect(response.status).toBe(400);
      const body = json(response) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });
  });

  it('refuses a body over the edge limit with a typed 413, not the parser’s bare one', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(undefined, async (request) => {
      // ~800 KB: above the edge's 768 KiB ceiling and BELOW the global
      // `express.json({ limit: '1mb' })`, which is the band where the edge's
      // own typed refusal is the one a customer receives. Above 1 MiB the
      // parser answers first, with its own untyped 413.
      const response = await request(
        'POST',
        '/v1/responses',
        { model: fixture.modelReference, input: 'x'.repeat(800_000) },
        bearer(fixture.token)
      );
      expect(response.status).toBe(413);
      expect(json(response)).toMatchObject({ code: 'request_too_large' });
      expect(response.headers['x-oxy-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('refuses a non-text input part, so the input ceiling stays a real bound', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture, {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { kind: 'url', url: 'https://example.test/a.png' } },
              ],
            },
          ],
        }),
        bearer(fixture.token)
      );
      expect(response.status).toBe(400);
      const body = json(response) as { error: { code: string } };
      expect(body.error.code).toBe('unsupported_modality');
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Reservation                                                               */
/* -------------------------------------------------------------------------- */

describe('spend reservation', () => {
  it('rejects an unfundable request BEFORE it reaches the data plane', async () => {
    // Provisioned, funded with nothing. The hold for 100 output tokens at $15/M
    // cannot be covered.
    const fixture = await makeFixture();
    const seen: InferenceRequest[] = [];

    await withServer(
      fakeRelay(
        (envelope) => completionFor(envelope, { input: 10, output: 10, provider: 'unused' }),
        seen
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 100 },
          bearer(fixture.token)
        );

        expect(response.status).toBe(402);
        expect(json(response)).toMatchObject({
          code: 'insufficient_balance',
          retryable: false,
        });
        // The whole point: nothing was forwarded.
        expect(seen).toHaveLength(0);
      }
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  The served path, driven by a fake data plane                              */
/* -------------------------------------------------------------------------- */

describe('a served request', () => {
  it('forwards a versioned, attributed envelope and settles the exact usage', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const before = await balanceOf(fixture.accountId);
    const seen: InferenceRequest[] = [];

    await withServer(
      fakeRelay(
        (envelope) =>
          completionFor(envelope, { input: 12, output: 2000, provider: fixture.provider }),
        seen
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          // `maxOutputTokens` is what the hold is sized on, so the reported
          // usage below sits inside it. A report ABOVE the hold is a different
          // case with its own test — the ledger refuses it rather than charging.
          { model: fixture.modelReference, input: 'Say hello.', maxOutputTokens: 3000 },
          { ...bearer(fixture.token), 'X-Oxy-User-Id': 'end-user-42' }
        );

        expect(response.status).toBe(200);
        const body = json(response);
        expect(body).toMatchObject({
          schemaVersion: 1,
          // Always revision-pinned, even though the request named only the model.
          model: `${fixture.modelReference}@2026-01-01`,
          finishReason: 'stop',
          routingPolicy: { routingPolicyId: 'platform-default', policyVersion: 1 },
        });
        expect(response.headers['x-oxy-usage-input-tokens']).toBe('12');
        expect(response.headers['x-oxy-usage-output-tokens']).toBe('2000');

        // The envelope: versioned, attributed, and the delegated user is NOT the
        // billing principal.
        expect(seen).toHaveLength(1);
        const envelope = seen[0];
        expect(envelope.schemaVersion).toBe(1);
        expect(envelope.attribution.principal.billing.accountId).toBe(fixture.accountId);
        expect(envelope.attribution.principal.applicationId).toBe(fixture.applicationId);
        expect(envelope.attribution.principal.credentialId).toBe(fixture.credentialId);
        expect(envelope.attribution.userId).toBe('end-user-42');
        expect(envelope.attribution.principal.billing).not.toHaveProperty('userId');
        expect(envelope.routingPolicy).toEqual({
          routingPolicyId: 'platform-default',
          policyVersion: 1,
        });
        expect(envelope.stream).toBe(false);
      }
    );

    // $3/M × 12 + $15/M × 2000 = 0.000036 + 0.030000 = 0.030036, exactly.
    const after = await balanceOf(fixture.accountId);
    expect(Number(before.purchased) - Number(after.purchased)).toBeCloseTo(0.030036, 9);
    expect(Number(after.reserved)).toBe(0);

    const [receipt] = await getDb()
      .select()
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(Number(receipt.billedAmount)).toBeCloseTo(0.030036, 9);
    expect(receipt.inputTokens).toBe(12);
    expect(receipt.outputTokens).toBe(2000);
    expect(receipt.delegatedUserId).toBe('end-user-42');
  });

  it('renders the OpenAI shape on the compatibility surface', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(
      fakeRelay((envelope) =>
        completionFor(envelope, { input: 12, output: 7, provider: fixture.provider })
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/chat/completions',
          chatBody(fixture),
          bearer(fixture.token)
        );

        expect(response.status).toBe(200);
        expect(json(response)).toMatchObject({
          object: 'chat.completion',
          model: `${fixture.modelReference}@2026-01-01`,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hello.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        });
        // Oxy metadata rides in headers so the body stays stock-parseable.
        expect(json(response)).not.toHaveProperty('routingPolicy');
        expect(response.headers['x-oxy-model']).toBe(`${fixture.modelReference}@2026-01-01`);
      }
    );
  });

  it('re-nests the partitioned units for the OpenAI dialect, and still prices them once', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    // The fixture prices only input and output, and a metered unit with no price
    // is refused rather than dropped — so the two child lines have to be priced
    // before they can be reported at all. A tenth of the input price for a cache
    // hit and the output price for a reasoning token is what providers charge,
    // and it is also what the hold this route takes can cover: the ceiling is
    // sized as `input × prompt estimate + output × max_tokens`, so a child unit
    // priced ABOVE its parent would settle past its own hold.
    await getDb()
      .insert(priceVersionUnitPrices)
      .values([
        {
          priceVersionId: fixture.priceVersionId,
          unit: 'cached_input_tokens',
          amount: '0.300000000000',
          per: 1_000_000,
        },
        {
          priceVersionId: fixture.priceVersionId,
          unit: 'reasoning_tokens',
          amount: '15.000000000000',
          per: 1_000_000,
        },
      ]);

    await withServer(
      fakeRelay((envelope) => {
        const completion = completionFor(envelope, {
          input: 1000,
          output: 200,
          provider: fixture.provider,
        });
        return {
          ...completion,
          // A 10 000-token prompt, 9 000 of it served from cache; a 1 000-token
          // completion, 800 of it reasoning — stated as the PARTITION the
          // contract asks for.
          usage: {
            ...completion.usage,
            units: [
              { unit: 'input_tokens' as const, quantity: 1_000 },
              { unit: 'cached_input_tokens' as const, quantity: 9_000 },
              { unit: 'output_tokens' as const, quantity: 200 },
              { unit: 'reasoning_tokens' as const, quantity: 800 },
            ],
          },
        };
      }),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/chat/completions',
          // A prompt long enough that the edge's own character-count ceiling
          // covers the 10 000 tokens reported against it, and an output ceiling
          // covering the 1 000 generated: the hold has to be able to cover the
          // whole partition, or this would be testing the reservation instead.
          chatBody(fixture, {
            messages: [{ role: 'user', content: 'word '.repeat(2_000) }],
            max_tokens: 1_000,
          }),
          bearer(fixture.token)
        );

        expect(response.status).toBe(200);
        // The dialect nests, so a stock client reads the prompt and completion
        // sizes its provider would have quoted — not the uncached remainders.
        expect(json(response)).toMatchObject({
          usage: {
            prompt_tokens: 10_000,
            completion_tokens: 1_000,
            total_tokens: 11_000,
            prompt_tokens_details: { cached_tokens: 9_000 },
            completion_tokens_details: { reasoning_tokens: 800 },
          },
        });
        // Oxy's own headers keep the partition, so either view can be
        // reconstructed from the other.
        expect(response.headers['x-oxy-usage-input-tokens']).toBe('1000');
        expect(response.headers['x-oxy-usage-cached-input-tokens']).toBe('9000');
        expect(response.headers['x-oxy-usage-output-tokens']).toBe('200');
        expect(response.headers['x-oxy-usage-reasoning-tokens']).toBe('800');
      }
    );

    // 1000·3/1e6 + 9000·0.3/1e6 + 200·15/1e6 + 800·15/1e6 = 0.0207 — the
    // partition priced once. The nested numbers this body renders, priced the
    // same way, would have come to 0.0597 for the same request.
    const [receipt] = await getDb()
      .select()
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(Number(receipt.billedAmount)).toBeCloseTo(0.0207, 9);
    expect(receipt.inputTokens).toBe(1_000);
    expect(receipt.cachedInputTokens).toBe(9_000);
    expect(receipt.outputTokens).toBe(200);
    expect(receipt.reasoningTokens).toBe(800);
  });

  it('refuses to charge past the hold when the data plane reports more than was reserved', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const before = await balanceOf(fixture.accountId);

    await withServer(
      // 8000 output tokens against a hold sized for 10. ADR 0009: capping the
      // charge at the hold would make the receipt's own arithmetic disagree with
      // its price snapshot, and charging past it is the unreserved execution the
      // reservation exists to prevent — so the ledger writes nothing.
      fakeRelay((envelope) =>
        completionFor(envelope, { input: 5, output: 8000, provider: fixture.provider })
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(500);
        expect(json(response)).toMatchObject({ code: 'internal_error' });
      }
    );

    // No receipt: the customer was not billed for the over-report.
    const receipts = await getDb()
      .select({ id: usageReceipts.id })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipts).toHaveLength(0);

    // The hold is left standing ON PURPOSE, so the discrepancy is loud; the
    // expiry sweeper releases it at its deadline. Asserted rather than assumed,
    // because "the money came back" and "the money is stuck" are the two
    // outcomes a reader will want to know apart.
    const [hold] = await getDb()
      .select({ status: usageReservations.status })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, fixture.accountId));
    expect(hold.status).toBe('held');
    const after = await balanceOf(fixture.accountId);
    expect(Number(after.reserved)).toBeGreaterThan(Number(before.reserved));
  });

  it('refuses a completion that names a model the edge did not admit', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(
      fakeRelay((envelope) => {
        const completion = completionFor(envelope, {
          input: 5,
          output: 5,
          provider: fixture.provider,
        });
        return {
          ...completion,
          usage: {
            ...completion.usage,
            // A substitution no routing policy authorized.
            resolvedModelReference: 'someone/else@2026-01-01',
          },
        };
      }),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(403);
        expect(json(response)).toMatchObject({ code: 'policy_violation' });
      }
    );

    // And the customer was not charged for it.
    const [receipt] = await getDb()
      .select({ billed: usageReceipts.billedAmount })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(Number(receipt.billed)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Correlation and timings — issue #972 workstream 16, observability         */
/* -------------------------------------------------------------------------- */

describe('requestId correlation', () => {
  /**
   * The epic asks for one id across the edge, the data plane, the ledger and the
   * customer's receipt. Four of those five legs are assertable here; the fifth —
   * the id as the DATA PLANE's own logs record it — cannot be, because there is
   * no data plane. What CAN be asserted about that leg is the enforcement: the
   * edge sends the id and refuses a report that answers a different one, which
   * is the case below this.
   */
  it('carries one id from the response to the envelope, the reservation, the telemetry event and the receipt', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const seen: InferenceRequest[] = [];
    let requestId = '';

    await withServer(
      fakeRelay(
        (envelope) =>
          completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
        seen
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'Say hello.', maxOutputTokens: 100 },
          bearer(fixture.token)
        );

        expect(response.status).toBe(200);
        const header = response.headers['x-oxy-request-id'];
        // The header is the id a customer quotes in a support request, so it is
        // the one every other leg is compared against. Typed first: an absent
        // header would otherwise make every comparison below compare `undefined`
        // to `undefined` and pass.
        expect(typeof header).toBe('string');
        requestId = header as string;
        expect(requestId.length).toBeGreaterThan(0);
        expect(json(response).requestId).toBe(requestId);
      }
    );

    // Leg 1 — what the data plane was told.
    expect(seen).toHaveLength(1);
    expect(seen[0].attribution.requestId).toBe(requestId);

    // Leg 2 — the ledger's hold. Every row read is scoped to this fixture's own
    // account and asserted to EXIST: "no row matched" and "the row matched and
    // agreed" are otherwise the same green.
    const reservations = await getDb()
      .select({ requestId: usageReservations.requestId })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, fixture.accountId));
    expect(reservations).toHaveLength(1);
    expect(reservations[0].requestId).toBe(requestId);

    // Leg 3 — the usage stream the dashboards read.
    const events = await getDb()
      .select({ requestId: inferenceUsageEvents.requestId })
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.accountId, fixture.accountId));
    expect(events).toHaveLength(1);
    expect(events[0].requestId).toBe(requestId);

    // Leg 4 — the customer's receipt, which `GET /v1/generations/:id` resolves
    // by exactly this id.
    const receipts = await getDb()
      .select({ requestId: usageReceipts.requestId })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].requestId).toBe(requestId);
  });

  it('refuses a usage report that answers a different request id, and keeps the money whole', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const before = await balanceOf(fixture.accountId);

    await withServer(
      fakeRelay((envelope) => {
        const completion = completionFor(envelope, {
          input: 5,
          output: 5,
          provider: fixture.provider,
        });
        return {
          ...completion,
          // A well-formed report about somebody else's request. Accepting it
          // would settle this customer's hold against another request's usage,
          // and the correlation the case above asserts would be a coincidence
          // rather than a guarantee.
          usage: { ...completion.usage, requestId: randomUUID() },
        };
      }),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(500);
        expect(json(response)).toMatchObject({ code: 'internal_error' });
      }
    );

    const after = await balanceOf(fixture.accountId);
    expect(Number(after.purchased)).toBe(Number(before.purchased));
    expect(Number(after.reserved)).toBe(0);
  });
});

describe('edge timings', () => {
  it('records its own latency, and forwards the data plane’s route switches and time to first token', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(
      fakeRelay((envelope) => {
        const completion = completionFor(envelope, {
          input: 12,
          output: 20,
          provider: fixture.provider,
        });
        // Both differ from what the recorder writes when nothing is passed (0
        // and NULL), which is what makes this falsifiable: an edge that dropped
        // the report's figures would still produce a row.
        return {
          ...completion,
          usage: { ...completion.usage, routeSwitches: 2, timeToFirstTokenMs: 137 },
        };
      }),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'Say hello.', maxOutputTokens: 100 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(200);
      }
    );

    const [event] = await getDb()
      .select({
        latencyMs: inferenceUsageEvents.latencyMs,
        timeToFirstTokenMs: inferenceUsageEvents.timeToFirstTokenMs,
        routeSwitches: inferenceUsageEvents.routeSwitches,
      })
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.accountId, fixture.accountId));

    // Greater than zero, not merely non-null: a hardcoded `0` and a column
    // nobody writes are both what a missing metric looks like, and this request
    // made several round trips to a real database before the row was written.
    expect(event.latencyMs).toBeGreaterThan(0);
    expect(event.routeSwitches).toBe(2);
    expect(event.timeToFirstTokenMs).toBe(137);
  });

  it('leaves time to first token NULL when the data plane reported none', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(
      fakeRelay((envelope) =>
        completionFor(envelope, { input: 12, output: 20, provider: fixture.provider })
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'Say hello.', maxOutputTokens: 100 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(200);
      }
    );

    const [event] = await getDb()
      .select({
        latencyMs: inferenceUsageEvents.latencyMs,
        timeToFirstTokenMs: inferenceUsageEvents.timeToFirstTokenMs,
        routeSwitches: inferenceUsageEvents.routeSwitches,
      })
      .from(inferenceUsageEvents)
      .where(eq(inferenceUsageEvents.accountId, fixture.accountId));

    // Unknown stays unknown. Imputing a number here would put a fabricated
    // latency into every dashboard the moment a provider stops reporting one.
    expect(event.timeToFirstTokenMs).toBeNull();
    expect(event.routeSwitches).toBe(0);
    // …while Oxy's own measurement, which does not depend on the report, is
    // still there. Without this the case above would also pass for an edge that
    // stopped writing latency altogether.
    expect(event.latencyMs).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  The routing policy a request is admitted under                            */
/* -------------------------------------------------------------------------- */

describe('routing policy', () => {
  it('records the platform default when the application has configured none', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const seen: InferenceRequest[] = [];

    await withServer(
      fakeRelay(
        (envelope) => completionFor(envelope, { input: 5, output: 5, provider: fixture.provider }),
        seen
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(200);
        expect(seen[0].routingPolicy).toEqual({
          routingPolicyId: 'platform-default',
          policyVersion: 1,
        });
      }
    );

    // No version ROW to point at, which is how a reader tells "served under the
    // platform default" from "served under a policy somebody configured".
    const [receipt] = await getDb()
      .select({ versionId: usageReceipts.routingPolicyVersionId })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipt.versionId).toBeNull();
  });

  it('pins the application’s own policy version on the envelope and the receipt', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const created = await createRoutingPolicy({
      target: {
        kind: 'application',
        accountId: fixture.accountId,
        applicationId: fixture.applicationId,
      },
      controls: policyControls(),
      createdByUserId: fixture.accountId,
    });
    expect(created.status).toBe('written');
    if (created.status !== 'written') return;

    // The version ROW id comes from the same resolver the edge reads, so the
    // assertion below is about what the edge pinned rather than about a second
    // lookup that could disagree with it.
    const effective = await resolveEffectiveRoutingPolicy(fixture.applicationId);
    expect(effective.status).toBe('resolved');
    if (effective.status !== 'resolved') return;

    const seen: InferenceRequest[] = [];
    await withServer(
      fakeRelay(
        (envelope) => completionFor(envelope, { input: 5, output: 5, provider: fixture.provider }),
        seen
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(200);
        expect(seen[0].routingPolicy).toEqual({
          routingPolicyId: created.policy.routingPolicyId,
          policyVersion: created.policy.policyVersion,
        });
        // The response echoes the same reference, so a customer can explain
        // their own charge without reading the ledger.
        expect(json(response).routingPolicy).toEqual(seen[0].routingPolicy);
      }
    );

    const [receipt] = await getDb()
      .select({ versionId: usageReceipts.routingPolicyVersionId })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    // The exact version row, under ON DELETE RESTRICT: a charge can always
    // explain itself against the constraints that were in force.
    expect(receipt.versionId).toBe(effective.stored.versionId);
  });

  it('serves a request that names no model from the policy’s default target', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const created = await createRoutingPolicy({
      target: {
        kind: 'application',
        accountId: fixture.accountId,
        applicationId: fixture.applicationId,
      },
      controls: policyControls({
        defaultTarget: { kind: 'model', modelReference: fixture.modelReference },
      }),
      createdByUserId: fixture.accountId,
    });
    expect(created.status).toBe('written');

    const seen: InferenceRequest[] = [];
    await withServer(
      fakeRelay(
        (envelope) => completionFor(envelope, { input: 5, output: 5, provider: fixture.provider }),
        seen
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(200);
        expect(seen[0].target).toEqual({
          kind: 'model',
          modelReference: `${fixture.modelReference}@2026-01-01`,
        });
      }
    );
  });

  it('refuses a request that names no model when no policy default exists', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { input: 'hi', maxOutputTokens: 10 },
        bearer(fixture.token)
      );
      expect(response.status).toBe(400);
      expect(json(response)).toMatchObject({ code: 'invalid_request', param: 'model' });
    });
  });

  /* ------------------------------------------------------------------------ */
  /*  The policy is ENFORCED, not merely recorded (issue #1011)               */
  /* ------------------------------------------------------------------------ */

  it('refuses the request when the only route violates the policy, and keeps the money whole', async () => {
    // The route retains payloads and trains on them; the policy forbids both.
    // Before #1011 this request was SERVED and the receipt still named the
    // policy version that forbade it.
    const fixture = await makeFixture({ fund: '10.000000000000', retainsAndTrains: true });
    const created = await createRoutingPolicy({
      target: {
        kind: 'application',
        accountId: fixture.accountId,
        applicationId: fixture.applicationId,
      },
      controls: policyControls({
        requireZeroDataRetention: true,
        prohibitTrainingOnCustomerData: true,
      }),
      createdByUserId: fixture.accountId,
    });
    expect(created.status).toBe('written');

    const before = await balanceOf(fixture.accountId);
    const seen: InferenceRequest[] = [];

    await withServer(
      fakeRelay(
        (envelope) => completionFor(envelope, { input: 5, output: 5, provider: fixture.provider }),
        seen
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );

        // 403, non-retryable, and the message names the controls — a refusal a
        // customer can act on without opening a ticket.
        expect(response.status).toBe(403);
        expect(json(response)).toMatchObject({ code: 'policy_violation', retryable: false });
        expect(json(response).message).toContain('requireZeroDataRetention');
        expect(json(response).message).toContain('prohibitTrainingOnCustomerData');
        // And ONLY the controls that actually excluded something — a message
        // that listed every control would satisfy the two lines above while
        // telling the customer nothing.
        expect(json(response).message).not.toContain('oxyHostedOnly');

        // A refusal, not a downgrade: a working data plane was available and it
        // was never asked. Without this the test would pass against an edge that
        // served the request and then reported an error.
        expect(seen).toHaveLength(0);
      }
    );

    // Nothing was reserved and nothing was charged, because the refusal happens
    // before the hold.
    const after = await balanceOf(fixture.accountId);
    expect(after).toEqual(before);
    const receipts = await getDb()
      .select({ id: usageReceipts.id })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipts).toHaveLength(0);
    const reservations = await getDb()
      .select({ id: usageReservations.id })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, fixture.accountId));
    expect(reservations).toHaveLength(0);
  });

  it('serves the same request when the route conforms — the control for the refusal above', async () => {
    // Same policy, a route that satisfies it. Without this case the refusal
    // could be any of the edge's other 403s, or a fixture that never resolved.
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const created = await createRoutingPolicy({
      target: {
        kind: 'application',
        accountId: fixture.accountId,
        applicationId: fixture.applicationId,
      },
      controls: policyControls({
        requireZeroDataRetention: true,
        prohibitTrainingOnCustomerData: true,
      }),
      createdByUserId: fixture.accountId,
    });
    expect(created.status).toBe('written');

    await withServer(
      fakeRelay((envelope) =>
        completionFor(envelope, { input: 5, output: 5, provider: fixture.provider })
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(200);
      }
    );
  });

  it('serves a retaining route to an application whose policy does not forbid it', async () => {
    // The other direction, and the guard against over-enforcement: the same
    // retaining route is perfectly servable when nothing in the policy excludes
    // it. A filter that rejected on the wrong column would fail here.
    const fixture = await makeFixture({ fund: '10.000000000000', retainsAndTrains: true });
    const created = await createRoutingPolicy({
      target: {
        kind: 'application',
        accountId: fixture.accountId,
        applicationId: fixture.applicationId,
      },
      controls: policyControls(),
      createdByUserId: fixture.accountId,
    });
    expect(created.status).toBe('written');

    await withServer(
      fakeRelay((envelope) =>
        completionFor(envelope, { input: 5, output: 5, provider: fixture.provider })
      ),
      async (request) => {
        const response = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(response.status).toBe(200);
      }
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Idempotency                                                               */
/* -------------------------------------------------------------------------- */

describe('idempotency', () => {
  it('charges once for a repeated Idempotency-Key', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const key = `idem-${suffix()}`;
    const seen: InferenceRequest[] = [];

    await withServer(
      fakeRelay(
        (envelope) => completionFor(envelope, { input: 5, output: 8, provider: fixture.provider }),
        seen
      ),
      async (request) => {
        const first = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          { ...bearer(fixture.token), 'Idempotency-Key': key }
        );
        expect(first.status).toBe(200);

        const second = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          { ...bearer(fixture.token), 'Idempotency-Key': key }
        );
        expect(second.status).toBe(409);
        expect(json(second)).toMatchObject({
          code: 'idempotency_conflict',
          retryable: false,
        });

        // The second request never reached the data plane, so it can never have
        // produced a second charge.
        expect(seen).toHaveLength(1);
      }
    );

    const receipts = await getDb()
      .select({ id: usageReceipts.id })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipts).toHaveLength(1);
  });

  it('refuses an Idempotency-Key too long to key on rather than truncating it', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/responses',
        { model: fixture.modelReference, input: 'hi' },
        { ...bearer(fixture.token), 'Idempotency-Key': 'k'.repeat(200) }
      );
      expect(response.status).toBe(400);
      expect(json(response)).toMatchObject({
        code: 'invalid_request',
        param: 'Idempotency-Key',
      });
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  GET /v1/generations/:id                                                   */
/* -------------------------------------------------------------------------- */

describe('GET /v1/generations/:id', () => {
  it('returns the receipt to the application that spent the money', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });

    await withServer(
      fakeRelay((envelope) =>
        completionFor(envelope, { input: 12, output: 2000, provider: fixture.provider })
      ),
      async (request) => {
        const served = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 3000 },
          bearer(fixture.token)
        );
        expect(served.status).toBe(200);
        const requestId = json(served).requestId as string;

        const receipt = await request(
          'GET',
          `/v1/generations/${requestId}`,
          undefined,
          bearer(fixture.token)
        );

        expect(receipt.status).toBe(200);
        const data = (json(receipt) as { data: Record<string, unknown> }).data;
        expect(data).toMatchObject({
          schemaVersion: 1,
          requestId,
          applicationId: fixture.applicationId,
          credentialId: fixture.credentialId,
          outcome: 'completed',
          usageSource: 'provider_reported',
          currency: 'USD',
          platformFeeOnly: false,
        });
        expect(Number(data.billedAmount)).toBeCloseTo(0.030036, 9);
        // Every unit column, zeros included — see the serializer's comment.
        expect(data.units).toEqual(
          expect.arrayContaining([
            { unit: 'input_tokens', quantity: 12 },
            { unit: 'output_tokens', quantity: 2000 },
            { unit: 'images', quantity: 0 },
          ])
        );
        // The price snapshot, so the arithmetic is checkable without the price
        // version still existing.
        expect(data.priceSnapshot).toMatchObject({
          priceVersionId: fixture.priceVersionId,
          currency: 'USD',
        });
      }
    );
  });

  it('tells another application’s credential the receipt does not exist', async () => {
    const spender = await makeFixture({ fund: '10.000000000000' });
    const stranger = await makeFixture({ fund: '10.000000000000' });

    await withServer(
      fakeRelay((envelope) =>
        completionFor(envelope, { input: 10, output: 10, provider: spender.provider })
      ),
      async (request) => {
        const served = await request(
          'POST',
          '/v1/responses',
          { model: spender.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(spender.token)
        );
        expect(served.status).toBe(200);
        const requestId = json(served).requestId as string;

        // Positive control: the owner CAN read it, so a 404 below is about
        // entitlement and not about a receipt that was never written.
        const owner = await request(
          'GET',
          `/v1/generations/${requestId}`,
          undefined,
          bearer(spender.token)
        );
        expect(owner.status).toBe(200);

        const other = await request(
          'GET',
          `/v1/generations/${requestId}`,
          undefined,
          bearer(stranger.token)
        );
        expect(other.status).toBe(404);
      }
    );
  });

  it('refuses a credential without inference:usage:read', async () => {
    const fixture = await makeFixture({ scopes: ['inference:invoke'], fund: '10.000000000000' });

    await withServer(
      fakeRelay((envelope) =>
        completionFor(envelope, { input: 10, output: 10, provider: fixture.provider })
      ),
      async (request) => {
        const served = await request(
          'POST',
          '/v1/responses',
          { model: fixture.modelReference, input: 'hi', maxOutputTokens: 10 },
          bearer(fixture.token)
        );
        expect(served.status).toBe(200);

        const receipt = await request(
          'GET',
          `/v1/generations/${json(served).requestId as string}`,
          undefined,
          bearer(fixture.token)
        );
        expect(receipt.status).toBe(404);
      }
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Prompts stay out of the logs                                              */
/* -------------------------------------------------------------------------- */

describe('logging', () => {
  it('never writes a prompt, a tool argument or an output into a log line', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const promptMarker = `PROMPT-MARKER-${suffix()}`;
    const toolMarker = `TOOL-MARKER-${suffix()}`;

    await withServer(
      fakeRelay((envelope) => ({
        ...completionFor(envelope, { input: 10, output: 10, provider: fixture.provider }),
        output: [
          { role: 'assistant', content: [{ type: 'text', text: `OUTPUT-${promptMarker}` }] },
        ],
      })),
      async (request) => {
        // A served request, so the whole pipeline runs...
        const served = await request(
          'POST',
          '/v1/responses',
          {
            model: fixture.modelReference,
            input: [
              {
                role: 'user',
                content: [{ type: 'text', text: promptMarker }],
              },
            ],
            maxOutputTokens: 10,
            tools: [
              {
                type: 'function',
                name: 'lookup',
                description: toolMarker,
                parameters: { type: 'object' },
              },
            ],
          },
          bearer(fixture.token)
        );
        expect(served.status).toBe(200);

        // ...and a refused one, because refusals are where a body is most
        // tempting to log "for debugging".
        const refused = await request(
          'POST',
          '/v1/responses',
          { model: 'nobody/nothing', input: promptMarker },
          bearer(fixture.token)
        );
        expect(refused.status).toBe(404);
      }
    );

    const calls = [
      ...mockedLogger.warn.mock.calls,
      ...mockedLogger.error.mock.calls,
      ...mockedLogger.info.mock.calls,
      ...mockedLogger.debug.mock.calls,
    ];

    // VACUITY FLOOR: if the logger were never called, "no marker appears" would
    // be trivially true and this test would measure nothing.
    expect(calls.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(promptMarker);
    expect(serialized).not.toContain(toolMarker);
    // POSITIVE CONTROL on the search itself: something that IS logged is found
    // by the same JSON.stringify pass, so a marker's absence is a real absence
    // and not an unreadable haystack.
    expect(serialized).toContain('inference.edge.refused');
  });
});
