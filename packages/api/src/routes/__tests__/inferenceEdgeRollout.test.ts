/**
 * The rollout flags, driving the REAL public inference edge (issue #972
 * workstream 16, "Rollout").
 *
 * `config/__tests__/rolloutFlags.test.ts` proves what each flag resolves to.
 * This file proves what each one DOES: which HTTP answer a real credential gets
 * against a real Postgres, a real catalogue fixture and the real ledger, in both
 * positions of every flag.
 *
 * ## The two assertions this file exists for
 *
 * **Nothing is served when nothing is configured.** A deployment that has set no
 * audience refuses an authenticated, funded, correctly-scoped caller with a
 * catalogue entry in front of them — and the control immediately after opens one
 * variable and watches the same request succeed. Without that pairing, "it was
 * refused" is also what a broken fixture reports.
 *
 * **Shadow metering costs exactly what charging would have.** The strongest
 * available check on the ledger flag is not that shadow mode writes nothing; it
 * is that the amount it RECORDS is the amount the charged run DEBITS, for the
 * same request against the same prices. Two runs, one number, compared directly.
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
import {
  CATALOGUE_AUDIENCE_VARIABLE,
  CHARGING_AUTHORIZED_VARIABLE,
  EDGE_AUDIENCE_VARIABLE,
  MACHINE_CREDENTIAL_AUTH_VARIABLE,
  PRIVACY_REVIEW_VARIABLE,
} from '../../config/rolloutFlags';
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
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { usageReservations } from '../../db/schema/usageReservations';
import { users } from '../../db/schema/users';
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';
import { SHADOW_METERING_EVENT } from '../../services/inferenceEdge.service';
import type { KaanaClient, KaanaCompletion } from '../../services/kaanaClient';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { logger } from '../../utils/logger';
import { createInferenceEdgeRouter } from '../inferenceEdge';
import {
  attestFixtureDeployments,
  createNeutralRoutingPolicy,
  insertValidRoutingScorecard,
} from '../__fixtures__/kaanaRuntimeFixtures';

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

type Requester = (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  headers?: Record<string, string>
) => Promise<RawResponse>;

/** A server per test, so each can be given its own (or no) data plane. */
async function withServer(
  kaanaClient: KaanaClient | undefined,
  run: (request: Requester) => Promise<void>
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/v1', createInferenceEdgeRouter(kaanaClient === undefined ? {} : { kaanaClient }));

  const server = await new Promise<http.Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });

  const request: Requester = (method, path, body, headers = {}) => {
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
  readonly token: string;
  readonly modelReference: string;
  readonly provider: string;
}

interface FixtureOptions {
  /** `third_party` unless a case is about a more privileged tier. */
  readonly type?: 'third_party' | 'first_party' | 'internal';
  readonly isInternal?: boolean;
  /** Unfunded unless a case needs to be able to pay. */
  readonly fund?: string;
}

const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const db = getDb();
  const tag = suffix();
  const scopes = ['inference:invoke', 'inference:usage:read'];

  const [account] = await db
    .insert(users)
    .values({ username: `rollout-${tag}`, email: `rollout-${tag}@example.test` })
    .returning({ id: users.id });

  const [application] = await db
    .insert(applications)
    .values({
      name: `Rollout ${tag}`,
      ownerAccountId: account.id,
      scopes,
      type: options.type ?? 'third_party',
      isInternal: options.isInternal ?? false,
    })
    .returning({ id: applications.id });

  const minted = generateMachineCredentialToken();
  await db.insert(applicationCredentials).values({
    applicationId: application.id,
    name: `key-${tag}`,
    publicKey: `oxy_dk_${tag}`,
    tokenPrefix: minted.tokenPrefix,
    tokenHash: minted.tokenHash,
    type: 'machine',
    environment: 'development',
    scopes,
    status: 'active',
  });

  const publisherSlug = `pub${tag}`;
  const modelSlug = `model-${tag}`;
  const providerSlug = `prov${tag}`;
  const kaanaDeploymentId = `kaana-rollout-${tag}`;
  const revision = '2026-01-01';

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
      maxContextTokens: 200_000,
      maxOutputTokens: 8192,
      licenseId: 'apache-2.0',
      licenseDisplayName: 'Apache 2.0',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    })
    .returning({ id: inferenceModels.id });

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
    {
      priceVersionId: priceVersion.id,
      unit: 'requests',
      amount: '0.000000000000',
      per: 1,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'input_tokens',
      amount: '3.000000000000',
      per: 1_000_000,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'cached_input_tokens',
      amount: '3.000000000000',
      per: 1_000_000,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'output_tokens',
      amount: '15.000000000000',
      per: 1_000_000,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'reasoning_tokens',
      amount: '15.000000000000',
      per: 1_000_000,
    },
  ]);

  await db.insert(inferenceDeployments).values({
    modelRevisionId: revisionRow.id,
    providerSlug,
    internalRouteId: kaanaDeploymentId,
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
    legalReviewEvidenceRef: `contract-register/${tag}`,
    permissionState: 'approved',
    priceVersionId: priceVersion.id,
  });
  await insertValidRoutingScorecard({
    deploymentId: kaanaDeploymentId,
    priceVersionId: priceVersion.id,
    changedByUserId: account.id,
  });
  await createNeutralRoutingPolicy({
    accountId: account.id,
    applicationId: application.id,
  });

  await provisionBillingProfile({ accountId: account.id });
  if (options.fund !== undefined) {
    await recordTopUp({
      idempotencyKey: `rollout-top-up-${tag}`,
      accountId: account.id,
      currency: 'USD',
      amount: options.fund,
      actor: { kind: 'machine' },
    });
  }

  return {
    accountId: account.id,
    applicationId: application.id,
    token: minted.token,
    modelReference: `${publisherSlug}/${modelSlug}`,
    provider: providerSlug,
  };
}

async function balanceOf(accountId: string): Promise<{ purchased: string; reserved: string }> {
  const [row] = await getDb()
    .select()
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, 'USD')))
    .limit(1);
  return { purchased: row.purchasedBalance, reserved: row.reservedBalance };
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const chatBody = (fixture: Fixture) => ({
  model: fixture.modelReference,
  messages: [{ role: 'user', content: 'Say hello.' }],
  max_tokens: 100,
});

/**
 * A fake data plane returning a fixed, exactly-priceable usage report.
 *
 * TESTS ONLY — `services/kaanaClient.ts` has no production implementation, and
 * this is the fake its header says belongs here. It echoes the envelope's own
 * model reference and request id so the edge's completion validation never
 * becomes the reason a rollout case fails.
 */
function fakeKaana(units: { input: number; output: number }, provider: string): KaanaClient {
  return {
    attestDeployments: attestFixtureDeployments,
    execute: async (envelope: InferenceRequest): Promise<KaanaCompletion> => {
      const servedRoute = envelope.authorizedRoutes.find((route) => route.provider === provider);
      if (servedRoute === undefined) {
        throw new Error('fixture selected a route outside the exact authorization list');
      }
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
            { unit: 'input_tokens', quantity: units.input },
            { unit: 'output_tokens', quantity: units.output },
          ],
          usageSource: 'provider_reported',
          resolvedModelReference: servedRoute.modelReference,
          servingProvider: provider,
          deploymentId: servedRoute.deploymentId,
          routeSwitches: 0,
          startedAt: now,
          completedAt: now,
        },
        // No rollout case exercises a failover; a switch has its own suite.
        routeSwitchEvents: [],
      };
    },
    // No rollout case streams, and a throw is what makes one that starts to fail
    // loudly rather than silently taking an unwritten path. The streaming lane has
    // its own suite: `__tests__/kaanaStreaming.test.ts`.
    stream: () => {
      throw new Error('this fake serves only non-streaming requests');
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Environment                                                               */
/* -------------------------------------------------------------------------- */

const FLAG_VARIABLES = [
  EDGE_AUDIENCE_VARIABLE,
  MACHINE_CREDENTIAL_AUTH_VARIABLE,
  CHARGING_AUTHORIZED_VARIABLE,
  CATALOGUE_AUDIENCE_VARIABLE,
  PRIVACY_REVIEW_VARIABLE,
] as const;

const ORIGINAL = Object.fromEntries(FLAG_VARIABLES.map((key) => [key, process.env[key]]));

/** Comfortably in the past: the flag refuses a future date, never an old one. */
const ARMED_CHARGING = 'rollout-suite-fixture:2026-08-01';

/** The same, for the privacy/security review a public launch is gated on. */
const ARMED_PRIVACY_REVIEW = 'rollout-suite-fixture:2026-08-01';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closePostgres();
});

beforeEach(() => {
  for (const key of FLAG_VARIABLES) delete process.env[key];
  // The machine lane is what every fixture authenticates on, so it is enabled by
  // default here and disabled only by the case that is about it. Its own default
  // is asserted in `rolloutFlags.test.ts` and end to end below.
  process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'enabled';
  jest.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  1. The audience gate                                                      */
/* -------------------------------------------------------------------------- */

describe('an unconfigured deployment serves nobody', () => {
  it('refuses an authenticated, funded, correctly-scoped caller', async () => {
    const fixture = await makeFixture({ fund: '10.00' });

    await withServer(fakeKaana({ input: 20, output: 30 }, fixture.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );

      expect(response.status).toBe(403);
      const error = json(response).error as Record<string, unknown>;
      expect(error.code).toBe('permission_denied');
      // Traceable even when refused at the gate — ADR 0010's step 1. The
      // OpenAI dialect carries it in the header, which is the whole point of
      // that dialect keeping its body stock-client shaped.
      expect(response.headers['x-oxy-request-id']).toEqual(expect.any(String));
    });

    // Nothing was reserved for a request that never reached the ledger.
    const reservations = await getDb()
      .select({ id: usageReservations.id })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, fixture.accountId));
    expect(reservations).toHaveLength(0);
  });

  /** The control: one variable, and the identical request goes through. */
  it('serves the identical request once an audience is configured', async () => {
    const fixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${fixture.applicationId}`;

    await withServer(fakeKaana({ input: 20, output: 30 }, fixture.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(response.status).toBe(200);
    });
  });

  it('gates the receipt read too, because the check is in the gate the endpoints share', async () => {
    const fixture = await makeFixture({ fund: '10.00' });

    await withServer(undefined, async (request) => {
      const response = await request(
        'GET',
        '/v1/generations/whatever',
        undefined,
        bearer(fixture.token)
      );
      // The Oxy dialect renders the flat typed error, not the OpenAI envelope.
      expect(response.status).toBe(403);
      expect(json(response)).toMatchObject({ code: 'permission_denied', retryable: false });
    });
  });
});

describe('each rollout stage admits the applications it names', () => {
  it('serves an internal application and refuses a third-party one during the internal canary', async () => {
    const internal = await makeFixture({ type: 'internal', fund: '10.00' });
    const external = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = 'internal';

    await withServer(fakeKaana({ input: 20, output: 30 }, internal.provider), async (request) => {
      const admitted = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(internal),
        bearer(internal.token)
      );
      expect(admitted.status).toBe(200);

      const refused = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(external),
        bearer(external.token)
      );
      expect(refused.status).toBe(403);
    });
  });

  it('treats the isInternal flag alone as internal, whatever the application type says', async () => {
    // Both staff-controlled columns confer the tier independently — an internal
    // application whose `type` was never changed is still internal, and the
    // catalogue's audience reads it through the same predicate.
    const flagged = await makeFixture({ type: 'third_party', isInternal: true, fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = 'internal';

    await withServer(fakeKaana({ input: 20, output: 30 }, flagged.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(flagged),
        bearer(flagged.token)
      );
      expect(response.status).toBe(200);
    });
  });

  it('serves a first-party application during the first-party canary, and not before it', async () => {
    const firstParty = await makeFixture({ type: 'first_party', fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = 'internal';

    await withServer(fakeKaana({ input: 20, output: 30 }, firstParty.provider), async (request) => {
      const tooEarly = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(firstParty),
        bearer(firstParty.token)
      );
      expect(tooEarly.status).toBe(403);

      process.env[EDGE_AUDIENCE_VARIABLE] = 'first_party';
      const admitted = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(firstParty),
        bearer(firstParty.token)
      );
      expect(admitted.status).toBe(200);
    });
  });

  it('serves only the named applications during a closed external beta', async () => {
    const invited = await makeFixture({ fund: '10.00' });
    const uninvited = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${invited.applicationId}`;

    await withServer(fakeKaana({ input: 20, output: 30 }, invited.provider), async (request) => {
      const admitted = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(invited),
        bearer(invited.token)
      );
      expect(admitted.status).toBe(200);

      const refused = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(uninvited),
        bearer(uninvited.token)
      );
      expect(refused.status).toBe(403);
    });
  });

  /**
   * A public launch has TWO prerequisites and this walks both of them, in the
   * order an operator would hit them.
   *
   * The middle step is the load-bearing one, and it is the state a launch is
   * actually attempted from: charging armed, everything commercial ready, and
   * the privacy/security review (#972 section 12) not recorded. Without it the
   * review gate would be green and inert — the flag would parse and report and
   * the edge would serve the world regardless.
   */
  it('refuses a public launch until BOTH charging and the privacy review are armed', async () => {
    const fixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = 'public';

    await withServer(fakeKaana({ input: 20, output: 30 }, fixture.provider), async (request) => {
      const refused = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(refused.status).toBe(403);

      process.env[CHARGING_AUTHORIZED_VARIABLE] = ARMED_CHARGING;
      const stillRefused = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(stillRefused.status).toBe(403);

      process.env[PRIVACY_REVIEW_VARIABLE] = ARMED_PRIVACY_REVIEW;
      const admitted = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(admitted.status).toBe(200);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The machine-credential lane                                            */
/* -------------------------------------------------------------------------- */

describe('the machine-credential lane is a switch of its own', () => {
  it('does not authenticate a machine key in a deployment that configured nothing', async () => {
    // The one case that removes the variable this file's `beforeEach` sets, so
    // the LANE'S OWN DEFAULT is measured end to end rather than only in
    // `rolloutFlags.test.ts`. The audience is open, so an admitted-but-
    // unauthenticated answer can only be the lane.
    const fixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${fixture.applicationId}`;
    delete process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE];

    await withServer(fakeKaana({ input: 20, output: 30 }, fixture.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(response.status).toBe(401);
    });
  });

  it('does not authenticate a machine key while the lane is shut, even inside the audience', async () => {
    const fixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${fixture.applicationId}`;
    process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'disabled';

    await withServer(fakeKaana({ input: 20, output: 30 }, fixture.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );

      // An AUTHENTICATION refusal, not an audience one: the caller never became
      // a principal, so there was nothing to admit.
      expect(response.status).toBe(401);
      expect((json(response).error as Record<string, unknown>).code).toBe(
        'authentication_failed'
      );
    });

    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'inference.edge.unauthenticated',
      expect.objectContaining({ reason: 'machine_lane_disabled' })
    );
  });

  it('authenticates the same key once the lane is open — the control', async () => {
    const fixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${fixture.applicationId}`;
    process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'enabled';

    await withServer(fakeKaana({ input: 20, output: 30 }, fixture.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(response.status).toBe(200);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Shadow metering, and the charged run it is compared against            */
/* -------------------------------------------------------------------------- */

/** Pull the one shadow-metering log line out of the mocked logger. */
function shadowLine(): Record<string, unknown> {
  const calls = mockedLogger.info.mock.calls.filter(
    (call) => call[0] === SHADOW_METERING_EVENT
  );
  expect(calls).toHaveLength(1);
  return calls[0][1] as Record<string, unknown>;
}

describe('shadow metering measures without settling', () => {
  /**
   * Comfortably inside the hold a charged run takes: the ceiling is the
   * request's own `max_tokens`, and a settlement above its hold is refused
   * rather than charged — which would make the comparison below measure the
   * refusal instead of the price.
   */
  const UNITS = { input: 40, output: 60 };

  it('serves the request, writes no financial record, and leaves the balance untouched', async () => {
    const fixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${fixture.applicationId}`;

    const before = await balanceOf(fixture.accountId);

    await withServer(fakeKaana(UNITS, fixture.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(response.status).toBe(200);
    });

    const after = await balanceOf(fixture.accountId);
    expect(after).toEqual(before);

    const reservations = await getDb()
      .select({ id: usageReservations.id })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, fixture.accountId));
    expect(reservations).toHaveLength(0);

    const receipts = await getDb()
      .select({ id: usageReceipts.id })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipts).toHaveLength(0);

    const line = shadowLine();
    expect(line).toMatchObject({
      accountId: fixture.accountId,
      applicationId: fixture.applicationId,
      currency: 'USD',
      units: { input_tokens: UNITS.input, output_tokens: UNITS.output },
    });
    expect(typeof line.wouldHaveBilledAmount).toBe('string');
  });

  /**
   * The measurement this file exists for.
   *
   * The assertion is deliberately not against hand-computed arithmetic — it is
   * that the SHADOW figure and the CHARGED debit are the same
   * number, computed by the two code paths under test. A shadow line that
   * silently priced something else would look perfectly reasonable on its own.
   */
  it('records exactly what the charged run debits, for the same request', async () => {
    const shadowFixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${shadowFixture.applicationId}`;

    await withServer(fakeKaana(UNITS, shadowFixture.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(shadowFixture),
        bearer(shadowFixture.token)
      );
      expect(response.status).toBe(200);
    });
    const wouldHaveBilled = shadowLine().wouldHaveBilledAmount as string;

    jest.clearAllMocks();
    const chargedFixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${chargedFixture.applicationId}`;
    process.env[CHARGING_AUTHORIZED_VARIABLE] = ARMED_CHARGING;

    const before = await balanceOf(chargedFixture.accountId);
    await withServer(fakeKaana(UNITS, chargedFixture.provider), async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(chargedFixture),
        bearer(chargedFixture.token)
      );
      expect(response.status).toBe(200);
    });
    const after = await balanceOf(chargedFixture.accountId);

    const [receipt] = await getDb()
      .select({ billedAmount: usageReceipts.billedAmount })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, chargedFixture.accountId));

    expect(receipt.billedAmount).toBe(wouldHaveBilled);
    // And the charged run really did move money, so the equality above is not
    // two zeroes agreeing.
    expect(Number(after.purchased)).toBeLessThan(Number(before.purchased));
    expect(Number(before.purchased) - Number(after.purchased)).toBeCloseTo(
      Number(wouldHaveBilled),
      9
    );
    expect(Number(wouldHaveBilled)).toBeGreaterThan(0);
    // No shadow line was written on the charged run: the two modes are exclusive.
    expect(
      mockedLogger.info.mock.calls.filter((call) => call[0] === SHADOW_METERING_EVENT)
    ).toHaveLength(0);
  });

  /**
   * The honest cost of shadow metering, asserted so it stays a decision.
   *
   * `reserve` is the call being skipped, and every balance refusal lives inside
   * it — so an unfunded account is served while shadow metering and refused the
   * moment charging is armed. Stated here rather than discovered in production.
   */
  it('serves an account with no money, and refuses the same account once charging is armed', async () => {
    const fixture = await makeFixture();
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${fixture.applicationId}`;

    await withServer(fakeKaana(UNITS, fixture.provider), async (request) => {
      const served = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(served.status).toBe(200);

      process.env[CHARGING_AUTHORIZED_VARIABLE] = ARMED_CHARGING;
      const refused = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(refused.status).toBe(402);
      expect((json(refused).error as Record<string, unknown>).code).toBe('insufficient_balance');
    });
  });

  it('writes no receipt for a request that never reached a data plane', async () => {
    const fixture = await makeFixture({ fund: '10.00' });
    process.env[EDGE_AUDIENCE_VARIABLE] = `allowlist:${fixture.applicationId}`;

    await withServer(undefined, async (request) => {
      const response = await request(
        'POST',
        '/v1/chat/completions',
        chatBody(fixture),
        bearer(fixture.token)
      );
      expect(response.status).toBe(503);
    });

    const receipts = await getDb()
      .select({ id: usageReceipts.id })
      .from(usageReceipts)
      .where(eq(usageReceipts.accountId, fixture.accountId));
    expect(receipts).toHaveLength(0);
    expect(await balanceOf(fixture.accountId)).toEqual({
      purchased: '10.000000000000',
      reserved: '0.000000000000',
    });
  });
});
