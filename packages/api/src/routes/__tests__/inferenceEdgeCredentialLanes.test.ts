/**
 * The inference edge's two CREDENTIAL lanes, against a REAL Postgres, a REAL
 * credential registry and the REAL ledger (issue #972 workstream 16, integration
 * checkboxes "Alia service token with delegated user" and "Credential rotation
 * during traffic").
 *
 * `routes/__tests__/inferenceEdge.test.ts` covers the served path, and every one
 * of its cases authenticates on the MACHINE lane with `fixture.token`. Two things
 * it therefore cannot say anything about, and this file exists for:
 *
 *  1. **The service-token lane at the edge.** It re-reads the credential ROW
 *     rather than trusting the JWT's claims (ADR 0007), which is what makes a
 *     revocation effective inside the token's own hour of life — and nothing
 *     asserted it. The delegated-user half IS covered on the machine lane; what
 *     is not is that the delegated user is not the BILLING principal on THIS
 *     lane, which is the invariant the checkbox actually states.
 *  2. **Rotation while traffic is flowing.** `machineCredentials.test.ts` covers
 *     the rotation route's own semantics (grace configured vs not, the audit
 *     rows). What nothing covered is whether `POST /v1/responses` keeps serving
 *     the previous token inside its grace window, and whether each receipt names
 *     the credential that actually authenticated it.
 *
 * ## What makes each claim falsifiable
 *
 * **The billing principal.** Asserting `envelope.attribution.userId ===
 * <delegated>` would pass on an edge that also BILLED that user. So the delegated
 * id here is a second REAL, FUNDED account: the owner's balance must fall by the
 * exact charge and the delegated account's must not move at all. An edge that
 * resolved the payer from `X-Oxy-User-Id` debits the wrong one of the two, and
 * only a two-account fixture can see it.
 *
 * **The grace window.** "Both tokens serve" is also what a route that
 * authenticates anything reports. The control is the NO-GRACE variant of the same
 * rotation: the previous token gets 401 and the request never reaches the fake
 * kaana, so a 200 in the grace case is evidence about `isCredentialUsable`
 * reading the deadline rather than about the edge being permissive.
 *
 * Rotation runs through the SHIPPED `/applications/:id/credentials/:id/rotate`
 * route, mounted as production mounts it. Writing `expires_at = now + grace` by
 * hand would make this file assert its own arithmetic instead of the route's — and
 * the translation from `graceSeconds` to a deadline is exactly the part the edge
 * depends on and does not own.
 *
 * Every fixture is created per test with a random suffix and every read is scoped
 * to it, so a sibling suite seeding the shared database cannot change an answer
 * here.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/*
 * `jest.setup.cjs` stubs `jsonwebtoken` globally — `verify` returns a fixed
 * session payload whatever it is handed. This file's whole subject on the service
 * lane is what `verifyServiceToken` makes of REAL claims, so the real
 * implementation is required, exactly as `inferenceCatalogueRoute.test.ts` and
 * `inferenceProviderConnections.test.ts` do. Under the stub every service token
 * here resolves as `not_service` and every case reads 401 — a red that looks like
 * a broken lane and is a mocked dependency.
 */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

import type { AccountRole } from '../../utils/accountRoles';
import { permissionsForAccountRole } from '../../utils/accountRoles';

/*
 * Two seams are mocked, BOTH of them only for the `/applications` half.
 *
 *  - `account.service` grants the rotating caller an effective account role;
 *  - `middleware/auth` supplies that caller's identity.
 *
 * Neither is on the inference edge's path: `routes/inferenceEdge.ts` imports
 * neither, and `authenticateEdgeCaller` resolves its principal through
 * `resolveMachineCredential` / `verifyServiceToken` plus the credential row. So
 * nothing the edge does below is affected by either mock — which is what lets one
 * file hold the real rotation route and the real edge at once.
 */
const accessGrants = new Map<string, AccountRole>();

jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: {
    resolveEffectiveAccess: jest.fn(async (userId: string, accountId: string) => {
      const role = userId === accountId ? 'owner' : accessGrants.get(`${userId}:${accountId}`);
      if (!role) return null;
      return {
        role,
        permissions: permissionsForAccountRole(role),
        source: userId === accountId ? 'self' : 'direct',
        membership: null,
      };
    }),
    listAccessibleAccounts: jest.fn(async (userId: string) => [
      { accountId: userId, relationship: 'self', callerMembership: null },
    ]),
  },
}));

let sessionUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string; isStaff: boolean } },
    _res: unknown,
    next: () => void
  ) => {
    if (sessionUserId.length > 0) {
      req.user = { _id: sessionUserId, id: sessionUserId, isStaff: false };
    }
    next();
  },
}));

jest.mock('../../config/dynamicOriginRegistry', () => ({
  __esModule: true,
  refreshOriginRegistry: jest.fn(async () => {}),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq } from 'drizzle-orm';
import type { InferenceRequest } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountBalances } from '../../db/schema/accountBalances';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
} from '../../db/schema';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { usageReceipts } from '../../db/schema/usageReceipts';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { provisionBillingProfile, recordTopUp } from '../../services/inferenceLedger.service';
import type { KaanaClient, KaanaCompletion } from '../../services/kaanaClient';
import { resetFailureAuditCooldown } from '../../services/applicationCredentialAudit.service';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import { resolveServiceTokenPrincipal } from '../../services/attribution.service';
import { workloadAttestationHandle } from '../../services/workloadAttestation.service';
import { ensureWorkloadAttributionIdentity } from '../../services/workloadAttributionIdentity.service';
import { inferenceUsageDailyRollups } from '../../db/schema/inferenceUsageDailyRollups';
import { usageReservations } from '../../db/schema/usageReservations';
import type { ServiceTokenPayload } from '../../middleware/serviceToken';
import applicationsRouter from '../applications';
import { createInferenceEdgeRouter } from '../inferenceEdge';
import {
  attestFixtureDeployments,
  createNeutralRoutingPolicy,
  insertValidRoutingScorecard,
} from '../__fixtures__/kaanaRuntimeFixtures';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';

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

/**
 * The rollout flags this file runs with, and why.
 *
 * All four default to the state that serves and charges nobody, so every
 * assertion here about authentication and settlement would otherwise pass for the
 * wrong reason — a refusal at the audience gate is indistinguishable from a
 * refusal at the credential once you are reading only the status code, and both
 * are the 403/401 pair this file is about. Mirrors `inferenceEdge.test.ts`'s set;
 * the DEFAULTS are asserted in `config/__tests__/rolloutFlags.test.ts` and their
 * effect on this edge in `inferenceEdgeRollout.test.ts`. Nothing in this file is
 * evidence about them.
 *
 * `INFERENCE_PRIVACY_REVIEW` is the newest of the four and is the second
 * precondition a `public` audience re-checks: without it `admitToInferenceEdge`
 * resolves closed with `public_requires_privacy_review` and every case here reads
 * `403 permission_denied` before a credential is ever consulted.
 */
const ROLLOUT_ENVIRONMENT = {
  ACCESS_TOKEN_SECRET: 'inference-edge-credential-lanes-test-secret-at-least-32-chars',
  INFERENCE_EDGE_AUDIENCE: 'public',
  INFERENCE_MACHINE_CREDENTIAL_AUTH: 'enabled',
  INFERENCE_CHARGING_AUTHORIZED: 'lanes-suite-fixture:2026-08-01',
  INFERENCE_PRIVACY_REVIEW: 'lanes-suite-fixture:2026-08-01',
} as const;

const ORIGINAL_ROLLOUT_ENVIRONMENT = Object.fromEntries(
  Object.keys(ROLLOUT_ENVIRONMENT).map((key) => [key, process.env[key]])
);

let server: http.Server;
/** Swapped per test, so each case can give the edge its own (or no) data plane. */
let currentKaana: KaanaClient | undefined;

beforeAll(async () => {
  Object.assign(process.env, ROLLOUT_ENVIRONMENT);
  await connectPostgres();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // The shipped rotation route, mounted as production mounts it.
  app.use('/applications', applicationsRouter);
  // The edge, reading whichever data plane the current test installed. The
  // indirection exists because one server has to serve both routers, and
  // `createInferenceEdgeRouter` takes its kaana once at construction.
  app.use(
    '/v1',
    createInferenceEdgeRouter({
      kaanaClient: {
        attestDeployments: (deploymentIds, options) => {
          if (currentKaana === undefined) {
            throw new Error('no data plane was installed for this test');
          }
          return currentKaana.attestDeployments(deploymentIds, options);
        },
        execute: (envelope, options) => {
          if (currentKaana === undefined) {
            throw new Error('no data plane was installed for this test');
          }
          return currentKaana.execute(envelope, options);
        },
      },
    })
  );
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ROLLOUT_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  accessGrants.clear();
  currentKaana = undefined;
  sessionUserId = '';
  // The credential lane's failure-audit cooldown is process-global, so a 401 in
  // one case would otherwise suppress the audit row a later one depends on.
  resetFailureAuditCooldown();
});

function request(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<RawResponse> {
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
          ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
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
}

const bearer = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

interface Fixture {
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly token: string;
  readonly modelReference: string;
  readonly provider: string;
}

const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

/**
 * One account, one application, one active machine credential, one priced and
 * approved route, and a funded balance.
 *
 * The same shape `inferenceEdge.test.ts` builds — deliberately, so a difference in
 * behaviour between the two files is about the lane and not about the catalogue.
 */
async function makeFixture(
  options: { fund?: string; appScopes?: string[]; credentialScopes?: string[] } = {}
): Promise<Fixture> {
  const db = getDb();
  const tag = suffix();

  const [account] = await db
    .insert(users)
    .values({ username: `lane-${tag}`, email: `lane-${tag}@example.test` })
    .returning({ id: users.id });

  const appScopes = options.appScopes ?? ['inference:invoke', 'inference:usage:read'];
  const credentialScopes = options.credentialScopes ?? appScopes;

  const [application] = await db
    .insert(applications)
    .values({
      name: `Lane ${tag}`,
      ownerAccountId: account.id,
      createdByUserId: account.id,
      scopes: appScopes,
    })
    .returning({ id: applications.id });

  const minted = generateMachineCredentialToken();
  const [credential] = await db
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: `key-${tag}`,
      publicKey: `oxy_dk_${tag}`,
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      type: 'machine',
      environment: 'development',
      scopes: credentialScopes,
      status: 'active',
      createdByUserId: account.id,
    })
    .returning({ id: applicationCredentials.id });

  const publisherSlug = `pub${tag}`;
  const modelSlug = `model-${tag}`;
  const providerSlug = `prov${tag}`;
  const kaanaDeploymentId = `kaana-lane-${tag}`;
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
    { priceVersionId: priceVersion.id, unit: 'requests', amount: '0.000000000000', per: 1 },
    { priceVersionId: priceVersion.id, unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 },
    { priceVersionId: priceVersion.id, unit: 'cached_input_tokens', amount: '3.000000000000', per: 1_000_000 },
    { priceVersionId: priceVersion.id, unit: 'output_tokens', amount: '15.000000000000', per: 1_000_000 },
    { priceVersionId: priceVersion.id, unit: 'reasoning_tokens', amount: '15.000000000000', per: 1_000_000 },
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
      idempotencyKey: `lane-top-up-${tag}`,
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
    modelReference: `${publisherSlug}/${modelSlug}`,
    provider: providerSlug,
  };
}

/** A second real, FUNDED account — the delegated end user, not the payer. */
async function makeDelegatedAccount(): Promise<string> {
  const tag = suffix();
  const [account] = await getDb()
    .insert(users)
    .values({ username: `deleg-${tag}`, email: `deleg-${tag}@example.test` })
    .returning({ id: users.id });
  await provisionBillingProfile({ accountId: account.id });
  await recordTopUp({
    idempotencyKey: `deleg-top-up-${tag}`,
    accountId: account.id,
    currency: 'USD',
    amount: '10.000000000000',
    actor: { kind: 'machine' },
  });
  return account.id;
}

async function balanceOf(accountId: string): Promise<{ purchased: string; reserved: string }> {
  const [row] = await getDb()
    .select()
    .from(accountBalances)
    .where(and(eq(accountBalances.accountId, accountId), eq(accountBalances.currency, 'USD')))
    .limit(1);
  return { purchased: row.purchasedBalance, reserved: row.reservedBalance };
}

/**
 * A service JWT, minted the way `POST /auth/service-token` mints one.
 *
 * `credentialId` names a REAL credential row, because the edge's service lane
 * re-reads that row rather than trusting these claims — which is the whole point
 * of the lane and what the revocation case below exercises.
 *
 * On the ATTESTED path it names a `wl_…` attestation handle instead, which is
 * what `exchangeWorkloadAttestation` puts in this claim when there is no
 * credential at all (ADR 0026). The claims are otherwise identical, because it
 * is the same mint and the same token — see `bindWorkload`.
 */
function signServiceToken(input: {
  applicationId: string;
  ownerAccountId: string;
  credentialId: string;
  scopes?: string[];
}): string {
  return signServiceTokenEd25519({
      type: 'service',
      appId: input.applicationId,
      appName: 'Alia',
      credentialId: input.credentialId,
      ownerAccountId: input.ownerAccountId,
      environment: 'development',
      scopes: input.scopes ?? ['inference:invoke'],
      iss: 'oxy-auth',
      aud: 'oxy-api',
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    });
}

/** A fake data plane. TESTS ONLY — `services/kaanaClient.ts` has no production one. */
function fakeKaana(
  build: (envelope: InferenceRequest) => KaanaCompletion,
  seen?: InferenceRequest[]
): KaanaClient {
  return {
    attestDeployments: attestFixtureDeployments,
    execute: async (envelope) => {
      seen?.push(envelope);
      return build(envelope);
    },
  };
}

function completionFor(
  envelope: InferenceRequest,
  units: { input: number; output: number; provider: string }
): KaanaCompletion {
  const servedRoute = envelope.authorizedRoutes.find((route) => route.provider === units.provider);
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
      servingProvider: units.provider,
      deploymentId: servedRoute.deploymentId,
      routeSwitches: 0,
      startedAt: now,
      completedAt: now,
    },
  };
}

/** One well-formed Oxy-native request against a fixture's model. */
const responsesBody = (fixture: Fixture) => ({
  model: fixture.modelReference,
  input: 'Say hello.',
  maxOutputTokens: 3000,
});

/** Every receipt for one account, newest first. */
async function receiptsFor(accountId: string) {
  return getDb()
    .select()
    .from(usageReceipts)
    .where(eq(usageReceipts.accountId, accountId))
    .orderBy(usageReceipts.settledAt);
}

/* -------------------------------------------------------------------------- */
/*  Alia service token with a delegated user                                  */
/* -------------------------------------------------------------------------- */

describe('the service-token lane, with a delegated user', () => {
  it('authenticates the token, attributes the delegated user, and bills the OWNER', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const delegatedAccountId = await makeDelegatedAccount();
    const ownerBefore = await balanceOf(fixture.accountId);
    const delegatedBefore = await balanceOf(delegatedAccountId);
    const seen: InferenceRequest[] = [];

    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 2000, provider: fixture.provider }),
      seen
    );

    const response = await request('POST', '/v1/responses', responsesBody(fixture), {
      ...bearer(
        signServiceToken({
          applicationId: fixture.applicationId,
          ownerAccountId: fixture.accountId,
          credentialId: fixture.credentialId,
        })
      ),
      // The delegated user is a REAL, FUNDED account. If the edge resolved the
      // payer from this header, the assertions below would catch it debiting the
      // wrong account rather than merely failing to record an attribution.
      'X-Oxy-User-Id': delegatedAccountId,
    });

    expect(response.status).toBe(200);
    // A JWT authenticates on NEITHER the machine lane (`token_prefix` is a column
    // no JWT is in) nor as an OAuth client id, so a 200 here is the service lane
    // and nothing else.
    expect(seen).toHaveLength(1);

    const envelope = seen[0];
    // Attribution: the delegated user is named, and named OUTSIDE the billing
    // principal.
    expect(envelope.attribution.userId).toBe(delegatedAccountId);
    expect(envelope.attribution.principal.billing.accountId).toBe(fixture.accountId);
    expect(envelope.attribution.principal.billing).not.toHaveProperty('userId');
    // The credential the JWT named, resolved from the ROW rather than echoed.
    expect(envelope.attribution.principal.applicationId).toBe(fixture.applicationId);
    expect(envelope.attribution.principal.credentialId).toBe(fixture.credentialId);

    // $3/M × 12 + $15/M × 2000 = 0.030036, exactly — out of the OWNER's balance.
    const ownerAfter = await balanceOf(fixture.accountId);
    expect(Number(ownerBefore.purchased) - Number(ownerAfter.purchased)).toBeCloseTo(0.030036, 9);
    expect(Number(ownerAfter.reserved)).toBe(0);

    // The load-bearing half: the delegated account paid nothing. Both sides are
    // asserted, because "the owner was debited" alone is satisfied by an edge
    // that debited BOTH.
    const delegatedAfter = await balanceOf(delegatedAccountId);
    expect(delegatedAfter.purchased).toBe(delegatedBefore.purchased);
    expect(Number(delegatedAfter.reserved)).toBe(0);

    const receipts = await receiptsFor(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].accountId).toBe(fixture.accountId);
    expect(receipts[0].delegatedUserId).toBe(delegatedAccountId);
    expect(receipts[0].applicationCredentialId).toBe(fixture.credentialId);

    // And no receipt was written against the delegated account at all.
    expect(await receiptsFor(delegatedAccountId)).toHaveLength(0);
  });

  it('refuses a still-valid JWT once the credential row is revoked', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const token = signServiceToken({
      applicationId: fixture.applicationId,
      ownerAccountId: fixture.accountId,
      credentialId: fixture.credentialId,
    });
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    // The control, with the SAME token: it works before the revocation. Without
    // it, the 401 below would also be what a malformed fixture produces.
    expect((await request('POST', '/v1/responses', responsesBody(fixture), bearer(token))).status).toBe(
      200
    );
    expect(seen).toHaveLength(1);

    await getDb()
      .update(applicationCredentials)
      .set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, fixture.credentialId));

    const after = await request('POST', '/v1/responses', responsesBody(fixture), bearer(token));
    expect(after.status).toBe(401);
    // The reason this lane re-reads the row: the JWT is still signature-valid and
    // unexpired, and it is refused anyway.
    expect(seen).toHaveLength(1);
  });

  it('serves the INTERSECTION of credential and application scopes, not the token claim', async () => {
    // The credential grants invoke; the application does not. `intersectScopes`
    // therefore yields nothing, whatever the JWT claims.
    const fixture = await makeFixture({
      fund: '10.000000000000',
      appScopes: ['inference:usage:read'],
      credentialScopes: ['inference:invoke'],
    });
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    const refused = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(
        signServiceToken({
          applicationId: fixture.applicationId,
          ownerAccountId: fixture.accountId,
          credentialId: fixture.credentialId,
          // The claim asks for a scope the intersection does not grant.
          scopes: ['inference:invoke'],
        })
      )
    );
    expect(refused.status).toBe(403);
    expect(json(refused)).toMatchObject({ code: 'insufficient_scope' });
    expect(seen).toHaveLength(0);

    // The control: the identical request on a fixture whose APPLICATION also
    // holds the scope is served. Without it, the 403 above would also be what a
    // lane that refuses every service token reports.
    const granted = await makeFixture({
      fund: '10.000000000000',
      appScopes: ['inference:invoke'],
      credentialScopes: ['inference:invoke'],
    });
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: granted.provider }),
      seen
    );
    const served = await request(
      'POST',
      '/v1/responses',
      responsesBody(granted),
      bearer(
        signServiceToken({
          applicationId: granted.applicationId,
          ownerAccountId: granted.accountId,
          credentialId: granted.credentialId,
        })
      )
    );
    expect(served.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  The ATTESTED service-token lane (ADR 0026)                                */
/* -------------------------------------------------------------------------- */

/**
 * Bind this fixture's application to an IAM role, the way
 * `scripts/bind-workload-identity.ts` does, and hand back what an attestation
 * of that role would present.
 *
 * Two details are what make these cases evidence rather than decoration:
 *
 *  * **The handle is DERIVED**, by the one definition the mint itself uses.
 *    A literal `wl_…` in this file would be a constant that keeps passing after
 *    the derivation moves, and the lane would go quiet in production instead of
 *    red here.
 *  * **The application is made trusted first-party**, because that is the gate
 *    `exchangeWorkloadAttestation` applies at mint. A binding on an ordinary
 *    third-party application cannot mint, so a live ceiling that admitted one
 *    would admit more than a fresh mint would — and `makeFixture` builds
 *    third-party applications.
 *
 *  * **The binding is MATERIALISED**, through the same
 *    `ensureWorkloadAttributionIdentity` that `bindWorkloadIdentity` and
 *    `exchangeWorkloadAttestation` call. That row is what the usage ledger's
 *    `application_credential_id` foreign key names, so a fixture without it would
 *    be a fixture no production token can correspond to — both writers run before
 *    a token carrying the handle can exist. `attribute: false` builds that
 *    unreachable state deliberately, for the case that proves it refuses cleanly.
 *
 * Nothing here touches the fixture's credential row. It stays live and unused,
 * which is what lets the pairing below say something.
 */
async function bindWorkload(
  fixture: Fixture,
  options: { scopes?: string[]; attribute?: boolean } = {}
): Promise<{ readonly subject: string; readonly handle: string; readonly bindingId: string }> {
  const subject = `arn:aws:iam::237343248947:role/oxy-lane-${suffix()}-task`;

  await getDb()
    .update(applications)
    .set({ type: 'first_party' })
    .where(eq(applications.id, fixture.applicationId));

  const [binding] = await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      applicationId: fixture.applicationId,
      provider: 'aws-iam',
      subject,
      description: `lane suite ${suffix()}`,
      scopes: options.scopes ?? [],
    })
    .returning({ id: applicationWorkloadIdentities.id });

  if (options.attribute !== false) {
    await ensureWorkloadAttributionIdentity({
      bindingId: binding.id,
      applicationId: fixture.applicationId,
      subject,
    });
  }

  return { subject, handle: workloadAttestationHandle(subject), bindingId: binding.id };
}

/**
 * The attested caller at the edge, end to end: it resolves, it is served, and it
 * is charged.
 *
 * ADR 0026 lets an Oxy service authenticate by attesting its ECS task role, and
 * the token it receives differs from a credential-minted one in exactly one
 * claim: `credentialId` is the binding's attestation handle. Two things blocked
 * it, in order. `authenticateEdgeCaller` resolved that claim as an
 * `application_credentials` row id unconditionally, so it found nothing and the
 * log blamed an unknown credential; that was fixed by taking the same hop the
 * catalogue takes (`resolveServiceTokenPrincipal`). What remained was the LEDGER:
 * four tables carry the authenticating identity in a `NOT NULL` column with a
 * foreign key to `application_credentials.id`, one of them in its primary key, so
 * a handle named no row and the edge refused `proof === 'workload'` outright with
 * `workload_attribution_unsupported` rather than failing that constraint half way
 * through an authenticated request.
 *
 * The handle now names a real row — the binding, materialised as a `workload` row
 * whose id IS the handle (`services/workloadAttributionIdentity.service.ts`) — so
 * the refusal is gone and these cases assert the thing it stood in the way of: a
 * reservation, a receipt and a rollup filed under `wl_…`, with the balance moved
 * and the request actually forwarded.
 *
 * The pairing with `resolveServiceTokenPrincipal` is kept where a refusal is
 * still expected, because a 401 alone is also what a broken hop produces — the
 * pair is what tells "the binding is not live" apart from "nothing resolved it".
 */
describe('the attested service-token lane', () => {
  /** The token an attestation of `subject` mints: the handle as `credentialId`. */
  function attestedToken(fixture: Fixture, handle: string, scopes?: string[]): string {
    return signServiceToken({
      applicationId: fixture.applicationId,
      ownerAccountId: fixture.accountId,
      credentialId: handle,
      ...(scopes === undefined ? {} : { scopes }),
    });
  }

  function claims(fixture: Fixture, credentialId: string): ServiceTokenPayload {
    return {
      type: 'service',
      appId: fixture.applicationId,
      appName: 'Alia',
      credentialId,
      ownerAccountId: fixture.accountId,
      environment: 'development',
      scopes: ['inference:invoke'],
    };
  }

  it('completes a reservation, a receipt and a rollup filed under the attestation handle', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const { handle } = await bindWorkload(fixture);
    const before = await balanceOf(fixture.accountId);
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    // Half one: the identity resolves, from the BINDING, with no credential
    // involved.
    await expect(
      resolveServiceTokenPrincipal(claims(fixture, handle))
    ).resolves.toMatchObject({
      status: 'resolved',
      principal: { proof: 'workload', credentialId: handle, applicationId: fixture.applicationId },
    });

    // Half two: it is SERVED. This is the assertion the whole change exists for,
    // and it went red as a 401 before the materialised row existed.
    const response = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(attestedToken(fixture, handle))
    );
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    // The handle travels as the principal's credential id all the way into the
    // data plane's attribution block, unchanged.
    expect(seen[0].attribution.principal.credentialId).toBe(handle);

    // The reservation was held against the attested identity — the exact INSERT
    // that used to fail `usage_reservations_application_credential_id_…`.
    const reservations = await getDb()
      .select({
        applicationCredentialId: usageReservations.applicationCredentialId,
        status: usageReservations.status,
      })
      .from(usageReservations)
      .where(eq(usageReservations.accountId, fixture.accountId));
    expect(reservations).toHaveLength(1);
    expect(reservations[0].applicationCredentialId).toBe(handle);
    expect(reservations[0].status).toBe('settled');

    // And the receipt, which is what a bill is built from. Not the fixture's
    // credential: that row is live and untouched, so an edge that fell back to
    // "some credential of this application" would pass everything above and fail
    // here.
    const receipts = await receiptsFor(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].applicationCredentialId).toBe(handle);
    expect(receipts[0].applicationCredentialId).not.toBe(fixture.credentialId);

    // The rollup, whose `application_credential_id` is part of its PRIMARY KEY —
    // the constraint that ruled out making the column nullable.
    const rollups = await getDb()
      .select({ requestCount: inferenceUsageDailyRollups.requestCount })
      .from(inferenceUsageDailyRollups)
      .where(eq(inferenceUsageDailyRollups.applicationCredentialId, handle));
    expect(rollups).toHaveLength(1);
    expect(rollups[0].requestCount).toBe(1);

    // Money actually moved, so "served" is not a 200 with an unbilled request.
    const after = await balanceOf(fixture.accountId);
    expect(Number(after.purchased)).toBeLessThan(Number(before.purchased));
  });

  it('refuses a live binding whose attribution row is missing, without ever reaching the data plane', async () => {
    // The state no production token can be in — both writers materialise the row
    // before a token naming the handle exists — built deliberately, because the
    // failure mode if it ever happened is the one the holding position existed to
    // avoid: a foreign-key violation half way through an authenticated request.
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const { handle } = await bindWorkload(fixture, { attribute: false });
    const before = await balanceOf(fixture.accountId);
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    // `resolveLiveAgencyWorkloadByHandle` requires the binding→row link, so this
    // is an ordinary liveness refusal rather than a 500 from the ledger.
    await expect(resolveServiceTokenPrincipal(claims(fixture, handle))).resolves.toEqual({
      status: 'unknown-workload',
    });

    const response = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(attestedToken(fixture, handle))
    );
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(await balanceOf(fixture.accountId)).toEqual(before);
    expect(await receiptsFor(fixture.accountId)).toHaveLength(0);
  });

  it('stops serving the moment the binding is deleted, and keeps the spend it already made', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const { handle, bindingId } = await bindWorkload(fixture);
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    const served = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(attestedToken(fixture, handle))
    );
    expect(served.status).toBe(200);

    // Deleting the binding is how a compromised workload is cut off, and it takes
    // effect on the very next call — the token itself is still an hour from
    // expiry.
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, bindingId));

    const after = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(attestedToken(fixture, handle))
    );
    expect(after.status).toBe(401);
    expect(seen).toHaveLength(1);

    // And the receipt it already earned is still there, still naming the identity
    // that authorised it. `SET NULL` on the binding link rather than `CASCADE` is
    // what makes that true: a cascade would have reached the usage tables.
    const receipts = await receiptsFor(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].applicationCredentialId).toBe(handle);
    const [row] = await getDb()
      .select({ workloadIdentityId: applicationCredentials.workloadIdentityId })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, handle));
    expect(row.workloadIdentityId).toBeNull();
  });

  it('answers identically for a handle nobody bound and a binding that has expired', async () => {
    // The wire must not be an oracle on a binding's lifecycle. Now that a LIVE
    // binding is legitimately served, the property is about the refusals: "no such
    // binding" and "that binding is expired" are one arm inside
    // `resolveServiceTokenPrincipal` and must be one answer on the wire too.
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const expired = await bindWorkload(fixture);
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(applicationWorkloadIdentities.id, expired.bindingId));
    const unboundHandle = workloadAttestationHandle(
      `arn:aws:iam::237343248947:role/oxy-never-bound-${suffix()}-task`
    );
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    // Both collapse to the one arm, which is what the hop promises.
    await expect(
      resolveServiceTokenPrincipal(claims(fixture, expired.handle))
    ).resolves.toEqual({ status: 'unknown-workload' });
    await expect(resolveServiceTokenPrincipal(claims(fixture, unboundHandle))).resolves.toEqual({
      status: 'unknown-workload',
    });

    const expiredResponse = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(attestedToken(fixture, expired.handle))
    );
    const unbound = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(attestedToken(fixture, unboundHandle))
    );
    expect(expiredResponse.status).toBe(401);
    expect(unbound.status).toBe(401);
    // `requestId` is per request by design; everything a caller could read a
    // binding's existence out of is identical.
    const withoutRequestId = (response: RawResponse): Record<string, unknown> => {
      const { requestId: _requestId, ...rest } = json(response);
      return rest;
    };
    expect(withoutRequestId(expiredResponse)).toEqual(withoutRequestId(unbound));
    expect(seen).toHaveLength(0);
  });

  it('leaves a CREDENTIAL-minted token on the credential path, byte for byte', async () => {
    // The regression guard for the branch itself: the same application now has
    // BOTH a live credential and a live binding, and a token naming the
    // credential must still be served, with that credential in the receipt.
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const { handle } = await bindWorkload(fixture);
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    const response = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(
        signServiceToken({
          applicationId: fixture.applicationId,
          ownerAccountId: fixture.accountId,
          credentialId: fixture.credentialId,
        })
      )
    );

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].attribution.principal.credentialId).toBe(fixture.credentialId);
    expect(seen[0].attribution.principal.credentialId).not.toBe(handle);

    const receipts = await receiptsFor(fixture.accountId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].applicationCredentialId).toBe(fixture.credentialId);

    // And revoking the CREDENTIAL still ends that token with the binding alive
    // the whole time: one identity's liveness never covers for the other's.
    await getDb()
      .update(applicationCredentials)
      .set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, fixture.credentialId));
    const after = await request(
      'POST',
      '/v1/responses',
      responsesBody(fixture),
      bearer(
        signServiceToken({
          applicationId: fixture.applicationId,
          ownerAccountId: fixture.accountId,
          credentialId: fixture.credentialId,
        })
      )
    );
    expect(after.status).toBe(401);
    expect(seen).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Credential rotation during traffic                                        */
/* -------------------------------------------------------------------------- */

describe('credential rotation during traffic', () => {
  interface Rotation {
    readonly token: string;
    readonly credentialId: string;
    readonly graceExpiresAt: string | null;
  }

  /** Rotate through the SHIPPED route, as the Console does. */
  async function rotate(fixture: Fixture, graceSeconds?: number): Promise<Rotation> {
    sessionUserId = fixture.accountId;
    const response = await request(
      'POST',
      `/applications/${fixture.applicationId}/credentials/${fixture.credentialId}/rotate`,
      graceSeconds === undefined ? {} : { graceSeconds },
      bearer('session-bearer')
    );
    if (response.status !== 200) {
      throw new Error(`rotate failed: ${response.status} ${response.body}`);
    }
    const body = json(response);
    return {
      token: body.token as string,
      credentialId: (body.credential as { _id: string })._id,
      graceExpiresAt: (body.graceExpiresAt as string | null) ?? null,
    };
  }

  it('serves BOTH tokens inside the grace window, each receipt naming its own credential', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    // Traffic is already flowing on the original token.
    const before = await request('POST', '/v1/responses', responsesBody(fixture), bearer(fixture.token));
    expect(before.status).toBe(200);

    // A window long enough that the assertions are not racing the clock. The
    // route's own boundary behaviour — the token stopping at the deadline — is
    // `machineCredentials.test.ts`'s, on the real clock.
    const rotated = await rotate(fixture, 600);
    expect(typeof rotated.graceExpiresAt).toBe('string');
    expect(rotated.credentialId).not.toBe(fixture.credentialId);
    expect(rotated.token).not.toBe(fixture.token);

    // Inside the window: the PREVIOUS token still serves. This is "during
    // traffic" — an in-flight integration does not have to redeploy the instant
    // somebody presses rotate.
    const onOld = await request('POST', '/v1/responses', responsesBody(fixture), bearer(fixture.token));
    expect(onOld.status).toBe(200);

    // And so does the replacement.
    const onNew = await request('POST', '/v1/responses', responsesBody(fixture), bearer(rotated.token));
    expect(onNew.status).toBe(200);

    expect(seen).toHaveLength(3);

    // Each receipt names the credential that ACTUALLY authenticated it — not the
    // active one, and not the one the application happens to have most recently
    // minted. Without this, "both tokens serve" would be satisfied by an edge
    // that attributed every request to the replacement.
    const receipts = await receiptsFor(fixture.accountId);
    expect(receipts).toHaveLength(3);
    expect(receipts.map((receipt) => receipt.applicationCredentialId)).toEqual([
      fixture.credentialId,
      fixture.credentialId,
      rotated.credentialId,
    ]);
    // Both ids really are distinct values in that list — a fixture where they
    // collided would make the assertion above vacuous.
    expect(new Set(receipts.map((receipt) => receipt.applicationCredentialId)).size).toBe(2);
  });

  it('CONTROL: with no grace configured the previous token is refused and never reaches the data plane', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    const seen: InferenceRequest[] = [];
    currentKaana = fakeKaana(
      (envelope) => completionFor(envelope, { input: 12, output: 20, provider: fixture.provider }),
      seen
    );

    expect(
      (await request('POST', '/v1/responses', responsesBody(fixture), bearer(fixture.token))).status
    ).toBe(200);
    expect(seen).toHaveLength(1);

    const rotated = await rotate(fixture);
    // `graceSeconds` omitted means no window at all: the previous credential is
    // `revoked` outright rather than `deprecated` with a deadline.
    expect(rotated.graceExpiresAt).toBeNull();
    resetFailureAuditCooldown();

    const onOld = await request('POST', '/v1/responses', responsesBody(fixture), bearer(fixture.token));
    expect(onOld.status).toBe(401);
    // The half that makes this a control rather than a status-code check: the
    // refused request never reached the fake kaana, so "the grace window works"
    // in the case above cannot be satisfied by a route that accepts anything.
    expect(seen).toHaveLength(1);

    // And the replacement serves, so the 401 is about the retired token and not
    // about a rotation that broke the application.
    const onNew = await request('POST', '/v1/responses', responsesBody(fixture), bearer(rotated.token));
    expect(onNew.status).toBe(200);
    expect(seen).toHaveLength(2);

    const receipts = await receiptsFor(fixture.accountId);
    expect(receipts.map((receipt) => receipt.applicationCredentialId)).toEqual([
      fixture.credentialId,
      rotated.credentialId,
    ]);
  });

  it('settles a request under the credential that authenticated it, after that credential is retired', async () => {
    const fixture = await makeFixture({ fund: '10.000000000000' });
    let releaseKaana: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      releaseKaana = resolve;
    });

    // A data plane that holds the request open until this test lets it finish, so
    // the rotation genuinely lands MID-REQUEST rather than between two of them.
    currentKaana = {
      attestDeployments: attestFixtureDeployments,
      execute: async (envelope) => {
        await inFlight;
        return completionFor(envelope, { input: 12, output: 20, provider: fixture.provider });
      },
    };

    const pending = request('POST', '/v1/responses', responsesBody(fixture), bearer(fixture.token));
    // Rotate with no grace while the request is still upstream: the credential it
    // authenticated on is `revoked` before it settles.
    const rotated = await rotate(fixture);
    expect(rotated.graceExpiresAt).toBeNull();
    releaseKaana?.();

    const response = await pending;
    // The request that was already admitted completes and is charged. Refusing it
    // at settlement would take a customer's completed inference away from them
    // because somebody pressed rotate while it was running.
    expect(response.status).toBe(200);

    const receipts = await receiptsFor(fixture.accountId);
    expect(receipts).toHaveLength(1);
    // Attributed to the credential that authenticated it, which no longer works —
    // so credential-scoped billing survives its own credential's retirement.
    expect(receipts[0].applicationCredentialId).toBe(fixture.credentialId);
    expect((await readCredential(fixture.credentialId))?.status).toBe('revoked');
  });

  async function readCredential(id: string) {
    const [row] = await getDb()
      .select()
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, id))
      .limit(1);
    return row;
  }
});
