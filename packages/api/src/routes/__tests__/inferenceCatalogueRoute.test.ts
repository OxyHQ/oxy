/**
 * `/models` — the catalogue's HTTP surface (issue #972, §16, workstream 11).
 *
 * The service test (`services/__tests__/inferenceCatalogue.test.ts`) proves the
 * commercial-permission GATE, by calling `listCatalogueForViewer` with a viewer
 * it constructs by hand. That leaves one thing untested and it is the half an
 * attacker touches: **where the viewer comes from**. `viewerForRequest` in this
 * router decides, per request, which audience a caller belongs to — and every
 * one of its branches resolves to the PUBLIC viewer except one.
 *
 * A test that only checked "the internal application sees the internal route"
 * would pass against a router that handed the internal audience to EVERYBODY.
 * So each case below is stated as a pair over the SAME fixture: the internal
 * route is present for exactly one caller and absent for all the others, and the
 * public route is present for all of them — the second half being what proves a
 * "not found" is a withholding rather than an empty database.
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
import { applications } from '../../db/schema/applications';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
} from '../../db/schema';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
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
  availabilityScope: 'public_payg' | 'internal_alia' | 'oxy_hosted';
  permissionState?: 'pending_review' | 'approved' | 'suspended';
}): Promise<RouteFixture> {
  const db = getDb();
  const publisherSlug = `cpub${suffix()}`;
  const modelSlug = `cmdl${suffix()}`;
  const revision = `cr${suffix()}`;
  const providerSlug = `cprv${suffix()}`;
  const internalRouteId = `relay-route-${suffix()}`;

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
      options.availabilityScope === 'internal_alia'
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
    { expiresIn: '1h' }
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
    [
      'a FIRST-PARTY application, which is deliberately not internal',
      async () => tokenForApplication({ type: 'first_party' }),
    ],
  ])('resolves %s to the public audience', async (_label, makeToken) => {
    const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
    const internalRoute = await insertRoute({ availabilityScope: 'internal_alia' });
    const token = await makeToken();

    const response = await request(MOUNT, { token });
    expect(response.status).toBe(200);

    // The control: this caller CAN see the catalogue, so an absent internal
    // route is a withholding and not a failed read.
    expect(entryFor(response.body, 'data', publicRoute.modelId)).toBeDefined();
    expect(entryFor(response.body, 'data', internalRoute.modelId)).toBeUndefined();
  });

  it.each([
    ['type: internal', { type: 'internal' as const }],
    ['type: system', { type: 'system' as const }],
    ['isInternal on an otherwise third-party application', {
      type: 'third_party' as const,
      isInternal: true,
    }],
  ])('resolves %s to the internal audience', async (_label, application) => {
    const publicRoute = await insertRoute({ availabilityScope: 'public_payg' });
    const internalRoute = await insertRoute({ availabilityScope: 'internal_alia' });
    const token = await tokenForApplication(application);

    const response = await request(MOUNT, { token });
    expect(response.status).toBe(200);
    expect(entryFor(response.body, 'data', publicRoute.modelId)).toBeDefined();
    // The one branch that widens. Paired with the six above, this is what makes
    // the withholding a decision rather than an accident.
    expect(entryFor(response.body, 'data', internalRoute.modelId)).toBeDefined();
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
    const approved = await insertRoute({ availabilityScope: 'internal_alia' });
    const unapproved = await insertRoute({
      availabilityScope: 'internal_alia',
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
    const internalRoute = await insertRoute({ availabilityScope: 'internal_alia' });

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
    const internalRoute = await insertRoute({ availabilityScope: 'internal_alia' });

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
    expect(entry.schemaVersion).toBe(1);
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
