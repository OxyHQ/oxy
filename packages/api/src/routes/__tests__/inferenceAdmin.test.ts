/**
 * `/inference/admin` — the catalogue's staff surface (issue #972, §16, ws 11).
 *
 * `services/__tests__/inferenceCatalogueAdmin.test.ts` covers the transitions.
 * What had no coverage is the ROUTER: the staff gate that stands in front of
 * all of them, the closed action vocabulary, and the fact that this is the one
 * surface allowed to return the columns every customer projection withholds.
 *
 * ## The shape of every claim here
 *
 * A staff gate is the easiest thing in the world to test for the wrong reason:
 * a route that is broken, unmounted, or 500ing refuses a non-staff caller just
 * as convincingly as one that is guarded. So every refusal below is paired with
 * the SAME request made by a staff user, and asserted on the guard's own
 * message — `requireStaff` answers `{error: 'Forbidden', message: 'This
 * operation requires Oxy platform staff privileges'}`, which is a different
 * body from anything the handlers or the error handler produce.
 *
 * Conversely, the "staff sees the sensitive columns" claim is paired with a
 * scan that proves it can find a value which IS present — a scanner reading an
 * empty payload reports the same clean result as one reading a correct
 * projection.
 *
 * ## The staff row is REAL, and that is load-bearing since #972 section 12
 *
 * `authMiddleware` is mocked, but `seedStaffUser` inserts a row with
 * `is_staff = true` and an explicit `staff_capabilities` list, because
 * `requireStaffCapability` reads that column out of the database rather than off
 * `req.user` (see `middleware/requireStaff.ts` for why). A fixture whose mock
 * claimed staff while its row said otherwise would refuse every graded write for
 * a reason that has nothing to do with the capability under test.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';
process.env.INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS = '3600';

/**
 * The caller, controlled per test. `isStaff` is the only thing `requireStaff`
 * reads, and an EMPTY id leaves `req.user` unset so `staffUserId`'s own 401 is
 * reachable — a mock that always authenticated would make that branch dead.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string; isStaff: boolean } },
    _res: unknown,
    next: () => void
  ) => {
    if (currentUserId.length > 0) {
      req.user = { _id: currentUserId, id: currentUserId, isStaff: currentUserIsStaff };
    }
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  LEGACY_INTERNAL_ALIA_AVAILABILITY_SCOPE,
  priceVersionUnitPrices,
  priceVersions,
} from '../../db/schema';
import { users, type StaffCapability } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import adminRouter from '../inferenceAdmin';
import catalogueRouter from '../inferenceCatalogue';

let server: http.Server;
let currentUserId = '';
let currentUserIsStaff = false;

const ADMIN = '/inference/admin';
const MODELS = '/models';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

function request(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          authorization: 'Bearer staff-session-token',
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = raw.length > 0 ? JSON.parse(raw) : {};
          } catch {
            parsed = {};
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

interface DeploymentFixture {
  readonly deploymentId: string;
  readonly modelId: string;
  readonly internalRouteId: string;
  readonly providerSlug: string;
  readonly priceVersionId: string;
  readonly wholesaleAmount: string;
}

/**
 * A route in the DEFAULT state: `pending_review`, no legal review. That is what
 * a newly proposed route looks like, and it is the state the approval workflow
 * has to move.
 */
async function insertPendingDeployment(): Promise<DeploymentFixture> {
  const db = getDb();
  const publisherSlug = `apub${suffix()}`;
  const providerSlug = `aprv${suffix()}`;
  const internalRouteId = `kaana-route-${suffix()}`;
  const wholesaleAmount = '0.000000700000';

  await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: 'Admin Pub' });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: `amdl${suffix()}`,
      displayName: 'Admin Fixture Model',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: false,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: false,
      supportsJsonMode: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 4096,
      licenseId: 'apache-2.0',
      licenseDisplayName: 'Apache 2.0',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    })
    .returning({ id: inferenceModels.id, modelId: inferenceModels.modelId });

  const revisionName = `ar${suffix()}`;
  const [revision] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision: revisionName, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });

  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: 'Admin Fixture Provider',
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

  if (model.modelId === null) throw new Error('the generated model id did not compose');
  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: `${model.modelId}@${revisionName}`,
      provider: providerSlug,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });

  const [deployment] = await db
    .insert(inferenceDeployments)
    .values({
      modelRevisionId: revision.id,
      providerSlug,
      regions: ['us-west-2'],
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      status: 'active',
      internalRouteId,
      priceVersionId: priceVersion.id,
      upstreamWholesaleCostAmount: wholesaleAmount,
      upstreamWholesaleCostCurrency: 'USD',
      upstreamWholesaleCostUnit: 'input_tokens',
      upstreamWholesaleCostPer: 1_000_000,
    })
    .returning({ id: inferenceDeployments.id });

  return {
    deploymentId: deployment.id,
    modelId: model.modelId,
    internalRouteId,
    providerSlug,
    priceVersionId: priceVersion.id,
    wholesaleAmount,
  };
}

/**
 * A staff account, with the graded capabilities it holds.
 *
 * `isStaff` is written to the ROW and not only to the mocked `req.user`:
 * `requireStaffCapability` re-reads both from the database. The default grant is
 * the publish capability, so every pre-existing case in this file exercises the
 * handler it was written for; the cases that are ABOUT the capability pass `[]`.
 */
async function seedStaffUser(
  staffCapabilities: readonly StaffCapability[] = ['inference:catalogue:publish']
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `adm-${suffix()}`, isStaff: true, staffCapabilities: [...staffCapabilities] })
    .returning({ id: users.id });
  return row.id;
}

/** Grant a capability to an existing account, as an administrator would. */
async function grantCapability(userId: string, capability: StaffCapability): Promise<void> {
  await getDb()
    .update(users)
    .set({ staffCapabilities: [capability] })
    .where(eq(users.id, userId));
}

/** Read one deployment's admin row straight out of the table. */
async function readDeployment(deploymentId: string) {
  const [row] = await getDb()
    .select({
      permissionState: inferenceDeployments.permissionState,
      permissionStateNote: inferenceDeployments.permissionStateNote,
      permissionStateChangedByUserId: inferenceDeployments.permissionStateChangedByUserId,
      legalReviewStatus: inferenceDeployments.legalReviewStatus,
      legalReviewEvidenceRef: inferenceDeployments.legalReviewEvidenceRef,
      legalReviewedByUserId: inferenceDeployments.legalReviewedByUserId,
      platformFeePriceVersionId: inferenceDeployments.platformFeePriceVersionId,
    })
    .from(inferenceDeployments)
    .where(eq(inferenceDeployments.id, deploymentId));
  return row;
}

async function makeDeploymentByok(fixture: DeploymentFixture): Promise<void> {
  await getDb()
    .update(inferenceDeployments)
    .set({
      availabilityScope: 'byok_only',
      commercialPermission: 'customer_byok',
      priceVersionId: null,
    })
    .where(eq(inferenceDeployments.id, fixture.deploymentId));
  await getDb().insert(priceVersionUnitPrices).values({
    priceVersionId: fixture.priceVersionId,
    unit: 'requests',
    amount: '0.010000000000',
    per: 1,
  });
}

async function readRoutingScorecard(kaanaDeploymentId: string) {
  const [row] = await getDb()
    .select()
    .from(inferenceDeploymentRoutingScores)
    .where(eq(inferenceDeploymentRoutingScores.deploymentId, kaanaDeploymentId));
  return row;
}

/** Every admin row this file can see, filtered to the one it owns. */
function adminRowFor(body: Record<string, unknown>, deploymentId: string) {
  const rows = body.data as { id: string }[];
  return rows.find((row) => row.id === deploymentId);
}

const STAFF_REFUSAL = {
  error: 'Forbidden',
  message: 'This operation requires Oxy platform staff privileges',
};

function completeScorecard(fixture: Pick<DeploymentFixture, 'priceVersionId'>) {
  const now = Date.now();
  const windowStart = new Date(now - 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(now - 30 * 60 * 1000).toISOString();
  const validUntil = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  return {
    price: {
      score: 91,
      source: 'provider_contract' as const,
      evidenceRef: 'routing-review/http-price',
      priceVersionId: fixture.priceVersionId,
    },
    latency: {
      score: 82,
      source: 'kaana_measurement' as const,
      evidenceRef: 'routing-review/http-latency',
      measurementWindowStart: windowStart,
      measurementWindowEnd: windowEnd,
      validUntil,
    },
    throughput: {
      score: 73,
      source: 'kaana_measurement' as const,
      evidenceRef: 'routing-review/http-throughput',
      measurementWindowStart: windowStart,
      measurementWindowEnd: windowEnd,
      validUntil,
    },
    balanced: {
      score: 84,
      source: 'reviewed_scorecard' as const,
      evidenceRef: 'routing-review/http-balanced',
      formulaRef: 'routing-formula/balanced-v1',
      validUntil,
    },
    reason: 'Reviewed against the current provider contract and performance report',
  };
}

async function authorCompleteScorecard(fixture: DeploymentFixture): Promise<void> {
  const response = await request(
    'PUT',
    `${ADMIN}/kaana-deployments/${fixture.internalRouteId}/routing-scorecard`,
    completeScorecard(fixture)
  );
  expect(response.status).toBe(200);
}

/**
 * The customer catalogue is mounted here as a control, so it runs PUBLISHED.
 *
 * `INFERENCE_CATALOGUE_AUDIENCE` is `internal` unless a deployment says
 * otherwise (issue #972 workstream 16), and this file's catalogue reads are
 * anonymous — i.e. the public viewer. Its own default and both positions belong
 * to `inferenceCataloguePublication.test.ts`; here it must be open, or the
 * "an approved route reaches the customer catalogue" control would report
 * nothing for a reason that has nothing to do with approval.
 */
const ORIGINAL_CATALOGUE_AUDIENCE = process.env.INFERENCE_CATALOGUE_AUDIENCE;

beforeAll(async () => {
  process.env.INFERENCE_CATALOGUE_AUDIENCE = 'public';
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use(ADMIN, adminRouter);
  // Mounted alongside so the "staff sees what customers do not" claim can be
  // asserted against the REAL customer projection rather than against a belief
  // about it.
  app.use(MODELS, catalogueRouter);
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

beforeEach(async () => {
  currentUserId = await seedStaffUser();
  currentUserIsStaff = true;
});

/* -------------------------------------------------------------------------- */
/*  1. The staff gate stands in front of every route on the mount             */
/* -------------------------------------------------------------------------- */

describe('every route on this mount is staff-gated', () => {
  it.each([
    ['GET', `${ADMIN}/deployments`, undefined],
    ['GET', `${ADMIN}/rollout`, undefined],
    // A window in the distant past, so this case needs no fixture and cannot see
    // another suite's rows. Request counts per application are customer data, so
    // this surface needs the same gate as the rest of the mount.
    ['GET', `${ADMIN}/metrics?from=2020-01-01&to=2020-01-02`, undefined],
    ['POST', `${ADMIN}/deployments/DEPLOYMENT/legal-review`, { status: 'approved', evidenceRef: 'x' }],
    ['POST', `${ADMIN}/deployments/DEPLOYMENT/approve`, {}],
    [
      'PUT',
      `${ADMIN}/kaana-deployments/KAANA_DEPLOYMENT/routing-scorecard`,
      undefined,
    ],
  ] as const)('refuses %s %s to a non-staff user, and serves it to staff', async (method, template, body) => {
    const fixture = await insertPendingDeployment();
    const path = template
      .replace('KAANA_DEPLOYMENT', fixture.internalRouteId)
      .replace('DEPLOYMENT', fixture.deploymentId);
    const requestBody = path.includes('/routing-scorecard') ? completeScorecard(fixture) : body;

    currentUserIsStaff = false;
    const refused = await request(method, path, requestBody);
    expect(refused.status).toBe(403);
    // The guard's OWN body. A 403 from anywhere else — or a 404 from an
    // unmounted route — fails this, which is what stops the test passing for
    // the wrong reason.
    expect(refused.body).toEqual(STAFF_REFUSAL);

    // CONTROL: the identical request from a staff user is answered. `approve`
    // needs its legal review first, so it is prepared here rather than being
    // allowed to 409 and read as "the gate let nothing through".
    currentUserIsStaff = true;
    if (path.endsWith('/approve')) {
      const review = await request('POST', `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`, {
        status: 'approved',
        evidenceRef: `contract-register/${suffix()}`,
      });
      expect(review.status).toBe(200);
      await authorCompleteScorecard(fixture);
    }
    const allowed = await request(method, path, requestBody);
    expect(allowed.status).toBe(200);
  });

  it('refuses a caller with no authenticated user at all', async () => {
    const fixture = await insertPendingDeployment();

    currentUserId = '';
    const refused = await request('GET', `${ADMIN}/deployments`);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual(STAFF_REFUSAL);

    // CONTROL: a staff user reads the same URL and finds the fixture.
    currentUserId = await seedStaffUser();
    currentUserIsStaff = true;
    const allowed = await request('GET', `${ADMIN}/deployments`);
    expect(allowed.status).toBe(200);
    expect(adminRowFor(allowed.body, fixture.deploymentId)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  1b. The two WRITES need the graded capability; the reads do not           */
/* -------------------------------------------------------------------------- */

/**
 * THE ASSERTION THE CAPABILITY EXISTS FOR is the first case: a real, fully
 * authenticated staff member — the exact caller who could publish a route
 * yesterday — is REFUSED.
 *
 * A capability tested only in its granted position measures nothing: every write
 * would still be served to every staff member and the column would be decoration.
 * So each case below pairs the refusal with the grant, on the SAME account and
 * the SAME request, and asserts the guard's own message so a 403 from `requireStaff`
 * or from the handler cannot be mistaken for this one.
 */
describe('publishing a catalogue route requires the graded staff capability', () => {
  const CAPABILITY_REFUSAL_FRAGMENT = 'requires the inference:catalogue:publish staff capability';

  it('refuses a staff member holding NO capabilities, and admits the same account once granted', async () => {
    const fixture = await insertPendingDeployment();
    currentUserId = await seedStaffUser([]);
    currentUserIsStaff = true;

    const refused = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`,
      { status: 'approved', evidenceRef: `contract-register/${suffix()}` }
    );
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(expect.stringContaining(CAPABILITY_REFUSAL_FRAGMENT));
    // Nothing moved. A guard that answered 403 after writing would be worse than
    // no guard, and the status code alone cannot tell the two apart.
    expect((await readDeployment(fixture.deploymentId)).legalReviewStatus).toBe('not_started');

    // THE POSITIVE CONTROL: one UPDATE, nothing else changed, and the identical
    // request is served.
    await grantCapability(currentUserId, 'inference:catalogue:publish');
    const allowed = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`,
      { status: 'approved', evidenceRef: `contract-register/${suffix()}` }
    );
    expect(allowed.status).toBe(200);
    expect((await readDeployment(fixture.deploymentId)).legalReviewStatus).toBe('approved');
  });

  it('refuses a permission ACTION on the same terms', async () => {
    const fixture = await insertPendingDeployment();
    // Reviewed first, by an account that holds the capability, so the refusal
    // below cannot be the missing-review 409 wearing a different number.
    const review = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`,
      { status: 'approved', evidenceRef: `contract-register/${suffix()}` }
    );
    expect(review.status).toBe(200);
    await authorCompleteScorecard(fixture);

    currentUserId = await seedStaffUser([]);
    const refused = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/approve`,
      {}
    );
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(expect.stringContaining(CAPABILITY_REFUSAL_FRAGMENT));
    expect((await readDeployment(fixture.deploymentId)).permissionState).toBe('pending_review');

    await grantCapability(currentUserId, 'inference:catalogue:publish');
    const allowed = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/approve`,
      {}
    );
    expect(allowed.status).toBe(200);
    expect((await readDeployment(fixture.deploymentId)).permissionState).toBe('approved');
  });

  it('does NOT narrow the reads — a capability-less staff member still sees the dashboard', async () => {
    const fixture = await insertPendingDeployment();
    currentUserId = await seedStaffUser([]);

    const deployments = await request('GET', `${ADMIN}/deployments`);
    expect(deployments.status).toBe(200);
    expect(adminRowFor(deployments.body, fixture.deploymentId)).toBeDefined();

    const rollout = await request('GET', `${ADMIN}/rollout`);
    expect(rollout.status).toBe(200);
  });

  it('refuses a DIFFERENT capability, so the grant is per-capability and not a second staff flag', async () => {
    const fixture = await insertPendingDeployment();
    // A real, valid grant — for the wrong surface. Without this case, granting
    // any capability at all would be indistinguishable from granting this one.
    currentUserId = await seedStaffUser(['billing:adjust']);

    const refused = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`,
      { status: 'approved', evidenceRef: `contract-register/${suffix()}` }
    );
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(expect.stringContaining(CAPABILITY_REFUSAL_FRAGMENT));
  });

  it('refuses an account that holds the capability but is not staff at all', async () => {
    const fixture = await insertPendingDeployment();
    const [row] = await getDb()
      .insert(users)
      .values({
        username: `adm-${suffix()}`,
        isStaff: false,
        staffCapabilities: ['inference:catalogue:publish'],
      })
      .returning({ id: users.id });
    currentUserId = row.id;
    // The mocked session claims staff — the state a stale cache would produce —
    // so this measures the guard's re-read of the row and nothing else.
    currentUserIsStaff = true;

    const refused = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`,
      { status: 'approved', evidenceRef: `contract-register/${suffix()}` }
    );
    expect(refused.status).toBe(403);
    expect((await readDeployment(fixture.deploymentId)).legalReviewStatus).toBe('not_started');
  });
});

/* -------------------------------------------------------------------------- */
/*  1c. Associating an existing BYOK platform-fee version                    */
/* -------------------------------------------------------------------------- */

describe('the BYOK platform-fee pointer endpoint is exact and staff-authorized', () => {
  const feePath = (deploymentId: string) =>
    `${ADMIN}/deployments/${deploymentId}/platform-fee-price-version`;

  it('refuses unauthenticated, non-staff and capability-less callers without mutating the pointer', async () => {
    const fixture = await insertPendingDeployment();
    await makeDeploymentByok(fixture);
    const body = { platformFeePriceVersionId: fixture.priceVersionId };

    currentUserId = '';
    expect((await request('PUT', feePath(fixture.deploymentId), body)).status).toBe(403);

    currentUserId = await seedStaffUser();
    currentUserIsStaff = false;
    expect((await request('PUT', feePath(fixture.deploymentId), body)).status).toBe(403);

    currentUserId = await seedStaffUser([]);
    currentUserIsStaff = true;
    const withoutCapability = await request('PUT', feePath(fixture.deploymentId), body);
    expect(withoutCapability.status).toBe(403);
    expect(withoutCapability.body.message).toEqual(
      expect.stringContaining('requires the inference:catalogue:publish staff capability')
    );
    expect((await readDeployment(fixture.deploymentId)).platformFeePriceVersionId).toBeNull();
  });

  it('associates the exact existing version without changing its price or rates', async () => {
    const fixture = await insertPendingDeployment();
    await makeDeploymentByok(fixture);
    const [priceBefore] = await getDb()
      .select()
      .from(priceVersions)
      .where(eq(priceVersions.id, fixture.priceVersionId));
    const ratesBefore = await getDb()
      .select()
      .from(priceVersionUnitPrices)
      .where(eq(priceVersionUnitPrices.priceVersionId, fixture.priceVersionId));

    const response = await request('PUT', feePath(fixture.deploymentId), {
      platformFeePriceVersionId: fixture.priceVersionId,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        deploymentId: fixture.deploymentId,
        platformFeePriceVersionId: fixture.priceVersionId,
      },
    });
    expect((await readDeployment(fixture.deploymentId)).platformFeePriceVersionId).toBe(
      fixture.priceVersionId
    );
    const [priceAfter] = await getDb()
      .select()
      .from(priceVersions)
      .where(eq(priceVersions.id, fixture.priceVersionId));
    const ratesAfter = await getDb()
      .select()
      .from(priceVersionUnitPrices)
      .where(eq(priceVersionUnitPrices.priceVersionId, fixture.priceVersionId));
    expect(priceAfter).toEqual(priceBefore);
    expect(ratesAfter).toEqual(ratesBefore);
  });

  it('rejects a non-BYOK deployment', async () => {
    const fixture = await insertPendingDeployment();

    const response = await request('PUT', feePath(fixture.deploymentId), {
      platformFeePriceVersionId: fixture.priceVersionId,
    });

    expect(response.status).toBe(409);
    expect((await readDeployment(fixture.deploymentId)).platformFeePriceVersionId).toBeNull();
  });

  it.each(['provider', 'model revision'] as const)(
    'rejects an existing price version for another %s',
    async (mismatch) => {
      const fixture = await insertPendingDeployment();
      await makeDeploymentByok(fixture);
      let provider = fixture.providerSlug;
      if (mismatch === 'provider') {
        provider = `other${suffix()}`;
        await getDb().insert(inferenceProviders).values({
          slug: provider,
          displayName: 'Other fee provider',
          kind: 'customer_byok',
          retainsPayloads: false,
          retentionDays: 0,
          trainsOnCustomerData: false,
          zeroDataRetentionAvailable: true,
        });
      }
      const [wrong] = await getDb()
        .insert(priceVersions)
        .values({
          modelReference:
            mismatch === 'model revision'
              ? `${fixture.modelId}@other-${suffix()}`
              : (
                  await getDb()
                    .select({ modelReference: priceVersions.modelReference })
                    .from(priceVersions)
                    .where(eq(priceVersions.id, fixture.priceVersionId))
                )[0].modelReference,
          provider,
          status: 'active',
          effectiveFrom: new Date(Date.now() - 60_000),
        })
        .returning({ id: priceVersions.id });

      const response = await request('PUT', feePath(fixture.deploymentId), {
        platformFeePriceVersionId: wrong.id,
      });

      expect(response.status).toBe(409);
      expect((await readDeployment(fixture.deploymentId)).platformFeePriceVersionId).toBeNull();
    }
  );

  it('rejects whitespace and unknown fields instead of normalizing an opaque id', async () => {
    const fixture = await insertPendingDeployment();
    await makeDeploymentByok(fixture);

    const padded = await request('PUT', feePath(fixture.deploymentId), {
      platformFeePriceVersionId: ` ${fixture.priceVersionId}`,
    });
    expect(padded.status).toBe(400);
    const widened = await request('PUT', feePath(fixture.deploymentId), {
      platformFeePriceVersionId: fixture.priceVersionId,
      amount: '0.00',
    });
    expect(widened.status).toBe(400);
    expect((await readDeployment(fixture.deploymentId)).platformFeePriceVersionId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  1d. A routing scorecard uses the exact Kaana identity and full provenance */
/* -------------------------------------------------------------------------- */

describe('the Kaana routing scorecard endpoint is a full, attributed replacement', () => {
  const scorecardPath = (kaanaDeploymentId: string) =>
    `${ADMIN}/kaana-deployments/${kaanaDeploymentId}/routing-scorecard`;

  it('stores all four signals under the exact Kaana deployment id, including explicit null', async () => {
    const fixture = await insertPendingDeployment();
    const complete = completeScorecard(fixture);
    const body = { ...complete, throughput: { ...complete.throughput, score: null } };

    const response = await request('PUT', scorecardPath(fixture.internalRouteId), body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        deploymentId: fixture.internalRouteId,
        scorecard: body,
      },
    });
    expect(await readRoutingScorecard(fixture.internalRouteId)).toMatchObject({
      deploymentId: fixture.internalRouteId,
      priceScore: body.price.score,
      priceSource: body.price.source,
      priceEvidenceRef: body.price.evidenceRef,
      priceVersionId: body.price.priceVersionId,
      latencyScore: body.latency.score,
      latencySource: body.latency.source,
      throughputScore: null,
      throughputSource: body.throughput.source,
      balancedScore: body.balanced.score,
      balancedSource: body.balanced.source,
      reason: body.reason,
      changedByUserId: currentUserId,
    });
  });

  it.each([
    ['the Oxy catalogue row id', (fixture: DeploymentFixture) => fixture.deploymentId],
    ['the provider slug', (fixture: DeploymentFixture) => fixture.providerSlug],
  ])('answers 404 when the caller supplies %s instead of the Kaana id', async (_label, wrongId) => {
    const fixture = await insertPendingDeployment();
    const response = await request(
      'PUT',
      scorecardPath(wrongId(fixture)),
      completeScorecard(fixture)
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: 'NOT_FOUND',
      message: `No inference deployment with id ${wrongId(fixture)}`,
    });
    expect(await readRoutingScorecard(fixture.internalRouteId)).toBeUndefined();
  });

  it('answers 400 instead of silently trimming a Kaana deployment identity', async () => {
    const fixture = await insertPendingDeployment();
    const response = await request(
      'PUT',
      scorecardPath(`%20${fixture.internalRouteId}%20`),
      completeScorecard(fixture)
    );

    expect(response.status).toBe(400);
    expect(await readRoutingScorecard(fixture.internalRouteId)).toBeUndefined();
  });

  it.each([
    ['a partial scorecard', () => ({ price: { score: 1 } })],
    [
      'an out-of-range score',
      (fixture: DeploymentFixture) => {
        const body = completeScorecard(fixture);
        return { ...body, price: { ...body.price, score: 1_000_001 } };
      },
    ],
    [
      'a price source that claims Kaana measured price',
      (fixture: DeploymentFixture) => {
        const body = completeScorecard(fixture);
        return { ...body, price: { ...body.price, source: 'kaana_measurement' } };
      },
    ],
    [
      'a cost-model source on measured latency',
      (fixture: DeploymentFixture) => {
        const body = completeScorecard(fixture);
        return { ...body, latency: { ...body.latency, source: 'cost_model' } };
      },
    ],
    [
      'an unrecognised field',
      (fixture: DeploymentFixture) => ({ ...completeScorecard(fixture), priority: 99 }),
    ],
    [
      'blank evidence after trimming',
      (fixture: DeploymentFixture) => {
        const body = completeScorecard(fixture);
        return { ...body, balanced: { ...body.balanced, evidenceRef: '   ' } };
      },
    ],
  ] as const)('answers 400 for %s and writes nothing', async (_label, buildBody) => {
    const fixture = await insertPendingDeployment();
    const response = await request(
      'PUT',
      scorecardPath(fixture.internalRouteId),
      buildBody(fixture)
    );

    expect(response.status).toBe(400);
    expect(await readRoutingScorecard(fixture.internalRouteId)).toBeUndefined();
  });

  it('answers 409 for a mismatched price version, future measurement, or expired evidence', async () => {
    const fixture = await insertPendingDeployment();
    const other = await insertPendingDeployment();

    const wrongPrice = completeScorecard(fixture);
    wrongPrice.price.priceVersionId = other.priceVersionId;
    expect(
      (await request('PUT', scorecardPath(fixture.internalRouteId), wrongPrice)).status
    ).toBe(409);

    const future = completeScorecard(fixture);
    future.latency.measurementWindowEnd = new Date(
      Date.now() + 60 * 60 * 1000
    ).toISOString();
    expect((await request('PUT', scorecardPath(fixture.internalRouteId), future)).status).toBe(409);

    const expired = completeScorecard(fixture);
    expired.balanced.validUntil = new Date(Date.now() - 1000).toISOString();
    expect((await request('PUT', scorecardPath(fixture.internalRouteId), expired)).status).toBe(409);
    expect(await readRoutingScorecard(fixture.internalRouteId)).toBeUndefined();
  });

  it('answers 409 when one Kaana identity maps to multiple catalogue rows', async () => {
    const fixture = await insertPendingDeployment();
    const duplicate = await insertPendingDeployment();
    await getDb()
      .update(inferenceDeployments)
      .set({
        internalRouteId: fixture.internalRouteId,
        priceVersionId: fixture.priceVersionId,
      })
      .where(eq(inferenceDeployments.id, duplicate.deploymentId));

    const response = await request(
      'PUT',
      scorecardPath(fixture.internalRouteId),
      completeScorecard(fixture)
    );
    expect(response.status).toBe(409);
    expect(await readRoutingScorecard(fixture.internalRouteId)).toBeUndefined();
  });

  it('requires the catalogue-publish capability before writing, then accepts the same request', async () => {
    const fixture = await insertPendingDeployment();
    currentUserId = await seedStaffUser([]);
    currentUserIsStaff = true;

    const refused = await request(
      'PUT',
      scorecardPath(fixture.internalRouteId),
      completeScorecard(fixture)
    );
    expect(refused.status).toBe(403);
    expect(refused.body.message).toEqual(
      expect.stringContaining('requires the inference:catalogue:publish staff capability')
    );
    expect(await readRoutingScorecard(fixture.internalRouteId)).toBeUndefined();

    await grantCapability(currentUserId, 'inference:catalogue:publish');
    const allowed = await request(
      'PUT',
      scorecardPath(fixture.internalRouteId),
      completeScorecard(fixture)
    );
    expect(allowed.status).toBe(200);
    expect(await readRoutingScorecard(fixture.internalRouteId)).toMatchObject({
      changedByUserId: currentUserId,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The staff view IS the withheld columns                                 */
/* -------------------------------------------------------------------------- */

describe('the staff listing returns what the customer projection withholds', () => {
  it('normalizes a legacy storage scope before the admin wire response', async () => {
    const fixture = await insertPendingDeployment();
    await getDb().execute(sql`
      update ${inferenceDeployments}
      set availability_scope = ${LEGACY_INTERNAL_ALIA_AVAILABILITY_SCOPE}
      where ${inferenceDeployments.id} = ${fixture.deploymentId}
    `);

    const admin = await request('GET', `${ADMIN}/deployments`);
    expect(admin.status).toBe(200);
    const row = adminRowFor(admin.body, fixture.deploymentId) as
      | { availabilityScope?: unknown }
      | undefined;
    expect(row?.availabilityScope).toBe('platform_internal');
    expect(admin.raw).not.toContain(LEGACY_INTERNAL_ALIA_AVAILABILITY_SCOPE);
  });

  it('shows the internal route id and the wholesale cost here and nowhere else', async () => {
    const fixture = await insertPendingDeployment();
    // Approved, so the same route is also visible on the customer surface —
    // otherwise "the customer cannot see the cost" would be true merely because
    // the customer cannot see the route.
    await request('POST', `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`, {
      status: 'approved',
      evidenceRef: `contract-register/${suffix()}`,
    });
    await authorCompleteScorecard(fixture);
    await request('POST', `${ADMIN}/deployments/${fixture.deploymentId}/approve`, {});

    const admin = await request('GET', `${ADMIN}/deployments`);
    expect(admin.status).toBe(200);
    const row = adminRowFor(admin.body, fixture.deploymentId) as unknown as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.internalRouteId).toBe(fixture.internalRouteId);
    expect(row.upstreamWholesaleCostAmount).toBe(fixture.wholesaleAmount);
    expect(row.legalReviewEvidenceRef).toEqual(expect.stringContaining('contract-register/'));

    // The same route on the customer surface, scanned for the same three
    // strings — with a positive control proving the scan reads a real payload.
    const customer = await request('GET', `${MODELS}/${fixture.modelId}`);
    expect(customer.status).toBe(200);
    expect(customer.raw.includes(fixture.modelId)).toBe(true);
    expect(customer.raw.includes(fixture.internalRouteId)).toBe(false);
    expect(customer.raw.includes(fixture.wholesaleAmount)).toBe(false);
    expect(customer.raw.includes('contract-register/')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The action is a path segment from a closed set                         */
/* -------------------------------------------------------------------------- */

describe('the action is a path segment from a closed set, never a body field', () => {
  it('refuses an action outside the vocabulary before any handler runs', async () => {
    const fixture = await insertPendingDeployment();
    const before = await readDeployment(fixture.deploymentId);

    const refused = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/frobnicate`,
      {}
    );
    // A closed `z.enum` on the PATH: the router matches the shape, and the
    // validator refuses the verb. Whether that is 400 or 404 is not the claim —
    // the claim is that it is not 2xx and that nothing moved.
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await readDeployment(fixture.deploymentId)).toEqual(before);

    // CONTROL: a verb that IS in the vocabulary moves the row, so the refusal
    // above is the vocabulary and not a route that never works.
    const accepted = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/suspend`,
      {}
    );
    expect(accepted.status).toBe(200);
    expect((await readDeployment(fixture.deploymentId)).permissionState).toBe('suspended');
  });

  it('refuses a body that names an action, so the path cannot be overridden by data', async () => {
    const fixture = await insertPendingDeployment();
    const before = await readDeployment(fixture.deploymentId);

    // `.strict()`: an unrecognised field is an error rather than something
    // silently dropped. If it were dropped, this request would SUSPEND the row
    // while the caller believed they had approved it.
    const refused = await request('POST', `${ADMIN}/deployments/${fixture.deploymentId}/suspend`, {
      action: 'approve',
    });
    expect(refused.status).toBe(400);
    expect(await readDeployment(fixture.deploymentId)).toEqual(before);

    // CONTROL: the same request with only the permitted field is accepted.
    const accepted = await request('POST', `${ADMIN}/deployments/${fixture.deploymentId}/suspend`, {
      note: 'provider incident',
    });
    expect(accepted.status).toBe(200);
    const after = await readDeployment(fixture.deploymentId);
    expect(after.permissionState).toBe('suspended');
    expect(after.permissionStateNote).toBe('provider incident');
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Approval depends on a legal review, and both are attributed            */
/* -------------------------------------------------------------------------- */

describe('an approval cites a review, and both name the staff member who made them', () => {
  it('refuses a serving-scope approval without identity, scorecard, or all four scores', async () => {
    const unmapped = await insertPendingDeployment();
    await getDb()
      .update(inferenceDeployments)
      .set({ internalRouteId: null })
      .where(eq(inferenceDeployments.id, unmapped.deploymentId));
    await request('POST', `${ADMIN}/deployments/${unmapped.deploymentId}/legal-review`, {
      status: 'approved',
      evidenceRef: `contract-register/${suffix()}`,
    });
    expect(
      (await request('POST', `${ADMIN}/deployments/${unmapped.deploymentId}/approve`, {})).status
    ).toBe(409);

    const missing = await insertPendingDeployment();
    await request('POST', `${ADMIN}/deployments/${missing.deploymentId}/legal-review`, {
      status: 'approved',
      evidenceRef: `contract-register/${suffix()}`,
    });
    expect(
      (await request('POST', `${ADMIN}/deployments/${missing.deploymentId}/approve`, {})).status
    ).toBe(409);

    const incomplete = await insertPendingDeployment();
    const body = completeScorecard(incomplete);
    body.balanced.score = null;
    expect(
      (
        await request(
          'PUT',
          `${ADMIN}/kaana-deployments/${incomplete.internalRouteId}/routing-scorecard`,
          body
        )
      ).status
    ).toBe(200);
    await request('POST', `${ADMIN}/deployments/${incomplete.deploymentId}/legal-review`, {
      status: 'approved',
      evidenceRef: `contract-register/${suffix()}`,
    });
    expect(
      (await request('POST', `${ADMIN}/deployments/${incomplete.deploymentId}/approve`, {})).status
    ).toBe(409);
  });

  it('refuses an approval before the review, and accepts it after — 409, not 500', async () => {
    const fixture = await insertPendingDeployment();

    const early = await request('POST', `${ADMIN}/deployments/${fixture.deploymentId}/approve`, {});
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({
      error: 'CONFLICT',
      message:
        'This route cannot be approved until its contract/legal review is approved and its evidence reference recorded.',
    });
    expect((await readDeployment(fixture.deploymentId)).permissionState).toBe('pending_review');

    const evidenceRef = `contract-register/${suffix()}`;
    const review = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`,
      { status: 'approved', evidenceRef }
    );
    expect(review.status).toBe(200);
    await authorCompleteScorecard(fixture);

    const approved = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/approve`,
      { note: 'resale terms confirmed' }
    );
    expect(approved.status).toBe(200);

    const row = await readDeployment(fixture.deploymentId);
    expect(row.permissionState).toBe('approved');
    expect(row.legalReviewEvidenceRef).toBe(evidenceRef);
    // Attribution comes from the AUTHENTICATED principal, never from the body:
    // no request above named a user id anywhere.
    expect(row.permissionStateChangedByUserId).toBe(currentUserId);
    expect(row.legalReviewedByUserId).toBe(currentUserId);
  });

  it('refuses a legal APPROVAL that cites no evidence, while a rejection needs none', async () => {
    const fixture = await insertPendingDeployment();

    const refused = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`,
      { status: 'approved' }
    );
    expect(refused.status).toBe(409);
    expect(refused.body.message).toEqual(
      expect.stringContaining('must cite its evidence reference')
    );
    expect((await readDeployment(fixture.deploymentId)).legalReviewStatus).toBe('not_started');

    // CONTROL: the same shape of request for a REJECTION is accepted with no
    // evidence, so the 409 is the approval rule and not a rejected body.
    const rejected = await request(
      'POST',
      `${ADMIN}/deployments/${fixture.deploymentId}/legal-review`,
      { status: 'rejected' }
    );
    expect(rejected.status).toBe(200);
    expect((await readDeployment(fixture.deploymentId)).legalReviewStatus).toBe('rejected');
  });

  it('reports an unknown deployment as 404 rather than as a conflict', async () => {
    const missing = `dep-${suffix()}`;
    const response = await request('POST', `${ADMIN}/deployments/${missing}/suspend`, {});
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: 'NOT_FOUND',
      message: `No inference deployment with id ${missing}`,
    });

    // CONTROL: a real id on the identical verb is answered 200.
    const fixture = await insertPendingDeployment();
    const real = await request('POST', `${ADMIN}/deployments/${fixture.deploymentId}/suspend`, {});
    expect(real.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*  5. Retirement is terminal                                                 */
/* -------------------------------------------------------------------------- */

describe('a retired route stays retired', () => {
  it('refuses every further action on it, having accepted the first', async () => {
    const fixture = await insertPendingDeployment();

    const retired = await request('POST', `${ADMIN}/deployments/${fixture.deploymentId}/retire`, {});
    expect(retired.status).toBe(200);
    expect((await readDeployment(fixture.deploymentId)).permissionState).toBe('retired');

    for (const action of ['approve', 'restrict', 'suspend', 'retire']) {
      const refused = await request(
        'POST',
        `${ADMIN}/deployments/${fixture.deploymentId}/${action}`,
        {}
      );
      expect(refused.status).toBe(409);
      expect(refused.body.message).toEqual(expect.stringContaining('A retired route stays retired'));
    }
    // Nothing moved across four attempts.
    expect((await readDeployment(fixture.deploymentId)).permissionState).toBe('retired');

    // And a retired route is gone from the customer catalogue, while a fresh
    // approved one is present — the control that makes the absence a decision.
    const other = await insertPendingDeployment();
    await request('POST', `${ADMIN}/deployments/${other.deploymentId}/legal-review`, {
      status: 'approved',
      evidenceRef: `contract-register/${suffix()}`,
    });
    await authorCompleteScorecard(other);
    await request('POST', `${ADMIN}/deployments/${other.deploymentId}/approve`, {});

    const catalogue = await request('GET', MODELS);
    const ids = (catalogue.body.data as { modelId: string }[]).map((entry) => entry.modelId);
    expect(ids).toContain(other.modelId);
    expect(ids).not.toContain(fixture.modelId);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. What is switched on in this deployment                                 */
/* -------------------------------------------------------------------------- */

describe('GET /inference/admin/rollout answers "what is on here"', () => {
  it('reports every rollout flag, its state and the reason for it', async () => {
    const response = await request('GET', `${ADMIN}/rollout`);

    expect(response.status).toBe(200);
    const report = response.body.data as Record<string, Record<string, unknown>>;

    // The catalogue is published by this file (see the lifecycle hooks above),
    // and nothing else is — so the readout distinguishes a flag somebody set
    // from three nobody did, which is the whole point of it carrying reasons.
    expect(report.catalogue).toMatchObject({ audience: 'public', reason: 'configured' });
    expect(report.edge).toMatchObject({ open: false, closedReason: 'not_configured' });
    expect(report.machineCredentialAuth).toMatchObject({ enabled: false });
    expect(report.charging).toMatchObject({ authorized: false, shadowMetering: true });
  });
});

/* -------------------------------------------------------------------------- */
/*  7. The workstream-16 operational metrics                                  */
/* -------------------------------------------------------------------------- */

/**
 * The values themselves are covered against real rows in
 * `services/__tests__/inferenceMetrics.service.test.ts`, including the positive
 * control that flips time-to-first-token from `pending` to `measured`. What is
 * asserted HERE is what the ENDPOINT does: the window it accepts, the window it
 * refuses, and — the load-bearing part — that the two structurally-pending
 * metrics reach the wire as a STATE and not as a zero. A number that survives the
 * service and is flattened to `0` by a serializer is the same lie.
 */
describe('GET /inference/admin/metrics', () => {
  const WINDOW = 'from=2020-01-01&to=2020-01-02';

  it('reports the pending metrics as a state, never as a zero', async () => {
    const response = await request('GET', `${ADMIN}/metrics?${WINDOW}`);

    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;

    expect(data).toMatchObject({ schemaVersion: 1, consistency: 'eventually-consistent' });
    expect(data.window).toEqual({ from: '2020-01-01', to: '2020-01-02' });
    // The cause a reader needs to interpret the two pending metrics below. This
    // process configures no data plane, so nothing can have streamed.
    expect(data.dataPlane).toBe('absent');
    expect(data.dataPlaneExecution).toEqual({
      enabled: false,
      disabledReason: 'not_configured',
    });

    // The two metrics with no data yet. `pending` plus a reason, and NO percentile
    // field at all — because a consumer that found `p50Ms: 0` beside
    // `state: 'pending'` would plot the zero.
    expect(data.timeToFirstTokenMs).toMatchObject({ state: 'pending' });
    expect(data.timeToFirstTokenMs).not.toHaveProperty('p50Ms');
    expect(data.fallback).toMatchObject({ state: 'pending' });
    expect(data.fallback).not.toHaveProperty('totalSwitches');

    // And the same for a rate over no traffic: undefined, not zero.
    expect(data.requests).toMatchObject({ state: 'pending', requestCount: 0 });
    expect(data.requests).not.toHaveProperty('errorRateBps');

    // The scanner's control: `0` does appear in this payload — the pending arms
    // carry row counts — so "no zeros anywhere" is not what was asserted above.
    expect(JSON.stringify(data)).toContain('"rowsCarryingValue":0');
  });

  it('answers every metric workstream 16 names, by name', async () => {
    const response = await request('GET', `${ADMIN}/metrics?${WINDOW}`);
    const data = response.body.data as Record<string, unknown>;

    // A checklist against the epic's own two lines, so a metric quietly dropped
    // from the payload is a red rather than a field nobody notices is gone.
    for (const metric of [
      'requests',
      'totalLatencyMs',
      'timeToFirstTokenMs',
      'fallback',
      'reserveFailures',
      'settlementLagMs',
      'unmeasuredSettlements',
      'reconciliationDrift',
    ]) {
      expect(data).toHaveProperty(metric);
    }
  });

  it('refuses a window it cannot answer instead of truncating it', async () => {
    // Wider than `inference_usage_events`' ninety-day retention: a longer window
    // cannot yield more latency samples, so answering it would be a quiet lie
    // about the range the numbers cover.
    const tooWide = await request('GET', `${ADMIN}/metrics?from=2020-01-01&to=2021-01-01`);
    expect(tooWide.status).toBe(400);

    const backwards = await request('GET', `${ADMIN}/metrics?from=2020-02-01&to=2020-01-01`);
    expect(backwards.status).toBe(400);

    const notADay = await request('GET', `${ADMIN}/metrics?from=2020-1-1&to=2020-01-02`);
    expect(notADay.status).toBe(400);

    // A lexically well-formed day that does not exist. `Date.parse` yields NaN,
    // and the span check then fails closed rather than comparing against it.
    const impossible = await request('GET', `${ADMIN}/metrics?from=2026-02-31&to=2026-03-01`);
    expect(impossible.status).toBe(400);

    // The control for all four: the same route with a window it can answer.
    expect((await request('GET', `${ADMIN}/metrics?${WINDOW}`)).status).toBe(200);
  });

  it('refuses a query field it does not know', async () => {
    // `.strict()`, so a mistyped filter is a 400 rather than a report silently
    // covering every tenant when the caller believed it named one.
    const response = await request('GET', `${ADMIN}/metrics?${WINDOW}&accountid=someone`);
    expect(response.status).toBe(400);
  });

  it('never exposes a wholesale cost, unlike the deployment listing on this mount', async () => {
    const fixture = await insertPendingDeployment();

    // The control, in the same currency as the measurement: this mount DOES serve
    // the wholesale cost, on the route that is meant to.
    const listing = await request('GET', `${ADMIN}/deployments`);
    expect(listing.raw).toContain(fixture.wholesaleAmount);

    const metrics = await request('GET', `${ADMIN}/metrics?${WINDOW}`);
    expect(metrics.raw).not.toContain(fixture.wholesaleAmount);
    expect(metrics.raw).not.toContain('wholesale');
  });
});
