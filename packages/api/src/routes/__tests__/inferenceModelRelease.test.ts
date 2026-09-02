/**
 * Ingesting a signed model release, and reading a revision's documentation
 * (issue #972 §12).
 *
 * ## What each claim here is paired against
 *
 * A staff gate is the easiest thing to test for the wrong reason: an unmounted,
 * broken or 500ing route refuses an ungranted caller just as convincingly as a
 * guarded one. So every refusal is paired with the SAME request made by a staff
 * user who holds the capability, and asserted on the guard's own message.
 *
 * The "the public documentation view withholds the Annex XI Section 2 fields"
 * claim is paired with a read of the ROW showing those values are present. A
 * scanner over an empty payload reports the same clean result as one over a
 * correct projection.
 *
 * The sharpest claim in the file is that `manifest_json` holds the bytes that
 * ARRIVED rather than the parsed document. Its fixture deliberately omits
 * `knownLimitations`, which `modelSafetyMetadataSchema` defaults to `[]` — so a
 * route that stored `JSON.stringify(parsedBody.manifest)` would store a key the
 * signer never wrote, and the assertion names that key.
 */

import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

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

import { and, eq } from 'drizzle-orm';
import { modelSafetyMetadataSchema } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  inferenceDeployments,
  inferenceModelEvaluations,
  inferenceModelGpaiDocumentation,
  inferenceModelReleaseArtifacts,
  inferenceModelReleaseSignatures,
  inferenceModelReleases,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
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

const STAFF_REFUSAL = {
  error: 'Forbidden',
  message: 'This operation requires Oxy platform staff privileges',
};

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
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
          resolve({ status: res.statusCode ?? 0, body: parsed });
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

function digest(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reserve the first-party namespace, as `scripts/seed-inference-catalogue.ts`
 * does in production.
 *
 * `onConflictDoNothing` rather than a try/catch: another suite in this worker's
 * database may have seeded it already, and swallowing every error here would
 * also swallow a real one.
 */
async function reservePublisher(slug: string): Promise<void> {
  await getDb()
    .insert(inferencePublishers)
    .values({ slug, displayName: 'Release Fixture Pub' })
    .onConflictDoNothing();
}

const CAPABILITIES = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  tools: true,
  parallelToolCalls: false,
  structuredOutput: true,
  jsonMode: true,
  reasoning: false,
  streaming: true,
  promptCaching: false,
  maxContextTokens: 200_000,
  maxOutputTokens: 8192,
};

/** The non-exempt documentation record: every conditional field required. */
const DOCUMENTATION = {
  intendedTasks: 'Text generation and tool calling.',
  distributionMethods: ['oxy_api'],
  architecture: 'Decoder-only transformer',
  parameterCount: 70_000_000_000,
  trainingDataSummaryUrl: 'https://alia.onl/training-data-summary',
  copyrightPolicyUrl: 'https://alia.onl/copyright-policy',
  systemicRisk: 'presumed_by_training_compute',
  freeAndOpenSourceRelease: false,
  trainingComputeFlops: '4.2e25',
  trainingTimeHours: 41_600,
  energyConsumptionMwh: 3_820,
  adversarialTestingReportUrl: 'https://alia.onl/red-team-report',
};

interface ManifestOptions {
  readonly publisher: string;
  readonly modelSlug: string;
  readonly revision: string;
  readonly releaseId?: string;
  readonly licenseId?: string;
  /**
   * Omitted by DEFAULT, which is the point of the raw-capture assertion — the
   * contract defaults it to `[]`, so its absence from the stored bytes proves
   * the parsed document was not what got stored.
   */
  readonly knownLimitations?: readonly string[];
}

function manifestFor(options: ManifestOptions) {
  const modelId = `${options.publisher}/${options.modelSlug}`;
  return {
    schemaVersion: 1,
    releaseId: options.releaseId ?? `arel_${suffix()}`,
    issuedAt: '2026-08-16T12:00:00.000Z',
    revision: {
      schemaVersion: 1,
      revisionId: `rev_${suffix()}`,
      modelId,
      revision: options.revision,
      reference: `${modelId}@${options.revision}`,
      releasedAt: '2026-08-16T12:00:00.000Z',
      artifactDigest: digest('b'),
      modelCardUrl: 'https://alia.onl/models/card',
      evaluations: [{ suite: 'mmlu-pro', metric: 'accuracy', score: '71.2%' }],
      safety: {
        safetyCardUrl: 'https://alia.onl/models/safety',
        contentFilteringDefault: 'strict',
        provenanceMarking: 'none',
        ...(options.knownLimitations === undefined
          ? {}
          : { knownLimitations: [...options.knownLimitations] }),
      },
    },
    provenance: { releaseKind: 'first_party_original', trainingOrganization: 'Alia' },
    license: {
      licenseId: options.licenseId ?? 'LicenseRef-Alia-1.0',
      displayName: 'Alia licence 1.0',
      commercialUseAllowed: true,
      requiresAttribution: false,
    },
    artifacts: [
      { path: 'model.safetensors', digest: digest('b'), sizeBytes: 9_876_543_210 },
      { path: 'tokenizer.json', digest: digest('c'), sizeBytes: 1_842_311 },
    ],
    signatures: [
      {
        algorithm: 'ed25519',
        canonicalization: 'jcs',
        keyId: `alia-release-${suffix()}`,
        signature: 'A'.repeat(86),
        signedAt: '2026-08-16T12:00:05.000Z',
      },
    ],
  };
}

function ingestionBody(options: ManifestOptions) {
  return {
    schemaVersion: 1,
    manifest: manifestFor(options),
    gpaiDocumentation: DOCUMENTATION,
    model: { displayName: 'Release Fixture Model', capabilities: CAPABILITIES },
  };
}

/**
 * Every fixture publishes under `alia`, because `aliaModelReleaseManifestSchema`
 * refuses any other namespace and that refusal is not what this file tests.
 * Independence comes from a per-test MODEL slug and a per-test revision label
 * instead, so no assertion here depends on a table being empty.
 */
const ALIA = 'alia';

async function seedStaffUser(
  staffCapabilities: readonly StaffCapability[] = ['inference:catalogue:publish']
): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      username: `rel-${suffix()}`,
      isStaff: true,
      staffCapabilities: [...staffCapabilities],
    })
    .returning({ id: users.id });
  return row.id;
}

/** Make an ingested revision reachable from the customer catalogue. */
async function publishRevision(modelId: string, revisionLabel: string): Promise<void> {
  const db = getDb();
  const providerSlug = `rprv${suffix()}`;

  const [model] = await db
    .select({ id: inferenceModels.id })
    .from(inferenceModels)
    .where(eq(inferenceModels.modelId, modelId));

  const [revision] = await db
    .select({ id: inferenceModelRevisions.id })
    .from(inferenceModelRevisions)
    .where(
      and(
        eq(inferenceModelRevisions.modelId, model.id),
        eq(inferenceModelRevisions.revision, revisionLabel)
      )
    );

  // Ingestion writes `is_current = false` on purpose. Promoting a revision is a
  // publication decision the ingest deliberately does not take, so the fixture
  // takes it explicitly — which is also the assertion's control.
  await db
    .update(inferenceModelRevisions)
    .set({ isCurrent: true })
    .where(eq(inferenceModelRevisions.id, revision.id));

  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: 'Release Fixture Provider',
    kind: 'oxy_hosted',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

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
    legalReviewEvidenceRef: `contract-register/${suffix()}`,
    permissionState: 'approved',
    internalRouteId: `kaana-route-${suffix()}`,
  });
}

const ORIGINAL_CATALOGUE_AUDIENCE = process.env.INFERENCE_CATALOGUE_AUDIENCE;

beforeAll(async () => {
  process.env.INFERENCE_CATALOGUE_AUDIENCE = 'public';
  await connectPostgres();
  await reservePublisher(ALIA);
  const app = express();
  app.use(express.json());
  app.use(ADMIN, adminRouter);
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

describe('POST /inference/admin/model-releases', () => {
  it('accepts a model card, licence, provenance, evaluations, safety and every artifact digest', async () => {
    const modelSlug = `m${suffix()}`;
    const revision = `r${suffix()}`;
    const body = ingestionBody({ publisher: ALIA, modelSlug, revision });

    const response = await request('POST', `${ADMIN}/model-releases`, body);
    expect(response.status).toBe(201);

    const data = response.body.data as Record<string, unknown>;
    expect(data.reference).toBe(`${ALIA}/${modelSlug}@${revision}`);
    expect(data.outcome).toBe('ingested');
    expect(data.artifactCount).toBe(2);
    expect(data.signatureCount).toBe(1);
    expect(data.evaluationCount).toBe(1);

    const db = getDb();
    const [model] = await db
      .select({
        id: inferenceModels.id,
        licenseId: inferenceModels.licenseId,
        releaseKind: inferenceModels.releaseKind,
        trainingOrganization: inferenceModels.trainingOrganization,
        maxContextTokens: inferenceModels.maxContextTokens,
      })
      .from(inferenceModels)
      .where(eq(inferenceModels.modelId, `${ALIA}/${modelSlug}`));

    // Licence and provenance come from the SIGNED manifest; the capability sheet
    // comes from the request beside it, because a manifest carries none.
    expect(model.licenseId).toBe('LicenseRef-Alia-1.0');
    expect(model.releaseKind).toBe('first_party_original');
    expect(model.trainingOrganization).toBe('Alia');
    expect(model.maxContextTokens).toBe(200_000);

    const [revisionRow] = await db
      .select({
        id: inferenceModelRevisions.id,
        isCurrent: inferenceModelRevisions.isCurrent,
        modelCardUrl: inferenceModelRevisions.modelCardUrl,
        artifactDigest: inferenceModelRevisions.artifactDigest,
        contentFilteringDefault: inferenceModelRevisions.contentFilteringDefault,
        provenanceMarking: inferenceModelRevisions.provenanceMarking,
        safetyCardUrl: inferenceModelRevisions.safetyCardUrl,
      })
      .from(inferenceModelRevisions)
      .where(
        and(
          eq(inferenceModelRevisions.modelId, model.id),
          eq(inferenceModelRevisions.revision, revision)
        )
      );

    expect(revisionRow.modelCardUrl).toBe('https://alia.onl/models/card');
    expect(revisionRow.artifactDigest).toBe(digest('b'));
    expect(revisionRow.contentFilteringDefault).toBe('strict');
    expect(revisionRow.provenanceMarking).toBe('none');
    expect(revisionRow.safetyCardUrl).toBe('https://alia.onl/models/safety');

    // Ingesting is not publishing.
    expect(revisionRow.isCurrent).toBe(false);

    const evaluations = await db
      .select({ suite: inferenceModelEvaluations.suite, score: inferenceModelEvaluations.score })
      .from(inferenceModelEvaluations)
      .where(eq(inferenceModelEvaluations.modelRevisionId, revisionRow.id));
    expect(evaluations).toEqual([{ suite: 'mmlu-pro', score: '71.2%' }]);

    const [release] = await db
      .select({
        id: inferenceModelReleases.id,
        releaseId: inferenceModelReleases.releaseId,
        ingestedByUserId: inferenceModelReleases.ingestedByUserId,
      })
      .from(inferenceModelReleases)
      .where(eq(inferenceModelReleases.modelRevisionId, revisionRow.id));

    expect(release.releaseId).toBe(body.manifest.releaseId);
    expect(release.ingestedByUserId).toBe(currentUserId);

    // "digests", PLURAL: the whole signed inventory, not only the served one.
    const artifacts = await db
      .select({ path: inferenceModelReleaseArtifacts.path, digest: inferenceModelReleaseArtifacts.digest })
      .from(inferenceModelReleaseArtifacts)
      .where(eq(inferenceModelReleaseArtifacts.releaseId, release.id));
    expect(artifacts.map((row) => row.digest).sort()).toEqual([digest('b'), digest('c')].sort());

    const signatures = await db
      .select({ keyId: inferenceModelReleaseSignatures.keyId })
      .from(inferenceModelReleaseSignatures)
      .where(eq(inferenceModelReleaseSignatures.releaseId, release.id));
    expect(signatures).toHaveLength(1);

    const [documentation] = await db
      .select({
        systemicRisk: inferenceModelGpaiDocumentation.systemicRisk,
        trainingComputeFlops: inferenceModelGpaiDocumentation.trainingComputeFlops,
        parameterCount: inferenceModelGpaiDocumentation.parameterCount,
        recordedByUserId: inferenceModelGpaiDocumentation.recordedByUserId,
      })
      .from(inferenceModelGpaiDocumentation)
      .where(eq(inferenceModelGpaiDocumentation.modelRevisionId, revisionRow.id));

    expect(documentation.systemicRisk).toBe('presumed_by_training_compute');
    expect(documentation.trainingComputeFlops).toBe('4.2e25');
    expect(documentation.parameterCount).toBe(70_000_000_000);
    expect(documentation.recordedByUserId).toBe(currentUserId);
  });

  it('stores the manifest as RECEIVED, not as parsed', async () => {
    const modelSlug = `m${suffix()}`;
    const revision = `r${suffix()}`;
    const body = ingestionBody({ publisher: ALIA, modelSlug, revision });

    // Control: the contract really does add this key, so its absence below is a
    // fact about the stored bytes and not about the fixture.
    expect(
      modelSafetyMetadataSchema.parse(body.manifest.revision.safety).knownLimitations
    ).toEqual([]);

    await request('POST', `${ADMIN}/model-releases`, body);

    const [release] = await getDb()
      .select({ manifestJson: inferenceModelReleases.manifestJson })
      .from(inferenceModelReleases)
      .where(eq(inferenceModelReleases.releaseId, body.manifest.releaseId));

    expect(JSON.parse(release.manifestJson)).toEqual(body.manifest);
    expect(release.manifestJson).not.toContain('knownLimitations');
  });

  it('is idempotent on the release id, and creates no second revision', async () => {
    const modelSlug = `m${suffix()}`;
    const revision = `r${suffix()}`;
    const releaseId = `arel_${suffix()}`;
    const body = ingestionBody({ publisher: ALIA, modelSlug, revision, releaseId });

    const first = await request('POST', `${ADMIN}/model-releases`, body);
    expect(first.status).toBe(201);

    const replay = await request('POST', `${ADMIN}/model-releases`, body);
    expect(replay.status).toBe(200);
    expect((replay.body.data as Record<string, unknown>).outcome).toBe('already_ingested');

    const [model] = await getDb()
      .select({ id: inferenceModels.id })
      .from(inferenceModels)
      .where(eq(inferenceModels.modelId, `${ALIA}/${modelSlug}`));

    const revisions = await getDb()
      .select({ id: inferenceModelRevisions.id })
      .from(inferenceModelRevisions)
      .where(eq(inferenceModelRevisions.modelId, model.id));
    expect(revisions).toHaveLength(1);
  });

  it('refuses a different release that reuses a revision label', async () => {
    const modelSlug = `m${suffix()}`;
    const revision = `r${suffix()}`;
    await request('POST', `${ADMIN}/model-releases`, ingestionBody({ publisher: ALIA, modelSlug, revision }));

    const second = await request(
      'POST',
      `${ADMIN}/model-releases`,
      ingestionBody({ publisher: ALIA, modelSlug, revision })
    );
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain('already in the catalogue');
  });

  it('refuses a manifest that disagrees with the licence on record', async () => {
    const modelSlug = `m${suffix()}`;
    await request(
      'POST',
      `${ADMIN}/model-releases`,
      ingestionBody({ publisher: ALIA, modelSlug, revision: `r${suffix()}` })
    );

    const relicensed = await request(
      'POST',
      `${ADMIN}/model-releases`,
      ingestionBody({
        publisher: ALIA,
        modelSlug,
        revision: `r${suffix()}`,
        licenseId: 'LicenseRef-Alia-2.0',
      })
    );
    expect(relicensed.status).toBe(409);
    expect(String(relicensed.body.message)).toContain('licence');
  });

  it('refuses a documentation record the AI Act would not accept', async () => {
    const body = {
      ...ingestionBody({ publisher: ALIA, modelSlug: `m${suffix()}`, revision: `r${suffix()}` }),
      gpaiDocumentation: { ...DOCUMENTATION, systemicRisk: 'not_designated' },
    };
    const response = await request('POST', `${ADMIN}/model-releases`, body);
    expect(response.status).toBe(400);
  });

  it('requires the publish capability, not merely staff', async () => {
    const body = ingestionBody({ publisher: ALIA, modelSlug: `m${suffix()}`, revision: `r${suffix()}` });

    currentUserId = await seedStaffUser([]);
    const refused = await request('POST', `${ADMIN}/model-releases`, body);
    expect(refused.status).toBe(403);
    expect(String(refused.body.message)).toContain('inference:catalogue:publish');

    // Paired: the SAME body, from a caller who holds it. Without this the 403
    // above would be satisfied by a route that refuses everybody.
    currentUserId = await seedStaffUser();
    const accepted = await request('POST', `${ADMIN}/model-releases`, body);
    expect(accepted.status).toBe(201);
  });

  it('refuses a caller who is not staff at all', async () => {
    currentUserIsStaff = false;
    const response = await request(
      'POST',
      `${ADMIN}/model-releases`,
      ingestionBody({ publisher: ALIA, modelSlug: `m${suffix()}`, revision: `r${suffix()}` })
    );
    expect(response.status).toBe(403);
    expect(response.body).toEqual(STAFF_REFUSAL);
  });
});

describe('PUT /inference/admin/revisions/:revisionId/gpai-documentation', () => {
  async function ingestAndReadRevisionId(modelSlug: string, revision: string): Promise<string> {
    await request(
      'POST',
      `${ADMIN}/model-releases`,
      ingestionBody({ publisher: ALIA, modelSlug, revision })
    );
    const [model] = await getDb()
      .select({ id: inferenceModels.id })
      .from(inferenceModels)
      .where(eq(inferenceModels.modelId, `${ALIA}/${modelSlug}`));
    const [row] = await getDb()
      .select({ id: inferenceModelRevisions.id })
      .from(inferenceModelRevisions)
      .where(
        and(
          eq(inferenceModelRevisions.modelId, model.id),
          eq(inferenceModelRevisions.revision, revision)
        )
      );
    return row.id;
  }

  it('records a later Commission designation without a new release', async () => {
    const revisionId = await ingestAndReadRevisionId(`m${suffix()}`, `r${suffix()}`);

    const response = await request('PUT', `${ADMIN}/revisions/${revisionId}/gpai-documentation`, {
      ...DOCUMENTATION,
      systemicRisk: 'designated_by_commission',
    });
    expect(response.status).toBe(200);

    const [row] = await getDb()
      .select({ systemicRisk: inferenceModelGpaiDocumentation.systemicRisk })
      .from(inferenceModelGpaiDocumentation)
      .where(eq(inferenceModelGpaiDocumentation.modelRevisionId, revisionId));
    expect(row.systemicRisk).toBe('designated_by_commission');
  });

  it('replaces the record rather than merging into it', async () => {
    const revisionId = await ingestAndReadRevisionId(`m${suffix()}`, `r${suffix()}`);

    // An exempt record: the Annex XI fields are legitimately absent. If this were
    // a merge, the previous statement's `architecture` would survive.
    const response = await request('PUT', `${ADMIN}/revisions/${revisionId}/gpai-documentation`, {
      distributionMethods: ['downloadable_weights'],
      trainingDataSummaryUrl: 'https://alia.onl/oss-training-data-summary',
      copyrightPolicyUrl: 'https://alia.onl/copyright-policy',
      systemicRisk: 'not_designated',
      freeAndOpenSourceRelease: true,
    });
    expect(response.status).toBe(200);

    const [row] = await getDb()
      .select({
        architecture: inferenceModelGpaiDocumentation.architecture,
        parameterCount: inferenceModelGpaiDocumentation.parameterCount,
        trainingComputeFlops: inferenceModelGpaiDocumentation.trainingComputeFlops,
        systemicRisk: inferenceModelGpaiDocumentation.systemicRisk,
      })
      .from(inferenceModelGpaiDocumentation)
      .where(eq(inferenceModelGpaiDocumentation.modelRevisionId, revisionId));

    expect(row.architecture).toBeNull();
    expect(row.parameterCount).toBeNull();
    expect(row.trainingComputeFlops).toBeNull();
    expect(row.systemicRisk).toBe('not_designated');
  });

  it('404s a revision that does not exist, and requires the publish capability', async () => {
    const missing = await request(
      'PUT',
      `${ADMIN}/revisions/rev_nothing/gpai-documentation`,
      DOCUMENTATION
    );
    expect(missing.status).toBe(404);

    currentUserId = await seedStaffUser([]);
    const refused = await request(
      'PUT',
      `${ADMIN}/revisions/rev_nothing/gpai-documentation`,
      DOCUMENTATION
    );
    expect(refused.status).toBe(403);
  });
});

describe('GET /models/:publisher/:model/documentation', () => {
  async function ingestAndPublish(): Promise<{ modelId: string; revision: string }> {
    const modelSlug = `m${suffix()}`;
    const revision = `r${suffix()}`;
    await request(
      'POST',
      `${ADMIN}/model-releases`,
      ingestionBody({ publisher: ALIA, modelSlug, revision })
    );
    const modelId = `${ALIA}/${modelSlug}`;
    await publishRevision(modelId, revision);
    return { modelId, revision };
  }

  it('serves the documentation of the revision a customer pinned', async () => {
    const { modelId, revision } = await ingestAndPublish();

    const response = await request(
      'GET',
      `${MODELS}/${modelId}/documentation?revision=${revision}`
    );
    expect(response.status).toBe(200);

    const data = response.body.data as Record<string, unknown>;
    expect(data.reference).toBe(`${modelId}@${revision}`);
    expect(data.modelCardUrl).toBe('https://alia.onl/models/card');
    expect(data.artifactDigest).toBe(digest('b'));
    expect(data.evaluations).toEqual([
      { suite: 'mmlu-pro', metric: 'accuracy', score: '71.2%' },
    ]);
    expect(data.safety).toEqual({
      safetyCardUrl: 'https://alia.onl/models/safety',
      contentFilteringDefault: 'strict',
      knownLimitations: [],
      provenanceMarking: 'none',
    });
    expect((data.license as Record<string, unknown>).licenseId).toBe('LicenseRef-Alia-1.0');
    expect((data.provenance as Record<string, unknown>).releaseKind).toBe('first_party_original');
  });

  it('withholds the Annex XI Section 2 documentation, and the row has it to withhold', async () => {
    const { modelId, revision } = await ingestAndPublish();

    const response = await request(
      'GET',
      `${MODELS}/${modelId}/documentation?revision=${revision}`
    );
    const gpai = (response.body.data as Record<string, unknown>).gpai as Record<string, unknown>;

    // Present: the Annex XII set a downstream provider is entitled to.
    expect(gpai.intendedTasks).toBe('Text generation and tool calling.');
    expect(gpai.parameterCount).toBe(70_000_000_000);
    expect(gpai.trainingDataSummaryUrl).toBe('https://alia.onl/training-data-summary');
    expect(gpai.copyrightPolicyUrl).toBe('https://alia.onl/copyright-policy');
    expect(gpai.systemicRisk).toBe('presumed_by_training_compute');

    // Absent: Annex XI Section 2 and Article 55(1)(a).
    expect(gpai).not.toHaveProperty('trainingComputeFlops');
    expect(gpai).not.toHaveProperty('trainingTimeHours');
    expect(gpai).not.toHaveProperty('energyConsumptionMwh');
    expect(gpai).not.toHaveProperty('adversarialTestingReportUrl');

    // Positive control: the values are IN the row. Without this the four
    // assertions above would pass just as well against a record that never
    // stored them.
    expect(JSON.stringify(response.body)).not.toContain('4.2e25');
    const [row] = await getDb()
      .select({
        trainingComputeFlops: inferenceModelGpaiDocumentation.trainingComputeFlops,
        adversarialTestingReportUrl: inferenceModelGpaiDocumentation.adversarialTestingReportUrl,
      })
      .from(inferenceModelGpaiDocumentation)
      .innerJoin(
        inferenceModelRevisions,
        eq(inferenceModelGpaiDocumentation.modelRevisionId, inferenceModelRevisions.id)
      )
      .where(eq(inferenceModelRevisions.revision, revision));
    expect(row.trainingComputeFlops).toBe('4.2e25');
    expect(row.adversarialTestingReportUrl).toBe('https://alia.onl/red-team-report');
  });

  it('answers for the CURRENT revision when none is named', async () => {
    const { modelId, revision } = await ingestAndPublish();

    const response = await request('GET', `${MODELS}/${modelId}/documentation`);
    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;
    expect(data.revision).toBe(revision);
    expect(data.isCurrentRevision).toBe(true);
  });

  it('404s a revision that does not exist on a model the viewer can see', async () => {
    const { modelId } = await ingestAndPublish();
    const response = await request('GET', `${MODELS}/${modelId}/documentation?revision=nope`);
    expect(response.status).toBe(404);
  });

  it('404s a model with no offerable route, identically to one that does not exist', async () => {
    // Ingested but never published: no deployment, so no viewer may select it.
    const modelSlug = `m${suffix()}`;
    const revision = `r${suffix()}`;
    await request(
      'POST',
      `${ADMIN}/model-releases`,
      ingestionBody({ publisher: ALIA, modelSlug, revision })
    );

    const unpublished = await request(
      'GET',
      `${MODELS}/${ALIA}/${modelSlug}/documentation?revision=${revision}`
    );
    const absent = await request('GET', `${MODELS}/${ALIA}/nothing-here/documentation`);

    expect(unpublished.status).toBe(404);
    expect(absent.status).toBe(404);
  });

  it('refuses a revision label that is not one', async () => {
    const { modelId } = await ingestAndPublish();
    const response = await request('GET', `${MODELS}/${modelId}/documentation?revision=${'a/b'}`);
    expect(response.status).toBe(400);
  });
});
