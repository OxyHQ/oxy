/**
 * `/models` — the catalogue's HTTP surface (issue #972, §16, workstream 11).
 *
 * The service test (`services/__tests__/inferenceCatalogue.test.ts`) proves the
 * commercial-permission GATE, by calling `listCatalogueForViewer` with a viewer
 * it constructs by hand. That leaves one thing untested and it is the half an
 * attacker touches: **where the viewer comes from**. `viewerForRequest` in this
 * router decides, per request, which audience a caller belongs to — and every
 * third-party and unresolved branches resolve to the PUBLIC viewer.
 *
 * A test that only checked "an official application sees the platform route"
 * would pass against a router that handed that audience to everybody. So each
 * case below is stated as a pair over the same fixture: the platform route is
 * present for first-party/internal/system callers and absent for third-party or
 * unresolved callers, while the public route proves the read is not empty.
 *
 * Nothing here counts rows it does not own. `GET /models` lists the whole
 * catalogue, and sibling suites seed into the same database, so every assertion
 * filters to the model ids this file created.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';

// `jest.setup.cjs` stubs `jsonwebtoken` globally. The service-token claims are
// what `viewerForRequest` reads, so the real implementation is required.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
} from '../../db/schema';
import { users } from '../../db/schema/users';
import { MACHINE_CREDENTIAL_AUTH_VARIABLE } from '../../config/rolloutFlags';
import { errorHandler } from '../../middleware/errorHandler';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import catalogueRouter from '../inferenceCatalogue';
import type { ModelCatalogueEntry } from '@oxyhq/contracts';

let server: http.Server;

const MOUNT = '/models';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

/**
 * `token: null` sends NO Authorization header at all — a distinct case from an
 * unverifiable one, and the anonymous branch of `viewerForRequest`.
 */
function request(path: string, options: { token?: string | null } = {}): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers:
          options.token === null || options.token === undefined
            ? {}
            : { authorization: `Bearer ${options.token}` },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = raw.length > 0 ? JSON.parse(raw) : {};
          } catch {
            body = {};
          }
          resolve({ status: res.statusCode ?? 0, body, raw });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/** Every fixture carries the same wholesale cost, so one literal scans for all of them. */
const WHOLESALE_AMOUNT = '0.000000900000';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

interface RouteFixture {
  readonly modelId: string;
  readonly revision: string;
  readonly providerSlug: string;
  readonly internalRouteId: string;
}

/**
 * A complete route: publisher → model → current revision → provider →
 * deployment. Every route carries an `internalRouteId` and a wholesale cost, so
 * the "the customer projection withholds them" claim has something to withhold
 * in EVERY fixture rather than in one specially-prepared row.
 */
async function insertRoute(options: {
  availabilityScope: 'public_payg' | 'platform_internal' | 'oxy_hosted';
  permissionState?: 'pending_review' | 'approved' | 'suspended';
}): Promise<RouteFixture> {
  const db = getDb();
  const publisherSlug = `cpub${suffix()}`;
  const modelSlug = `cmdl${suffix()}`;
  const revision = `cr${suffix()}`;
  const providerSlug = `cprv${suffix()}`;
  const internalRouteId = `kaana-route-${suffix()}`;

  await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: 'Cat Pub' });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: 'Catalogue Fixture Model',
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
    .returning({ id: inferenceModels.id, modelId: inferenceModels.modelId });

  const [revisionRow] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });

  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: 'Catalogue Fixture Provider',
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

  const permissionState = options.permissionState ?? 'approved';
  await db.insert(inferenceDeployments).values({
    modelRevisionId: revisionRow.id,
    providerSlug,
    regions: ['us-west-2'],
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    availabilityScope: options.availabilityScope,
    commercialPermission:
      options.availabilityScope === 'platform_internal'
        ? 'standard_application_use'
        : 'public_resale_approved',
    status: 'active',
    // The database refuses an approval whose legal review is not approved, so
    // an APPROVED fixture carries one rather than working around the constraint.
    ...(permissionState === 'approved'
      ? {
          legalReviewStatus: 'approved' as const,
          legalReviewedAt: new Date(),
          legalReviewEvidenceRef: `contract-register/${suffix()}`,
        }
      : {}),
    permissionState,
    internalRouteId,
    upstreamWholesaleCostAmount: WHOLESALE_AMOUNT,
    upstreamWholesaleCostCurrency: 'USD',
    upstreamWholesaleCostUnit: 'input_tokens',
    upstreamWholesaleCostPer: 1_000_000,
  });

  if (model.modelId === null) throw new Error('the generated model id did not compose');
  return { modelId: model.modelId, revision, providerSlug, internalRouteId };
}

/** An application of the given type, plus a service token that names it. */
async function tokenForApplication(input: {
  type: 'internal' | 'system' | 'first_party' | 'third_party';
  isInternal?: boolean;
}): Promise<string> {
  const [account] = await getDb()
    .insert(users)
    .values({ username: `cat-${suffix()}`, kind: 'organization' })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Catalogue ${suffix()}`,
      ownerAccountId: account.id,
      createdByUserId: account.id,
      type: input.type,
      isInternal: input.isInternal ?? false,
    })
    .returning({ id: applications.id });

  return signServiceToken({ appId: application.id, ownerAccountId: account.id });
}

/**
 * An application of the given type, plus a REAL `oxy_sk_…` machine credential
 * for it — the bearer a stock OpenAI SDK sends to `client.models.list()`.
 *
 * Minted through `generateMachineCredentialToken` and stored as the lane reads
 * it (`token_prefix` for the lookup, SHA-256 of the WHOLE token in `token_hash`),
 * so what is asserted below is `resolveMachineCredential` resolving a row rather
 * than this file's idea of one. `environment: 'development'` is what
 * `deploymentCredentialEnvironment()` answers under `NODE_ENV=test`; a
 * `production` credential would be refused for the environment and every case
 * here would read as a public viewer for the wrong reason.
 *
 * The scopes are `inference:models:read` and NOT `inference:invoke`, deliberately:
 * the catalogue's audience is derived from the application, never from what the
 * credential may spend.
 */
async function machineTokenForApplication(input: {
  type: 'internal' | 'system' | 'first_party' | 'third_party';
  isInternal?: boolean;
  status?: 'active' | 'revoked';
}): Promise<string> {
  const [account] = await getDb()
    .insert(users)
    .values({ username: `mcat-${suffix()}`, kind: 'organization' })
    .returning({ id: users.id });
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Catalogue Machine ${suffix()}`,
      ownerAccountId: account.id,
      createdByUserId: account.id,
      type: input.type,
      isInternal: input.isInternal ?? false,
      scopes: ['inference:models:read'],
    })
    .returning({ id: applications.id });

  const minted = generateMachineCredentialToken();
  await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: `mkey-${suffix()}`,
      publicKey: `oxy_dk_${suffix()}`,
      tokenPrefix: minted.tokenPrefix,
      tokenHash: minted.tokenHash,
      type: 'machine',
      environment: 'development',
      scopes: ['inference:models:read'],
      status: input.status ?? 'active',
    });

  return minted.token;
}

/**
 * Run one case with the machine lane in a stated position, then put the variable
 * back exactly as it was.
 *
 * The position is always written out at the call site. `INFERENCE_MACHINE_CREDENTIAL_AUTH`
 * is unset in production and its default is asserted in
 * `config/__tests__/rolloutFlags.test.ts`; nothing here is evidence about it.
 */
async function withMachineLane(
  position: 'enabled' | 'unset',
  run: () => Promise<void>
): Promise<void> {
  const original = process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE];
  if (position === 'enabled') process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = 'enabled';
  else delete process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE];
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE];
    else process.env[MACHINE_CREDENTIAL_AUTH_VARIABLE] = original;
  }
}

function signServiceToken(input: {
  appId: string;
  ownerAccountId: string;
  secret?: string;
}): string {
  return jwt.sign(
    {
      type: 'service',
      appId: input.appId,
      appName: 'Catalogue Fixture App',
      credentialId: `cred-${suffix()}`,
      ownerAccountId: input.ownerAccountId,
      environment: 'production',
      scopes: ['inference:invoke'],
    },
    input.secret ?? (process.env.ACCESS_TOKEN_SECRET as string),
    { expiresIn: '1h', issuer: 'oxy-auth', audience: 'oxy-api' }
  );
}

/** Pull one model id out of a list response, or `undefined` if it is withheld. */
function entryFor(body: Record<string, unknown>, key: 'data' | 'models', modelId: string) {
  const entries = body[key] as ModelCatalogueEntry[];
  return entries.find((entry) => entry.modelId === modelId);
}

/**
 * This file is about the AUDIENCE, so it runs with the catalogue published.
 *
 * `INFERENCE_CATALOGUE_AUDIENCE` is `internal` unless a deployment says
 * otherwise (issue #972 workstream 16), and an unpublished catalogue serves a
 * public viewer nothing — which would make every "the public viewer sees the
 * public route" assertion below pass for the wrong reason. The unset default and
 * both of its positions are covered by `rolloutFlags.test.ts` and by
 * `inferenceCataloguePublication.test.ts`, which drive this same router.
 */
const ORIGINAL_CATALOGUE_AUDIENCE = process.env.INFERENCE_CATALOGUE_AUDIENCE;

beforeAll(async () => {
  process.env.INFERENCE_CATALOGUE_AUDIENCE = 'public';
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use(MOUNT, catalogueRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  if (ORIGINAL_CATALOGUE_AUDIENCE === undefined) {
    delete process.env.INFERENCE_CATALOGUE_AUDIENCE;
  } else {
    process.env.INFERENCE_CATALOGUE_AUDIENCE = ORIGINAL_CATALOGUE_AUDIENCE;
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  1. Where the audience comes from                                          */
/* -------------------------------------------------------------------------- */

describe('the audience is resolved from the request, and every branch but one is public', () => {
  /**
   * One fixture pair, six callers. `publicRoute` is the CONTROL for all of them:
   * a caller who sees neither route proves nothing, because a broken fixture
   * looks exactly like a correct withholding.
   */
  it.each([
    ['no Authorization header at all', async () => null],
    ['a plain user session bearer', async () => 'a-user-session-token-not-a-service-jwt'],
    [
      'a service token signed with the wrong secret',
      async () =>
        signServiceToken({
          appId: 'whatever',
          ownerAccountId: 'whatever',
          secret: 'not-the-access-token-secret',
        }),
    ],
    [
      'a service token whose application row does not exist',
      async () => signServiceToken({ appId: `app-${suffix()}`, ownerAccountId: `acct-${suffix()}` }),
    ],
    [
      'an ordinary third-party application',
      async () => tokenForApplication({ type: 'third_party' }),
    ],
  ])('resolves %s to the public audience', async (_label, makeToken) => {
    const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
    const internalRoute = await insertRoute({ availabilityScope: 'platform_internal' });
    const token = await makeToken();

    const response = await request(MOUNT, { token });
    expect(response.status).toBe(200);

    // The control: this caller CAN see the catalogue, so an absent internal
    // route is a withholding and not a failed read.
    expect(entryFor(response.body, 'data', publicRoute.modelId)).toBeDefined();
    expect(entryFor(response.body, 'data', internalRoute.modelId)).toBeUndefined();
  });

  it.each([
    ['type: first_party', { type: 'first_party' as const }],
    ['type: internal', { type: 'internal' as const }],
    ['type: system', { type: 'system' as const }],
    ['isInternal on an otherwise third-party application', {
      type: 'third_party' as const,
      isInternal: true,
    }],
  ])('resolves %s to the platform audience', async (_label, application) => {
    const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
    const internalRoute = await insertRoute({ availabilityScope: 'platform_internal' });
    const token = await tokenForApplication(application);

    const response = await request(MOUNT, { token });
    expect(response.status).toBe(200);
    expect(entryFor(response.body, 'data', publicRoute.modelId)).toBeDefined();
    // The branch that widens official applications. Paired with the public
    // cases above, this is what makes
    // the withholding a decision rather than an accident.
    expect(entryFor(response.body, 'data', internalRoute.modelId)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  1b. The MACHINE credential lane resolves an audience too                  */
/* -------------------------------------------------------------------------- */

/**
 * `oxy_sk_…` on `GET /models`, which is the second call a stock OpenAI SDK makes.
 *
 * The bug this covers: `viewerForRequest` resolved the bearer through
 * `verifyServiceToken` ALONE. A machine credential is not a JWT, so it failed
 * verification and the caller silently became an anonymous PUBLIC viewer —
 * authenticated on `POST /v1/chat/completions` and unknown here, at every flag
 * setting, with no error anywhere to notice.
 *
 * **A 200 with a body proves nothing about this**, and that is the whole
 * difficulty: the public viewer is served a real catalogue, so "the request
 * worked" is exactly what the bug produced. Every case below therefore turns on a
 * row that is visible to the credential's application and NOT to an anonymous
 * caller — a `platform_internal` deployment — with the `public_payg` route as the
 * control proving the caller could read the catalogue at all.
 */
describe('a machine credential resolves the audience of the application that holds it', () => {
  it('serves the internal audience to an internal application’s oxy_sk_ bearer, and withholds it from an anonymous one', async () => {
    await withMachineLane('enabled', async () => {
      const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
      const internalRoute = await insertRoute({ availabilityScope: 'platform_internal' });
      const token = await machineTokenForApplication({ type: 'internal' });

      const response = await request(MOUNT, { token });
      expect(response.status).toBe(200);
      // The control: this caller reads the catalogue, so what follows is a
      // resolution and not a failed read.
      expect(entryFor(response.body, 'data', publicRoute.modelId)).toBeDefined();
      // The measurement. Under the bug this was `undefined`: the machine bearer
      // resolved public, and a public viewer is served no `platform_internal` route.
      expect(entryFor(response.body, 'data', internalRoute.modelId)).toBeDefined();

      // The DISCRIMINATOR the two viewers cannot share, on the detail read: the
      // same URL is 200 for this bearer and 404 for an anonymous caller. `GET
      // /models/:publisher/:model` runs the same `catalogueAccess`, so this is the
      // second endpoint of the pair rather than a restatement of the first.
      const detail = await request(`${MOUNT}/${internalRoute.modelId}`, { token });
      expect(detail.status).toBe(200);
      expect((detail.body.data as ModelCatalogueEntry).modelId).toBe(internalRoute.modelId);

      const anonymous = await request(`${MOUNT}/${internalRoute.modelId}`, { token: null });
      expect(anonymous.status).toBe(404);
    });
  });

  it('serves the PUBLIC audience to an ordinary third-party application’s oxy_sk_ bearer', async () => {
    await withMachineLane('enabled', async () => {
      const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
      const internalRoute = await insertRoute({ availabilityScope: 'platform_internal' });
      // The lane resolving a credential is not a widening. Without this case the
      // suite above would also pass against a router that handed the internal
      // audience to every machine bearer it managed to resolve.
      const token = await machineTokenForApplication({ type: 'third_party' });

      const response = await request(MOUNT, { token });
      expect(response.status).toBe(200);
      expect(entryFor(response.body, 'data', publicRoute.modelId)).toBeDefined();
      expect(entryFor(response.body, 'data', internalRoute.modelId)).toBeUndefined();
    });
  });

  it('resolves a REVOKED machine credential to the public audience', async () => {
    await withMachineLane('enabled', async () => {
      const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
      const internalRoute = await insertRoute({ availabilityScope: 'platform_internal' });
      const token = await machineTokenForApplication({ type: 'internal', status: 'revoked' });

      const response = await request(MOUNT, { token });
      expect(response.status).toBe(200);
      expect(entryFor(response.body, 'data', publicRoute.modelId)).toBeDefined();
      // The credential's application IS internal, so this is the credential's own
      // lifecycle being honoured rather than the tier failing to resolve.
      expect(entryFor(response.body, 'data', internalRoute.modelId)).toBeUndefined();
    });
  });
});

/**
 * The catalogue and the edge must agree about who the caller is in EVERY flag
 * position, so a machine credential is never MORE privileged on the catalogue
 * than it is on the request path.
 *
 * `authenticateEdgeCaller` refuses a machine-prefixed bearer outright with
 * `machine_lane_disabled` while `INFERENCE_MACHINE_CREDENTIAL_AUTH` is unset. The
 * catalogue's equivalent of a refusal is the public audience, and this is the pair
 * that proves it: the SAME internal application's SAME bearer sees the internal
 * route with the lane open and does not see it with the lane shut.
 */
describe('the machine lane’s rollout flag gates the catalogue exactly as it gates the edge', () => {
  it('withholds the internal audience from a machine bearer while the lane is shut, and grants it once open', async () => {
    const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
    const internalRoute = await insertRoute({ availabilityScope: 'platform_internal' });
    const token = await machineTokenForApplication({ type: 'internal' });

    await withMachineLane('unset', async () => {
      const shut = await request(MOUNT, { token });
      expect(shut.status).toBe(200);
      expect(entryFor(shut.body, 'data', publicRoute.modelId)).toBeDefined();
      expect(entryFor(shut.body, 'data', internalRoute.modelId)).toBeUndefined();
      expect((await request(`${MOUNT}/${internalRoute.modelId}`, { token })).status).toBe(404);
    });

    // The POSITIVE CONTROL for the assertion above, over the same fixture and the
    // same bearer: without it, a withholding and a credential that never resolved
    // at all read identically.
    await withMachineLane('enabled', async () => {
      const open = await request(MOUNT, { token });
      expect(entryFor(open.body, 'data', internalRoute.modelId)).toBeDefined();
      expect((await request(`${MOUNT}/${internalRoute.modelId}`, { token })).status).toBe(200);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The permission gate reaches the wire, with no audience exemption        */
/* -------------------------------------------------------------------------- */

describe('an unapproved route is served to nobody, internal audience included', () => {
  it.each([
    ['pending_review', 'pending_review' as const],
    ['suspended', 'suspended' as const],
  ])('withholds a %s route from BOTH audiences', async (_label, permissionState) => {
    const approved = await insertRoute({ availabilityScope: 'platform_internal' });
    const unapproved = await insertRoute({
      availabilityScope: 'platform_internal',
      permissionState,
    });

    const internalToken = await tokenForApplication({ type: 'internal' });
    const internal = await request(MOUNT, { token: internalToken });
    expect(internal.status).toBe(200);
    // CONTROL: the approved internal route IS visible to this caller, so the
    // absence below is the permission state and not the audience.
    expect(entryFor(internal.body, 'data', approved.modelId)).toBeDefined();
    expect(entryFor(internal.body, 'data', unapproved.modelId)).toBeUndefined();

    const anonymous = await request(MOUNT, { token: null });
    expect(entryFor(anonymous.body, 'data', unapproved.modelId)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  3. A withheld model and a nonexistent one answer identically              */
/* -------------------------------------------------------------------------- */

describe('the detail read is not an existence oracle for the internal catalogue', () => {
  it('answers 404 for a withheld model and byte-identically for one that does not exist', async () => {
    const internalRoute = await insertRoute({ availabilityScope: 'platform_internal' });

    const withheld = await request(`${MOUNT}/${internalRoute.modelId}`, { token: null });
    expect(withheld.status).toBe(404);
    expect(withheld.body).toMatchObject({ error: 'NOT_FOUND' });

    const publisher = internalRoute.modelId.split('/')[0];
    const nonexistent = await request(`${MOUNT}/${publisher}/no-such-model-${suffix()}`, {
      token: null,
    });
    expect(nonexistent.status).toBe(404);
    // Same status, same code — and the message names only what the CALLER asked
    // for, so the two answers differ in nothing but the id they echo.
    expect(nonexistent.body.error).toBe(withheld.body.error);
    expect(withheld.body.message).toBe(`No model ${internalRoute.modelId} is available to you`);

    // CONTROL: the internal audience reads the very same URL successfully, so
    // the 404 above is a withholding of a row that exists.
    const internalToken = await tokenForApplication({ type: 'internal' });
    const allowed = await request(`${MOUNT}/${internalRoute.modelId}`, { token: internalToken });
    expect(allowed.status).toBe(200);
    expect((allowed.body.data as ModelCatalogueEntry).modelId).toBe(internalRoute.modelId);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The customer projection, over the wire                                 */
/* -------------------------------------------------------------------------- */

describe('the served JSON carries no internal route id and no wholesale cost', () => {
  it('withholds both from the list and the detail, with a control proving the scan sees things', async () => {
    const route = await insertRoute({ availabilityScope: 'public_payg' });

    const list = await request(MOUNT, { token: null });
    const detail = await request(`${MOUNT}/${route.modelId}`, { token: null });
    expect(detail.status).toBe(200);

    const payloads = [
      JSON.stringify(entryFor(list.body, 'data', route.modelId)),
      detail.raw,
    ];
    for (const payload of payloads) {
      // POSITIVE CONTROL, in the same currency as the measurement: this scan can
      // find a string that IS in the payload. Without it, a scan of an empty
      // string reports the same clean result.
      expect(payload.includes(route.modelId)).toBe(true);
      expect(payload.includes(route.providerSlug)).toBe(true);

      expect(payload.includes(route.internalRouteId)).toBe(false);
      expect(payload.includes(WHOLESALE_AMOUNT)).toBe(false);
      expect(payload.toLowerCase().includes('wholesale')).toBe(false);
    }
  });

  it('reports the DEPLOYMENT’s data policy, which is what a routing policy is enforced against', async () => {
    const route = await insertRoute({ availabilityScope: 'public_payg' });

    const detail = await request(`${MOUNT}/${route.modelId}`, { token: null });
    expect(detail.status).toBe(200);
    const entry = detail.body.data as ModelCatalogueEntry;

    // Exposing these is §12's "expose deployment policy fields for retention,
    // training, region, subprocessors and zero-retention support". ENFORCING a
    // routing policy against them is a separate, unchecked item and is not
    // asserted here — there is no such filter in this repo to assert on.
    expect(entry.dataPolicy).toMatchObject({
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    });
    expect(entry.regions).toContain('us-west-2');
  });
});

/* -------------------------------------------------------------------------- */
/*  5. The URL Console still calls                                            */
/* -------------------------------------------------------------------------- */

describe('GET /models/stats keeps Console’s envelope and invents nothing', () => {
  it('serves the same audience-scoped entries in the {models, count, timestamp} shape', async () => {
    const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
    const internalRoute = await insertRoute({ availabilityScope: 'platform_internal' });

    const stats = await request(`${MOUNT}/stats`, { token: null });
    expect(stats.status).toBe(200);
    expect(Array.isArray(stats.body.models)).toBe(true);
    expect(typeof stats.body.count).toBe('number');
    expect(typeof stats.body.timestamp).toBe('string');

    // Same gate as `GET /models` — the compatibility URL is not a way round it.
    expect(entryFor(stats.body, 'models', publicRoute.modelId)).toBeDefined();
    expect(entryFor(stats.body, 'models', internalRoute.modelId)).toBeUndefined();

    // The fabricated per-model statistics the retired route invented are gone.
    const entry = entryFor(stats.body, 'models', publicRoute.modelId) as unknown as Record<
      string,
      unknown
    >;
    for (const invented of [
      'tier',
      'creditMultiplier',
      'uptime',
      'successRate',
      'isHealthy',
      'totalRequests',
    ]) {
      expect(entry).not.toHaveProperty(invented);
    }
    // CONTROL: the object is a real entry, so the absences above are absences.
    expect(entry.schemaVersion).toBe(2);
    expect(entry.displayName).toBe('Catalogue Fixture Model');
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Route ORDER                                                            */
/* -------------------------------------------------------------------------- */

describe('the one-segment routes serve their own collections', () => {
  /**
   * MEASURED: registering `/:publisher/:model` FIRST changes nothing here.
   * Express matches on segment arity, and `routing-profiles` and `stats` are ONE
   * segment while `/:publisher/:model` is two — so the module's comment about
   * `routing-profiles` being "captured as a publisher segment" describes a
   * collision that cannot occur. What these assert is therefore the ENVELOPE,
   * which is what Console parses, not an ordering property.
   */
  it('serves the profile collection in the list envelope', async () => {
    const response = await request(`${MOUNT}/routing-profiles`, { token: null });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(typeof response.body.count).toBe('number');
    expect(response.body.count).toBe((response.body.data as unknown[]).length);
  });

  it('serves a two-segment model id as a model, publisher and slug together', async () => {
    const route = await insertRoute({ availabilityScope: 'public_payg' });
    // A canonical model id CONTAINS a slash, which is why the detail read takes
    // two path parameters. A single `:id` segment would never match this URL.
    expect(route.modelId).toContain('/');

    const response = await request(`${MOUNT}/${route.modelId}`, { token: null });
    expect(response.status).toBe(200);
    expect((response.body.data as ModelCatalogueEntry).modelId).toBe(route.modelId);
  });
});
