/**
 * The catalogue's publication flag, driving the REAL catalogue router (issue
 * #972 workstream 16, "Rollout").
 *
 * ## The test this file exists for
 *
 * **An unpublished catalogue is withheld from the public audience and served to
 * the internal one, in the same deployment, for the same route.** Both halves
 * matter. A test that only showed the public viewer seeing nothing would pass
 * against an empty database, a broken fixture, or a router that 500s — so every
 * withheld read here is paired with an internal read of the SAME approved
 * deployment that comes back with it.
 *
 * `routes/__tests__/inferenceCatalogueRoute.test.ts` owns the audience rules
 * themselves and runs with the catalogue published; this file owns the flag.
 *
 * ## Fixtures are scoped to ids this file owns
 *
 * One publisher, model, revision, provider and approved deployment per run, with
 * a random suffix, and every assertion looks for that model id specifically — so
 * a sibling suite seeding the shared database cannot make a withheld read look
 * served or the reverse.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

// `jest.setup.cjs` stubs `jsonwebtoken` globally; the internal viewer's service
// token has to be really signed, or `verifyServiceToken` refuses it and every
// "the internal audience still sees it" control here silently measures the
// PUBLIC viewer instead — which is the same answer the flag produces.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import type { ModelCatalogueEntry } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { CATALOGUE_AUDIENCE_VARIABLE } from '../../config/rolloutFlags';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { ensureWorkloadAttributionIdentity } from '../../services/workloadAttributionIdentity.service';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  inferenceRoutingProfileCandidates,
  inferenceRoutingProfiles,
} from '../../db/schema';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { workloadAttestationHandle } from '../../services/workloadAttestation.service';
import catalogueRouter from '../inferenceCatalogue';

jest.setTimeout(60_000);

const MOUNT = '/models';
const TEST_ACCESS_TOKEN_SECRET = 'inference-catalogue-publication-test-secret-at-least-32-chars';

let server: http.Server;

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

function json(response: RawResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function get(path: string, token?: string): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `${MOUNT}${path}`,
        method: 'GET',
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const tag = randomUUID().replace(/-/g, '').slice(0, 10);
const publisherSlug = `pub${tag}`;
const modelSlug = `model-${tag}`;
const providerSlug = `prov${tag}`;
const profileSlug = `profile-${tag}`;
const modelId = `${publisherSlug}/${modelSlug}`;

/** A service token for an INTERNAL application — the privileged audience. */
let internalToken: string;
/**
 * The same audience, reached by an ATTESTED caller: one more internal
 * application, bound to an IAM role, with NO credential row anywhere and a
 * token whose `credentialId` is the binding's attestation handle.
 *
 * This is the shape Alia's pre-deploy readiness task presents (ADR 0026), and
 * the shape that was demoted to the public viewer — which, under the
 * `internal` default this file is about, is served an empty profile list.
 */
let attestedInternalToken: string;
let attestedBindingId: string;

async function seed(): Promise<void> {
  const db = getDb();

  const [account] = await db
    .insert(users)
    .values({ username: `cat-${tag}`, email: `cat-${tag}@example.test` })
    .returning({ id: users.id });

  const [internalApplication] = await db
    .insert(applications)
    .values({
      name: `Internal ${tag}`,
      ownerAccountId: account.id,
      type: 'internal',
      isInternal: true,
      scopes: ['inference:invoke'],
    })
    .returning({ id: applications.id });

  // A signed token alone no longer establishes the internal viewer: the route
  // re-resolves this exact credential id so revocation and application status
  // remain authoritative for the token's lifetime. Seed the live row the real
  // service-token mint requires, otherwise this fixture correctly resolves as
  // public and the publication control below measures the wrong audience.
  const [credential] = await db
    .insert(applicationCredentials)
    .values({
      applicationId: internalApplication.id,
      name: `Internal Catalogue ${tag}`,
      publicKey: `oxy_dk_${tag}`,
      type: 'service',
      environment: 'production',
      scopes: ['inference:invoke'],
      status: 'active',
      createdByUserId: account.id,
    })
    .returning({ id: applicationCredentials.id });

  internalToken = jwt.sign(
    {
      type: 'service',
      appId: internalApplication.id,
      appName: `Internal ${tag}`,
      credentialId: credential.id,
      ownerAccountId: account.id,
      environment: 'production',
      scopes: ['inference:invoke'],
    },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '1h', issuer: 'oxy-auth', audience: 'oxy-api' }
  );

  const [attestedApplication] = await db
    .insert(applications)
    .values({
      name: `Attested Internal ${tag}`,
      ownerAccountId: account.id,
      type: 'internal',
      isInternal: true,
      scopes: ['inference:invoke'],
    })
    .returning({ id: applications.id });

  // No credential row for this one, deliberately. The binding IS its identity.
  const attestedSubject = `arn:aws:iam::237343248947:role/oxy-catalogue-${tag}-task`;
  const [attestedBinding] = await db
    .insert(applicationWorkloadIdentities)
    .values({
      applicationId: attestedApplication.id,
      provider: 'aws-iam',
      subject: attestedSubject,
      description: `publication suite ${tag}`,
      scopes: [],
    })
    .returning({ id: applicationWorkloadIdentities.id });
  attestedBindingId = attestedBinding.id;
  /**
   * Its materialised attribution row, as both production writers produce it.
   * `resolveLiveAgencyWorkloadByHandle` requires the binding→row link, and the
   * mint writes the row before issuing a token that names the handle — so a
   * fixture without it is a state no real caller can be in.
   */
  await ensureWorkloadAttributionIdentity({
    bindingId: attestedBinding.id,
    applicationId: attestedApplication.id,
    subject: attestedSubject,
  });

  attestedInternalToken = jwt.sign(
    {
      type: 'service',
      appId: attestedApplication.id,
      appName: `Attested Internal ${tag}`,
      // Derived, never a literal: the mint's own definition, so this fixture
      // cannot keep passing after the derivation moves.
      credentialId: workloadAttestationHandle(attestedSubject),
      ownerAccountId: account.id,
      environment: 'production',
      scopes: ['inference:invoke'],
    },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '1h', issuer: 'oxy-auth', audience: 'oxy-api' }
  );

  await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: `Pub ${tag}` });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: `Model ${tag}`,
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
    .returning({ id: inferenceModels.id });

  const [revision] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision: '2026-01-01', releasedAt: new Date(), isCurrent: true })
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

  // A PUBLIC, approved route. The public viewer's inability to see it under an
  // unpublished catalogue is therefore the flag's doing and nothing else's.
  await db.insert(inferenceDeployments).values({
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
    legalReviewStatus: 'approved',
    legalReviewedAt: new Date(),
    legalReviewEvidenceRef: `contract-register/${tag}`,
    permissionState: 'approved',
  });

  // A profile with no candidate is omitted by `listRoutingProfiles` — the
  // schema requires at least one — so the fixture carries the model above.
  const [profile] = await db
    .insert(inferenceRoutingProfiles)
    .values({
      slug: profileSlug,
      displayName: `Profile ${tag}`,
      description: 'A published routing profile.',
      optimiseFor: 'balanced',
      isProductPreset: false,
    })
    .returning({ id: inferenceRoutingProfiles.id });

  await db.insert(inferenceRoutingProfileCandidates).values({
    routingProfileId: profile.id,
    modelId: model.id,
    priority: 1,
  });
}

function entryIds(body: Record<string, unknown>, key: 'data' | 'models'): string[] {
  return (body[key] as ModelCatalogueEntry[]).map((entry) => entry.modelId);
}

const ORIGINAL = process.env[CATALOGUE_AUDIENCE_VARIABLE];
const ORIGINAL_ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;

beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = TEST_ACCESS_TOKEN_SECRET;
  await connectPostgres();
  await seed();
  const app = express();
  app.use(express.json());
  app.use(MOUNT, catalogueRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  if (ORIGINAL === undefined) delete process.env[CATALOGUE_AUDIENCE_VARIABLE];
  else process.env[CATALOGUE_AUDIENCE_VARIABLE] = ORIGINAL;
  if (ORIGINAL_ACCESS_TOKEN_SECRET === undefined) delete process.env.ACCESS_TOKEN_SECRET;
  else process.env.ACCESS_TOKEN_SECRET = ORIGINAL_ACCESS_TOKEN_SECRET;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await closePostgres();
});

beforeEach(() => {
  delete process.env[CATALOGUE_AUDIENCE_VARIABLE];
});

/* -------------------------------------------------------------------------- */

describe('an unpublished catalogue is the default', () => {
  it('serves the public viewer an empty list, and the internal viewer the same route', async () => {
    const anonymous = await get('/');
    expect(anonymous.status).toBe(200);
    expect(entryIds(json(anonymous), 'data')).not.toContain(modelId);

    // The control. Same deployment, same request, one audience apart — so the
    // empty read above is the flag and not an empty or broken fixture.
    const internal = await get('/', internalToken);
    expect(entryIds(json(internal), 'data')).toContain(modelId);
  });

  it('404s the detail read for the public viewer, exactly as an unavailable model does', async () => {
    const anonymous = await get(`/${publisherSlug}/${modelSlug}`);
    expect(anonymous.status).toBe(404);

    const internal = await get(`/${publisherSlug}/${modelSlug}`, internalToken);
    expect(internal.status).toBe(200);
  });

  it('withholds the routing profiles too — they are published objects, not internals', async () => {
    const anonymous = await get('/routing-profiles');
    expect(anonymous.status).toBe(200);
    expect(json(anonymous).count).toBe(0);

    const internal = await get('/routing-profiles', internalToken);
    expect(Number(json(internal).count)).toBeGreaterThan(0);
  });

  /**
   * The production defect, stated as a test.
   *
   * Alia mints by attestation, reads `GET /models/routing-profiles` in its
   * pre-deploy readiness task, and reported `missingCount: 8` — every chat
   * routing profile in its `config/oxy-inference-routing-profile-ids.ts`,
   * invisible, with a 200 and no error. `agents.ready` was true in the same run,
   * so the readiness gate was working; this was the one thing it found.
   *
   * Three callers, one deployment, one flag position. The anonymous read is the
   * empty answer the attested caller was wrongly given; the credential-minted
   * internal token is the answer it should have had all along.
   */
  it('serves the routing profiles to an ATTESTED internal caller, exactly as to a credential-minted one', async () => {
    const anonymous = await get('/routing-profiles');
    expect(json(anonymous).count).toBe(0);

    const credentialMinted = await get('/routing-profiles', internalToken);
    expect(Number(json(credentialMinted).count)).toBeGreaterThan(0);

    const attested = await get('/routing-profiles', attestedInternalToken);
    expect(attested.status).toBe(200);
    expect(Number(json(attested).count)).toBe(Number(json(credentialMinted).count));
  });

  it('withholds them again from the same attested token once its binding expires', async () => {
    // The control: it is served first, so the withholding below is the binding's
    // expiry and not a fixture that never worked.
    expect(Number(json(await get('/routing-profiles', attestedInternalToken)).count)).toBeGreaterThan(0);

    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(applicationWorkloadIdentities.id, attestedBindingId));
    try {
      const withheld = await get('/routing-profiles', attestedInternalToken);
      expect(withheld.status).toBe(200);
      expect(json(withheld).count).toBe(0);
    } finally {
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ expiresAt: null })
        .where(eq(applicationWorkloadIdentities.id, attestedBindingId));
    }
  });

  it('keeps Console’s /stats envelope while withholding its contents', async () => {
    const anonymous = json(await get('/stats'));
    // The envelope Console parses is unchanged; only what is in it differs.
    expect(anonymous).toMatchObject({ count: expect.any(Number) });
    expect(typeof anonymous.timestamp).toBe('string');
    expect(entryIds(anonymous, 'models')).not.toContain(modelId);
  });
});

describe('publishing the catalogue serves the same route to everyone', () => {
  beforeEach(() => {
    process.env[CATALOGUE_AUDIENCE_VARIABLE] = 'public';
  });

  it('lists it, serves its detail, and lists the routing profiles', async () => {
    expect(entryIds(json(await get('/')), 'data')).toContain(modelId);
    expect((await get(`/${publisherSlug}/${modelSlug}`)).status).toBe(200);
    expect(Number(json(await get('/routing-profiles')).count)).toBeGreaterThan(0);
    expect(entryIds(json(await get('/stats')), 'models')).toContain(modelId);
  });

  it('is not reached by an unreadable value, which falls back to withholding', async () => {
    process.env[CATALOGUE_AUDIENCE_VARIABLE] = 'everyone';

    expect(entryIds(json(await get('/')), 'data')).not.toContain(modelId);
    expect(entryIds(json(await get('/')), 'data')).toEqual(
      expect.not.arrayContaining([modelId])
    );
  });
});
