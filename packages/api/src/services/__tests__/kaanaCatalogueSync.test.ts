/**
 * The Kaana → Oxy catalogue sync, against a REAL Postgres.
 *
 * Every fixture id carries a random suffix, and every assertion is scoped to
 * the model lines this file creates. The sync's retirement step reads every
 * synced deployment in the database, so `beforeEach` retires the synced rows
 * this file left behind: no other suite writes a synced row.
 */

import { randomUUID } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  KAANA_SYNC_AUTO_APPROVAL_POLICY_ID,
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  priceVersionUnitPrices,
  priceVersions,
} from '../../db/schema';
import {
  CATALOGUED,
  PUBLIC_CATALOGUE_VIEWER,
  UNCONSTRAINED_EDGE_CAPACITY,
  UNCONSTRAINED_ROUTING,
  TEXT_COMPLETION_MODALITY,
  listCatalogueForViewer,
  resolveCatalogueViewer,
  resolveEdgeRoute,
} from '../inferenceCatalogue.service';
import type { KaanaCatalogueReader } from '../httpKaanaClient';
import {
  assessInferenceRoutingReadiness,
  earliestInferenceRoutingEvidenceExpiry,
  readInferenceRoutingReadinessRows,
} from '../inferenceRoutingReadiness.service';
import {
  type KaanaDeploymentDescriptor,
  SYNCED_LICENSE,
  blockCatalogueModel,
  intersectAcceptedParameters,
  normalizeAcceptedParameters,
  normalizeDecimal,
  parseKaanaCatalogue,
  planKaanaModel,
  reviewedRoutesWanted,
  runKaanaCatalogueSync,
  syncedPriceScore,
  syncedUnitPrices,
  unblockCatalogueModel,
  withReviewedRoutes,
} from '../kaanaCatalogueSync.service';
import {
  KAANA_REVIEWED_PROVIDER_ROUTES,
  indexReviewedProviderRoutes,
  type ReviewedProviderRoute,
} from '../../config/kaanaReviewedProviderRoutes';
import {
  FUNDING_EVIDENCE_TTL_MS,
  type CredentialEconomicsReader,
  type CredentialEconomicsResponse,
} from '../kaanaCredentialEconomics.service';
import { firstUnacceptedParameter, requestParametersOf } from '../inferenceCatalogue.service';

jest.setTimeout(60_000);

const INTERNAL_VIEWER = resolveCatalogueViewer({ type: 'internal', isInternal: true });

const suffix = (): string => randomUUID().replace(/-/g, '').slice(0, 10);

interface WireModel {
  readonly model: string;
  readonly modelReference: string;
  readonly [key: string]: unknown;
}

interface WireRoute {
  readonly deploymentId: string;
  readonly provider: string;
  readonly modelReference: string;
  readonly regions?: string[];
  /** Kaana's per-deployment statement, when the descriptor carries one. */
  readonly acceptedParameters?: string[];
}

/** A reader serving a fixed body and attesting exactly the routes it is given. */
function reader(models: readonly WireModel[], routes: readonly WireRoute[]): KaanaCatalogueReader {
  return {
    listModels: async () => ({
      contractVersion: '3.1.0',
      checkedAt: new Date().toISOString(),
      configuration: { snapshotId: 'snap_test' },
      servesUnpinned: true,
      models,
      pinnedOnlyReferences: [],
    }),
    attestDeployments: async (ids) => ({
      snapshotId: 'snap_test',
      deployments: routes
        .filter((route) => ids.includes(route.deploymentId))
        .map((route) => ({
          deploymentId: route.deploymentId,
          provider: route.provider,
          modelReference: route.modelReference,
          regions: route.regions ?? [],
          ...(route.acceptedParameters === undefined
            ? {}
            : { acceptedParameters: route.acceptedParameters }),
        })),
    }),
    listPublishedDeployments: async () => ({
      snapshotId: 'snap_test',
      deployments: routes.map((route) => ({
        deploymentId: route.deploymentId,
        provider: route.provider,
        modelReference: route.modelReference,
        regions: route.regions ?? [],
      })),
    }),
  };
}

interface World {
  readonly tag: string;
  readonly provider: string;
  readonly publisher: string;
  line(name: string): string;
  entry(name: string, overrides?: Record<string, unknown>): WireModel;
  route(name: string): WireRoute;
}

async function makeWorld(): Promise<World> {
  const tag = suffix();
  const provider = `prov${tag}`;
  const publisher = `pub${tag}`;
  await getDb()
    .insert(inferenceProviders)
    .values({
      slug: provider,
      displayName: `Provider ${tag}`,
      kind: 'third_party',
      retainsPayloads: true,
      retentionDays: 30,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      policyUrl: 'https://example.test/privacy',
    });
  const line = (name: string): string => `${publisher}/${name}`;
  const reference = (name: string): string => `${line(name)}@observed-2026-09-25`;
  const deploymentId = (name: string): string => `dep_${tag}_${name}`;
  return {
    tag,
    provider,
    publisher,
    line,
    entry: (name, overrides = {}) => ({
      model: line(name),
      modelReference: reference(name),
      providers: [provider],
      displayName: `Test: ${name}`,
      createdAt: '2025-08-05T17:17:11.000Z',
      contextTokens: 131072,
      maxOutputTokens: 32768,
      inputModalities: ['image', 'text'],
      outputModalities: ['text'],
      supportsTools: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      listPrices: [
        {
          deploymentId: deploymentId(name),
          provider,
          currency: 'USD',
          input: '0.072',
          output: '0.28',
        },
      ],
      ...overrides,
    }),
    route: (name) => ({
      deploymentId: deploymentId(name),
      provider,
      modelReference: reference(name),
      regions: ['us-east-1'],
    }),
  };
}

async function deploymentsOf(modelIdValue: string) {
  return getDb()
    .select({
      id: inferenceDeployments.id,
      internalRouteId: inferenceDeployments.internalRouteId,
      status: inferenceDeployments.status,
      permissionState: inferenceDeployments.permissionState,
      availabilityScope: inferenceDeployments.availabilityScope,
      commercialPermission: inferenceDeployments.commercialPermission,
      autoApprovalPolicyId: inferenceDeployments.autoApprovalPolicyId,
      priceVersionId: inferenceDeployments.priceVersionId,
      regions: inferenceDeployments.regions,
      retentionDays: inferenceDeployments.retentionDays,
      acceptedParameters: inferenceDeployments.acceptedParameters,
    })
    .from(inferenceDeployments)
    .innerJoin(
      inferenceModelRevisions,
      eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id),
    )
    .innerJoin(inferenceModels, eq(inferenceModelRevisions.modelId, inferenceModels.id))
    .where(eq(inferenceModels.modelId, modelIdValue));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  await getDb()
    .update(inferenceDeployments)
    .set({ status: 'retired', permissionState: 'retired' })
    .where(eq(inferenceDeployments.autoApprovalPolicyId, KAANA_SYNC_AUTO_APPROVAL_POLICY_ID));
});

afterAll(async () => {
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/*  Pure parsing and planning                                                  */
/* -------------------------------------------------------------------------- */

describe('parsing Kaana’s catalogue', () => {
  it('reads the exact wire shape Kaana publishes', () => {
    const parsed = parseKaanaCatalogue({
      contractVersion: '3.1.0',
      configuration: { snapshotId: 'snap_1' },
      models: [
        {
          model: 'stub/model',
          modelReference: 'stub/model@2026-05-01',
          providers: ['stub'],
          displayName: 'Stub: Model',
          createdAt: '2025-08-05T17:17:11.000Z',
          contextTokens: 131072,
          maxOutputTokens: 32768,
          inputModalities: ['image', 'text'],
          outputModalities: ['text'],
          supportsTools: true,
          reasoningEfforts: ['low', 'medium', 'high'],
          listPrices: [
            {
              deploymentId: 'dep_stub',
              provider: 'stub',
              currency: 'USD',
              input: '0.072',
              output: '0.28',
            },
          ],
        },
        // Only the identity: every optional field absent.
        { model: 'bare/model', modelReference: 'bare/model@r1', providers: ['stub'] },
        { model: 'Not A Model', modelReference: 'x' },
      ],
    });
    expect(parsed.snapshotId).toBe('snap_1');
    expect(parsed.invalidEntries).toBe(1);
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[0].listPrices).toEqual([
      { deploymentId: 'dep_stub', provider: 'stub', price: { input: '0.072', output: '0.28' } },
    ]);
    expect(parsed.models[1].listPrices).toEqual([]);
  });

  it('refuses a body that is not a catalogue at all', () => {
    expect(() => parseKaanaCatalogue({ error: 'nope' })).toThrow(
      'Kaana returned a catalogue body Oxy cannot read (models:',
    );
  });

  it('keeps decimals exact and refuses anything that is not one', () => {
    expect(normalizeDecimal('0.2800')).toBe('0.28');
    expect(normalizeDecimal('15')).toBe('15');
    expect(normalizeDecimal(0.5)).toBe('0.5');
    expect(normalizeDecimal('-1')).toBeUndefined();
    expect(normalizeDecimal('1e-7')).toBeUndefined();
    expect(normalizeDecimal(1e-7)).toBeUndefined();
    expect(normalizeDecimal('0.0000000000001')).toBeUndefined();
  });

  it('ranks cheaper routes higher', () => {
    expect(syncedPriceScore({ input: '0.1', output: '0.2' })).toBeGreaterThan(
      syncedPriceScore({ input: '3', output: '15' }),
    );
  });
});

describe('planning one model line', () => {
  const base = parseKaanaCatalogue({
    models: [
      {
        model: 'acme/chat',
        modelReference: 'acme/chat@r1',
        contextTokens: 1000,
        maxOutputTokens: 500,
        inputModalities: ['text'],
        outputModalities: ['text'],
        reasoningEfforts: ['high', 'low', 'turbo'],
        listPrices: [
          { deploymentId: 'dep_a', provider: 'p1', currency: 'USD', input: '1', output: '2' },
        ],
      },
    ],
  }).models[0];
  const attested = new Map([
    [
      'dep_a',
      { deploymentId: 'dep_a', provider: 'p1', modelReference: 'acme/chat@r1', regions: [] },
    ],
  ]);
  const context = { blocked: new Set<string>(), knownProviders: new Set(['p1']), attested };

  it('plans a describable line, keeping only known efforts in order', () => {
    const plan = planKaanaModel(base, context);
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.model.reasoningEfforts).toEqual(['low', 'high']);
    expect(plan.model.displayName).toBe('chat');
    expect(plan.model.routes).toHaveLength(1);
  });

  it.each([
    ['missing_context_tokens', { contextTokens: undefined }],
    ['missing_max_output_tokens', { maxOutputTokens: undefined }],
    ['missing_modalities', { inputModalities: undefined }],
    ['non_text_output_unreviewed', { outputModalities: ['text', 'image'] }],
    ['no_priced_route', { listPrices: [] }],
  ] as const)('skips %s rather than inventing a value', (reason, overrides) => {
    const plan = planKaanaModel({ ...base, ...overrides }, context);
    expect(plan).toMatchObject({ status: 'skipped', reason });
  });

  it('skips the reserved alia namespace and a blocked line', () => {
    expect(
      planKaanaModel({ ...base, model: 'alia/chat', modelReference: 'alia/chat@r1' }, context),
    ).toMatchObject({ status: 'skipped', reason: 'reserved_namespace' });
    expect(planKaanaModel(base, { ...context, blocked: new Set(['acme/chat']) })).toMatchObject({
      status: 'skipped',
      reason: 'blocked',
    });
  });

  it('skips a route on a provider Oxy holds no data policy for, or that Kaana did not attest', () => {
    expect(planKaanaModel(base, { ...context, knownProviders: new Set() })).toMatchObject({
      status: 'skipped',
      reason: 'no_priced_route',
      routeSkips: ['unknown_provider'],
    });
    expect(planKaanaModel(base, { ...context, attested: new Map() })).toMatchObject({
      status: 'skipped',
      reason: 'no_priced_route',
      routeSkips: ['unattested_route'],
    });
  });

  describe('accepted request parameters', () => {
    const TWO_PROVIDER_LINE = parseKaanaCatalogue({
      models: [
        {
          model: 'acme/chat',
          modelReference: 'acme/chat@r1',
          providers: ['p1', 'p2'],
          contextTokens: 1000,
          maxOutputTokens: 500,
          inputModalities: ['text'],
          outputModalities: ['text'],
          acceptedParameters: ['maxOutputTokens', 'tools'],
          listPrices: [
            { deploymentId: 'dep_a', provider: 'p1', currency: 'USD', input: '1', output: '2' },
            { deploymentId: 'dep_b', provider: 'p2', currency: 'USD', input: '1', output: '2' },
          ],
        },
      ],
    }).models[0];
    const twoAttested = new Map<string, KaanaDeploymentDescriptor>([
      [
        'dep_a',
        { deploymentId: 'dep_a', provider: 'p1', modelReference: 'acme/chat@r1', regions: [] },
      ],
      [
        'dep_b',
        { deploymentId: 'dep_b', provider: 'p2', modelReference: 'acme/chat@r1', regions: [] },
      ],
    ]);
    const acceptedOf = (plan: ReturnType<typeof planKaanaModel>) =>
      plan.status === 'planned'
        ? plan.model.routes.map((route) => route.acceptedParameters)
        : undefined;

    it('normalizes into Oxy vocabulary order, dropping unknown words, and keeps absent as unknown', () => {
      expect(normalizeAcceptedParameters(undefined)).toBeNull();
      expect(normalizeAcceptedParameters([])).toEqual([]);
      expect(
        normalizeAcceptedParameters([
          'tools',
          'sampling.topK',
          'sampling.temperature',
          'maxOutputTokens',
          'tools',
        ]),
      ).toEqual(['maxOutputTokens', 'sampling.temperature', 'tools']);
    });

    it('attributes a single-provider line’s set to its route', () => {
      const entry = {
        ...base,
        providers: ['p1'],
        acceptedParameters: ['tools', 'maxOutputTokens'],
      };
      expect(acceptedOf(planKaanaModel(entry, context))).toEqual([['maxOutputTokens', 'tools']]);
    });

    it('leaves the route unknown when the line reported nothing or names no providers', () => {
      expect(acceptedOf(planKaanaModel({ ...base, providers: ['p1'] }, context))).toEqual([null]);
      expect(
        acceptedOf(planKaanaModel({ ...base, acceptedParameters: ['tools'] }, context)),
      ).toEqual([null]);
    });

    it('never pins a multi-provider intersection on any one route', () => {
      // The intersection proves what every reporter accepts, not what any one
      // of them refuses; narrowing a route on it could refuse a servable request.
      const plan = planKaanaModel(TWO_PROVIDER_LINE, {
        ...context,
        knownProviders: new Set(['p1', 'p2']),
        attested: twoAttested,
      });
      expect(acceptedOf(plan)).toEqual([null, null]);
    });

    it('prefers the deployment’s own attested set', () => {
      const attested = new Map(twoAttested);
      attested.set('dep_b', {
        deploymentId: 'dep_b',
        provider: 'p2',
        modelReference: 'acme/chat@r1',
        regions: [],
        acceptedParameters: ['sampling.temperature', 'maxOutputTokens'],
      });
      const plan = planKaanaModel(TWO_PROVIDER_LINE, {
        ...context,
        knownProviders: new Set(['p1', 'p2']),
        attested,
      });
      expect(acceptedOf(plan)).toEqual([null, ['maxOutputTokens', 'sampling.temperature']]);
    });
  });

  it('refuses a non-USD price rather than converting it', () => {
    const eur = parseKaanaCatalogue({
      models: [
        {
          ...base,
          listPrices: [
            { deploymentId: 'dep_a', provider: 'p1', currency: 'EUR', input: '1', output: '2' },
          ],
        },
      ],
    }).models[0];
    expect(planKaanaModel(eur, context)).toMatchObject({
      status: 'skipped',
      routeSkips: ['invalid_list_price'],
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Applying against Postgres                                                 */
/* -------------------------------------------------------------------------- */

describe('syncing into the catalogue', () => {
  it('writes a routable, internal-only, priced route for a new model line', async () => {
    const world = await makeWorld();
    const summary = await runKaanaCatalogueSync({
      reader: reader([world.entry('alpha')], [world.route('alpha')]),
    });
    expect(summary).toMatchObject({ status: 'synced', snapshotId: 'snap_test' });
    expect(summary.models.created).toBe(1);
    expect(summary.deployments.created).toBe(1);

    const [model] = await getDb()
      .select()
      .from(inferenceModels)
      .where(eq(inferenceModels.modelId, world.line('alpha')));
    expect(model).toMatchObject({
      catalogueSource: 'kaana_sync',
      displayName: 'Test: alpha',
      maxContextTokens: 131072,
      maxOutputTokens: 32768,
      reasoningEfforts: ['low', 'medium', 'high'],
      supportsReasoning: true,
      licenseId: SYNCED_LICENSE.licenseId,
      commercialUseAllowed: false,
      releaseKind: 'third_party_hosted',
    });
    expect(model.providerReleasedAt?.toISOString()).toBe('2025-08-05T17:17:11.000Z');

    const [deployment] = await deploymentsOf(world.line('alpha'));
    expect(deployment).toMatchObject({
      internalRouteId: world.route('alpha').deploymentId,
      status: 'active',
      permissionState: 'approved',
      availabilityScope: 'platform_internal',
      commercialPermission: 'standard_application_use',
      autoApprovalPolicyId: 'kaana-sync',
      // The attested region set, and the provider's own data policy.
      regions: ['us-east-1'],
      retentionDays: 30,
    });

    const units = await getDb()
      .select({ unit: priceVersionUnitPrices.unit, amount: priceVersionUnitPrices.amount })
      .from(priceVersionUnitPrices)
      .where(eq(priceVersionUnitPrices.priceVersionId, deployment.priceVersionId ?? ''));
    expect(
      Object.fromEntries(units.map((row) => [row.unit, normalizeDecimal(row.amount)])),
    ).toEqual({
      input_tokens: '0.072',
      cached_input_tokens: '0.072',
      output_tokens: '0.28',
      reasoning_tokens: '0.28',
      requests: '0',
    });

    // The edge can route it for an official application, ranked on price...
    const resolved = await resolveEdgeRoute(
      INTERNAL_VIEWER,
      world.line('alpha'),
      UNCONSTRAINED_ROUTING,
      TEXT_COMPLETION_MODALITY,
      'price',
      UNCONSTRAINED_EDGE_CAPACITY,
      undefined,
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      route: {
        deploymentId: world.route('alpha').deploymentId,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    });

    // ...and the readiness census the daily expiry monitor runs accepts it at a
    // seven-day horizon: a price score has no expiry cliff (issue #1379).
    const census = (await readInferenceRoutingReadinessRows()).filter(
      (row) => row.deploymentId === world.route('alpha').deploymentId,
    );
    expect(census).toHaveLength(1);
    expect(census[0].synced).toBe(true);
    const now = new Date();
    expect(
      assessInferenceRoutingReadiness(
        census,
        now,
        new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      ),
    ).toEqual({ status: 'ready' });
    expect(earliestInferenceRoutingEvidenceExpiry(census)).toBeUndefined();

    // ...and it is listed internally with its efforts and release date, never publicly.
    const internal = (await listCatalogueForViewer(INTERNAL_VIEWER, CATALOGUED)).find(
      (entry) => entry.modelId === world.line('alpha'),
    );
    expect(internal?.capabilities.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(internal?.releasedAt).toBe('2025-08-05T17:17:11.000Z');
    expect(internal?.availabilityScope).toBe('platform_internal');
    expect(
      (await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER, CATALOGUED)).some(
        (entry) => entry.modelId === world.line('alpha'),
      ),
    ).toBe(false);
  });

  it('stores a route’s accepted parameters, keeps them current and lets the edge read them', async () => {
    const world = await makeWorld();
    await runKaanaCatalogueSync({
      reader: reader(
        [world.entry('params', { acceptedParameters: ['tools', 'maxOutputTokens'] })],
        [world.route('params')],
      ),
    });
    const [stored] = await deploymentsOf(world.line('params'));
    expect(stored.acceptedParameters).toEqual(['maxOutputTokens', 'tools']);
    const resolved = await resolveEdgeRoute(
      INTERNAL_VIEWER,
      world.line('params'),
      UNCONSTRAINED_ROUTING,
      TEXT_COMPLETION_MODALITY,
      'price',
      UNCONSTRAINED_EDGE_CAPACITY,
      undefined,
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      route: { acceptedParameters: ['maxOutputTokens', 'tools'] },
    });

    // A later report that says nothing makes the route unknown again, never `[]`.
    await runKaanaCatalogueSync({
      reader: reader([world.entry('params')], [world.route('params')]),
    });
    const [cleared] = await deploymentsOf(world.line('params'));
    expect(cleared.acceptedParameters).toBeNull();
  });

  it('is idempotent: an unchanged report writes no new price or scorecard', async () => {
    const world = await makeWorld();
    const serve = reader([world.entry('beta')], [world.route('beta')]);
    const first = await runKaanaCatalogueSync({ reader: serve });
    expect(first.priceVersionsCreated).toBe(1);
    expect(first.scorecardsWritten).toBe(1);
    const second = await runKaanaCatalogueSync({ reader: serve });
    expect(second.models.created).toBe(0);
    expect(second.deployments.created).toBe(0);
    expect(second.deployments.upserted).toBe(1);
    expect(second.priceVersionsCreated).toBe(0);
    expect(second.scorecardsWritten).toBe(0);
  });

  it('supersedes a price version when the list price changes, and re-points route and scorecard', async () => {
    const world = await makeWorld();
    await runKaanaCatalogueSync({ reader: reader([world.entry('gamma')], [world.route('gamma')]) });
    const [before] = await deploymentsOf(world.line('gamma'));
    const changed = world.entry('gamma', {
      listPrices: [
        {
          deploymentId: world.route('gamma').deploymentId,
          provider: world.provider,
          currency: 'USD',
          input: '0.1',
          output: '0.4',
        },
      ],
    });
    const summary = await runKaanaCatalogueSync({
      reader: reader([changed], [world.route('gamma')]),
    });
    expect(summary.priceVersionsCreated).toBe(1);
    const [after] = await deploymentsOf(world.line('gamma'));
    expect(after.priceVersionId).not.toBe(before.priceVersionId);

    const versions = await getDb()
      .select({
        id: priceVersions.id,
        status: priceVersions.status,
        supersedes: priceVersions.supersedesPriceVersionId,
      })
      .from(priceVersions)
      .where(inArray(priceVersions.id, [before.priceVersionId ?? '', after.priceVersionId ?? '']));
    expect(versions.find((row) => row.id === before.priceVersionId)?.status).toBe('superseded');
    expect(versions.find((row) => row.id === after.priceVersionId)).toMatchObject({
      status: 'active',
      supersedes: before.priceVersionId,
    });

    const [card] = await getDb()
      .select({ priceVersionId: inferenceDeploymentRoutingScores.priceVersionId })
      .from(inferenceDeploymentRoutingScores)
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, world.route('gamma').deploymentId));
    expect(card.priceVersionId).toBe(after.priceVersionId);
    const events = await getDb()
      .select({ id: inferenceDeploymentRoutingScoreEvents.id })
      .from(inferenceDeploymentRoutingScoreEvents)
      .where(
        eq(inferenceDeploymentRoutingScoreEvents.deploymentId, world.route('gamma').deploymentId),
      );
    expect(events).toHaveLength(2);
  });

  it('retires a route Kaana stops reporting, and withholds a mass retirement unless confirmed', async () => {
    const world = await makeWorld();
    const names = ['d1', 'd2', 'd3'];
    await runKaanaCatalogueSync({
      reader: reader(
        names.map((name) => world.entry(name)),
        names.map((name) => world.route(name)),
      ),
    });

    const dropOne = await runKaanaCatalogueSync({
      reader: reader(
        [world.entry('d1'), world.entry('d2')],
        [world.route('d1'), world.route('d2')],
      ),
    });
    expect(dropOne.deployments.retired).toBe(1);
    const [gone] = await deploymentsOf(world.line('d3'));
    expect(gone).toMatchObject({ status: 'retired', permissionState: 'retired' });
    expect(
      await resolveEdgeRoute(
        INTERNAL_VIEWER,
        world.line('d3'),
        UNCONSTRAINED_ROUTING,
        TEXT_COMPLETION_MODALITY,
        'price',
        UNCONSTRAINED_EDGE_CAPACITY,
        undefined,
      ),
    ).toMatchObject({ status: 'unknown-model' });

    // A report naming only an unrelated line would retire both remaining
    // routes — more than half — so it is presumed broken.
    const other = await makeWorld();
    const withheld = await runKaanaCatalogueSync({
      reader: reader([other.entry('solo')], [other.route('solo')]),
    });
    expect(withheld.deployments.retired).toBe(0);
    expect(withheld.deployments.retirementWithheld).toBe(2);
    expect((await deploymentsOf(world.line('d1')))[0].status).toBe('active');

    const confirmed = await runKaanaCatalogueSync({
      reader: reader([other.entry('solo')], [other.route('solo')]),
      allowMassRetirement: true,
    });
    expect(confirmed.deployments.retired).toBe(2);
  });

  it('refuses to sync an empty report', async () => {
    await expect(runKaanaCatalogueSync({ reader: reader([], []) })).rejects.toThrow(
      'empty catalogue',
    );
  });

  it('blocks a line immediately and brings it back only after the block is lifted', async () => {
    const world = await makeWorld();
    const serve = reader(
      [world.entry('eps'), world.entry('keep')],
      [world.route('eps'), world.route('keep')],
    );
    await runKaanaCatalogueSync({ reader: serve });

    const blocked = await blockCatalogueModel({
      modelId: world.line('eps'),
      reason: 'incident test',
      userId: null,
    });
    expect(blocked).toEqual({ created: true, retired: 1 });
    expect((await deploymentsOf(world.line('eps')))[0].status).toBe('retired');

    const whileBlocked = await runKaanaCatalogueSync({ reader: serve });
    expect(whileBlocked.models.skipped.blocked).toBe(1);
    expect((await deploymentsOf(world.line('eps')))[0].status).toBe('retired');

    expect(await unblockCatalogueModel(world.line('eps'))).toBe(true);
    await runKaanaCatalogueSync({ reader: serve });
    const [revived] = await deploymentsOf(world.line('eps'));
    expect(revived).toMatchObject({ status: 'active', permissionState: 'approved' });
  });

  it('never rewrites a reviewed model, beyond keeping its efforts current', async () => {
    const world = await makeWorld();
    const db = getDb();
    await db
      .insert(inferencePublishers)
      .values({ slug: world.publisher, displayName: 'Reviewed Publisher' });
    await db.insert(inferenceModels).values({
      publisherSlug: world.publisher,
      slug: 'reviewed',
      displayName: 'Reviewed Model',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsParallelToolCalls: false,
      supportsStructuredOutput: true,
      supportsJsonMode: true,
      supportsReasoning: true,
      supportsStreaming: true,
      supportsPromptCaching: true,
      maxContextTokens: 1000,
      maxOutputTokens: 500,
      licenseId: 'Apache-2.0',
      licenseDisplayName: 'Apache License 2.0',
      commercialUseAllowed: true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    });

    const summary = await runKaanaCatalogueSync({
      reader: reader([world.entry('reviewed')], [world.route('reviewed')]),
    });
    expect(summary.models.reviewedUntouched).toBe(1);
    const [model] = await db
      .select()
      .from(inferenceModels)
      .where(
        and(
          eq(inferenceModels.publisherSlug, world.publisher),
          eq(inferenceModels.slug, 'reviewed'),
        ),
      );
    expect(model).toMatchObject({
      catalogueSource: 'reviewed',
      displayName: 'Reviewed Model',
      licenseId: 'Apache-2.0',
      commercialUseAllowed: true,
      maxContextTokens: 1000,
      reasoningEfforts: ['low', 'medium', 'high'],
    });
    expect(await deploymentsOf(world.line('reviewed'))).toHaveLength(0);
  });

  it('counts, and does not write, lines it cannot describe', async () => {
    const world = await makeWorld();
    const summary = await runKaanaCatalogueSync({
      reader: reader(
        [
          world.entry('ok'),
          world.entry('nomax', { maxOutputTokens: undefined }),
          world.entry('image', { outputModalities: ['image'] }),
          world.entry('unpriced', { listPrices: undefined }),
        ],
        [world.route('ok'), world.route('nomax'), world.route('image'), world.route('unpriced')],
      ),
    });
    expect(summary.models.synced).toBe(1);
    expect(summary.models.skipped).toMatchObject({
      missing_max_output_tokens: 1,
      non_text_output_unreviewed: 1,
      no_priced_route: 1,
    });
    for (const name of ['nomax', 'image', 'unpriced']) {
      expect(await deploymentsOf(world.line(name))).toHaveLength(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Routes whose provider's model list publishes no price (OxyHQ/Kaana#166)    */
/* -------------------------------------------------------------------------- */

describe('reviewed provider routes', () => {
  const line = parseKaanaCatalogue({
    models: [
      {
        model: 'acme/chat',
        modelReference: 'acme/chat@r1',
        providers: ['direct', 'router'],
        contextTokens: 1000,
        maxOutputTokens: 500,
        inputModalities: ['text'],
        outputModalities: ['text'],
        listPrices: [
          {
            deploymentId: 'dep_router',
            provider: 'router',
            currency: 'USD',
            input: '3',
            output: '15',
          },
        ],
      },
    ],
  });
  const direct: ReviewedProviderRoute = {
    provider: 'direct',
    model: 'acme/chat',
    upstreamModelId: 'chat-1',
    price: { input: '2', cachedInput: '0.1', output: '10' },
    priceEvidenceRef: 'https://example.test/pricing@2026-10-11',
    acceptedParameters: ['maxOutputTokens', 'tools'],
  };
  const reviewed = indexReviewedProviderRoutes([direct]);
  const published = {
    deployments: [
      {
        deploymentId: 'dep_router',
        provider: 'router',
        modelReference: 'acme/chat@r1',
        regions: [],
      },
      {
        deploymentId: 'dep_direct',
        provider: 'direct',
        modelReference: 'acme/chat@r1',
        regions: [],
      },
      // Another revision of the line, and another line: never named.
      {
        deploymentId: 'dep_direct_old',
        provider: 'direct',
        modelReference: 'acme/chat@r0',
        regions: [],
      },
      {
        deploymentId: 'dep_other',
        provider: 'direct',
        modelReference: 'acme/other@r1',
        regions: [],
      },
    ],
  };

  it('names the exact published deployment of a reviewed provider and line, with the reviewed price', () => {
    expect(reviewedRoutesWanted(line, reviewed)).toBe(true);
    const [entry] = withReviewedRoutes(line, published, reviewed).models;
    expect(entry.listPrices).toEqual([
      { deploymentId: 'dep_router', provider: 'router', price: { input: '3', output: '15' } },
      {
        deploymentId: 'dep_direct',
        provider: 'direct',
        price: { input: '2', cachedInput: '0.1', output: '10' },
        priceEvidenceRef: 'https://example.test/pricing@2026-10-11',
      },
    ]);
  });

  it('never prices a provider Kaana already prices, or one the line does not name', () => {
    const kaanaPriced = parseKaanaCatalogue({
      models: [
        {
          ...line.models[0],
          listPrices: [
            {
              deploymentId: 'dep_direct',
              provider: 'direct',
              currency: 'USD',
              input: '9',
              output: '9',
            },
          ],
        },
      ],
    });
    expect(reviewedRoutesWanted(kaanaPriced, reviewed)).toBe(false);
    expect(withReviewedRoutes(kaanaPriced, published, reviewed)).toEqual(kaanaPriced);

    const notServed = { ...line, models: [{ ...line.models[0], providers: ['router'] }] };
    expect(reviewedRoutesWanted(notServed, reviewed)).toBe(false);
    expect(withReviewedRoutes(notServed, published, reviewed)).toEqual(notServed);

    // A reviewed price is never borrowed from another provider of the line.
    expect(reviewedRoutesWanted(line, indexReviewedProviderRoutes([]))).toBe(false);
  });

  it('plans the reviewed route with its cache-read price and intersects its controls with Kaana’s', () => {
    const entry = withReviewedRoutes(line, published, reviewed).models[0];
    const attested = new Map<string, KaanaDeploymentDescriptor>([
      ['dep_router', { ...published.deployments[0] }],
      [
        'dep_direct',
        { ...published.deployments[1], acceptedParameters: ['sampling.temperature', 'tools'] },
      ],
    ]);
    const plan = planKaanaModel(entry, {
      blocked: new Set(),
      knownProviders: new Set(['direct', 'router']),
      attested,
      reviewed,
    });
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    const byProvider = new Map(plan.model.routes.map((route) => [route.provider, route]));
    expect(byProvider.get('direct')).toMatchObject({
      deploymentId: 'dep_direct',
      price: { input: '2', cachedInput: '0.1', output: '10' },
      priceEvidenceRef: 'https://example.test/pricing@2026-10-11',
      // Kaana said temperature and tools; the review says maxOutputTokens and tools.
      acceptedParameters: ['tools'],
    });
    // The other provider of the line is untouched by the review.
    expect(byProvider.get('router')?.acceptedParameters).toBeNull();
    expect(
      Object.fromEntries(
        syncedUnitPrices(
          byProvider.get('direct')?.price ?? { input: 'missing', output: 'missing' },
        ).map((unit) => [unit.unit, unit.amount]),
      ),
    ).toEqual({
      cached_input_tokens: '0.1',
      input_tokens: '2',
      output_tokens: '10',
      reasoning_tokens: '10',
      requests: '0',
    });
  });

  it('combines accepted-parameter statements as Kaana combines a line: unknown abstains', () => {
    expect(intersectAcceptedParameters(null, null)).toBeNull();
    expect(intersectAcceptedParameters(null, ['tools'])).toEqual(['tools']);
    expect(intersectAcceptedParameters(['tools', 'maxOutputTokens'], null)).toEqual([
      'maxOutputTokens',
      'tools',
    ]);
    expect(intersectAcceptedParameters(['tools', 'maxOutputTokens'], ['maxOutputTokens'])).toEqual([
      'maxOutputTokens',
    ]);
    expect(intersectAcceptedParameters(['tools'], [])).toEqual([]);
  });

  it('combines tool-choice values, never leaving the field to read as every value', () => {
    // A statement naming the field alone (Kaana before OxyHQ/Kaana#168, or a
    // provider that names only `tool_choice`) takes every value…
    expect(intersectAcceptedParameters(['toolChoice', 'tools'], null)).toEqual([
      'toolChoice',
      'toolChoice.function',
      'toolChoice.none',
      'toolChoice.required',
      'tools',
    ]);
    // …and so narrows nothing a per-value statement says.
    expect(
      intersectAcceptedParameters(
        ['toolChoice', 'tools'],
        ['toolChoice', 'toolChoice.none', 'tools'],
      ),
    ).toEqual(['toolChoice', 'toolChoice.none', 'tools']);
    // Two routes sharing no value share no tool choice: the field goes too.
    expect(
      intersectAcceptedParameters(
        ['toolChoice', 'toolChoice.none', 'tools'],
        ['toolChoice', 'toolChoice.required', 'tools'],
      ),
    ).toEqual(['tools']);
  });
});

describe('the reviewed Anthropic routes (OxyHQ/Kaana#166)', () => {
  const byLine = new Map(KAANA_REVIEWED_PROVIDER_ROUTES.map((route) => [route.model, route]));

  it('covers exactly the thirteen lines Kaana attributes to direct Anthropic deployments', () => {
    expect(() => indexReviewedProviderRoutes()).not.toThrow();
    expect(KAANA_REVIEWED_PROVIDER_ROUTES.every((route) => route.provider === 'anthropic')).toBe(
      true,
    );
    expect([...byLine.keys()].sort()).toEqual(
      [
        'anthropic/claude-fable-5.1',
        'anthropic/claude-fable-5',
        'anthropic/claude-opus-5.5',
        'anthropic/claude-opus-5',
        'anthropic/claude-opus-4.8',
        'anthropic/claude-opus-4.7',
        'anthropic/claude-opus-4.6',
        'anthropic/claude-opus-4.5',
        'anthropic/claude-sonnet-5.5',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-sonnet-4.6',
        'anthropic/claude-haiku-5.5',
        'anthropic/claude-haiku-4.5',
      ].sort(),
    );
  });

  it('pins Anthropic’s list prices as read on 2026-10-11 (input / cache read / output per MTok)', () => {
    const prices = Object.fromEntries(
      KAANA_REVIEWED_PROVIDER_ROUTES.map((route) => [
        route.model.replace('anthropic/claude-', ''),
        `${route.price.input}/${route.price.cachedInput}/${route.price.output}`,
      ]),
    );
    expect(prices).toEqual({
      'fable-5.1': '10/0.25/50',
      'fable-5': '10/1/50',
      'opus-5.5': '4/0.2/20',
      'opus-5': '5/0.5/25',
      'opus-4.8': '5/0.5/25',
      'opus-4.7': '5/0.5/25',
      'opus-4.6': '5/0.5/25',
      'opus-4.5': '5/0.5/25',
      'sonnet-5.5': '2/0.1/10',
      'sonnet-5': '2/0.2/10',
      'sonnet-4.6': '3/0.3/15',
      // The over-100,000-token tier: never less than Anthropic invoices.
      'haiku-5.5': '0.5/0.05/2.5',
      'haiku-4.5': '1/0.1/5',
    });
    for (const route of KAANA_REVIEWED_PROVIDER_ROUTES) {
      for (const amount of Object.values(route.price)) {
        expect(normalizeDecimal(amount)).toBe(amount);
      }
      expect(route.priceEvidenceRef).toBe(
        'https://platform.claude.com/docs/en/about-claude/pricing@2026-10-11',
      );
    }
  });

  it('states only controls the Messages adapter sends and Anthropic accepts per model', () => {
    for (const route of KAANA_REVIEWED_PROVIDER_ROUTES) {
      // Kaana's Translate refuses these for every Anthropic deployment.
      for (const refused of [
        'responseFormat',
        'sampling.frequencyPenalty',
        'sampling.presencePenalty',
        'sampling.seed',
      ] as const) {
        expect(route.acceptedParameters).not.toContain(refused);
      }
      expect(route.acceptedParameters).toEqual(
        normalizeAcceptedParameters([...route.acceptedParameters]),
      );
      expect(route.acceptedParameters).toEqual(
        expect.arrayContaining(['maxOutputTokens', 'sampling.stopSequences', 'tools']),
      );
    }
    const accepts = (model: string, control: string) =>
      (byLine.get(`anthropic/claude-${model}`)?.acceptedParameters ?? []).includes(
        control as never,
      );
    // Non-default temperature/top_p: 400 on Claude Opus 4.7 and every later model.
    for (const model of [
      'opus-4.7',
      'opus-4.8',
      'opus-5',
      'opus-5.5',
      'fable-5',
      'fable-5.1',
      'sonnet-5',
      'sonnet-5.5',
      'haiku-5.5',
    ]) {
      expect([
        model,
        accepts(model, 'sampling.temperature'),
        accepts(model, 'sampling.topP'),
      ]).toEqual([model, false, false]);
    }
    for (const model of ['opus-4.5', 'opus-4.6', 'sonnet-4.6', 'haiku-4.5']) {
      expect([
        model,
        accepts(model, 'sampling.temperature'),
        accepts(model, 'sampling.topP'),
      ]).toEqual([model, true, true]);
    }
    // Forced tool_choice (`any`/`tool`): 400 on Fable 5.1, Opus 5.5 and Sonnet
    // 5.5 only; every model takes `none`, and `auto` needs no value.
    for (const model of byLine.keys()) {
      const short = model.replace('anthropic/claude-', '');
      const forced = !['fable-5.1', 'opus-5.5', 'sonnet-5.5'].includes(short);
      expect([
        short,
        accepts(short, 'toolChoice'),
        accepts(short, 'toolChoice.none'),
        accepts(short, 'toolChoice.required'),
        accepts(short, 'toolChoice.function'),
      ]).toEqual([short, true, true, forced, forced]);
    }
    const opus = [...(byLine.get('anthropic/claude-opus-5.5')?.acceptedParameters ?? [])];
    // So a tool request with `auto` runs on the direct Opus 5.5 route…
    expect(
      firstUnacceptedParameter(
        opus,
        requestParametersOf({
          operation: { kind: 'completion' },
          sampling: {},
          tools: [{}],
          toolChoice: 'auto',
        }),
      ),
    ).toBeUndefined();
    // …and a forced one never does.
    expect(
      firstUnacceptedParameter(
        opus,
        requestParametersOf({
          operation: { kind: 'completion' },
          sampling: {},
          tools: [{}],
          toolChoice: { type: 'function' },
        }),
      ),
    ).toBe('toolChoice.function');
    expect(accepts('haiku-4.5', 'reasoning.effort')).toBe(false);
    // So a request with temperature for Sonnet 5.5 can never be signed onto the direct route.
    expect(
      firstUnacceptedParameter(
        [...(byLine.get('anthropic/claude-sonnet-5.5')?.acceptedParameters ?? [])],
        ['maxOutputTokens', 'sampling.temperature'],
      ),
    ).toBe('sampling.temperature');
  });
});

describe('syncing a direct provider beside a paid one', () => {
  /** One credential-economics read: `keys` per provider, described as stated. */
  function economics(
    keys: Record<string, { category: string | null; evidence?: unknown[] }[]>,
  ): CredentialEconomicsReader {
    const response: CredentialEconomicsResponse = {
      schemaVersion: 1,
      credentials: Object.entries(keys).flatMap(([provider, list]) =>
        list.map((key, index) => ({
          provider,
          keyId: `key-${provider}-${index}`,
          keyClass: '',
          description:
            key.category === null ? null : { revision: 1, capacityCategory: key.category },
          capacityEvidence: (key.evidence ?? []) as never,
        })),
      ),
    };
    return { read: async () => response };
  }

  interface DirectWorld {
    readonly line: string;
    readonly direct: string;
    readonly router: string;
    readonly directDeployment: string;
    readonly routerDeployment: string;
    readonly reviewedRoutes: readonly ReviewedProviderRoute[];
    serve(): KaanaCatalogueReader;
  }

  /**
   * A line served by a paid router that publishes a list price and a direct
   * provider that publishes none, like OpenRouter and Anthropic for a Claude
   * line. The router's row is zero-retention (Kaana binds OpenRouter to ZDR);
   * the direct provider's row retains for 30 days, as Anthropic's does.
   */
  async function directWorld(
    options: { readonly realAnthropic?: boolean } = {},
  ): Promise<DirectWorld> {
    const tag = suffix();
    const router = `rt${tag}`;
    const direct = options.realAnthropic === true ? 'anthropic' : `dr${tag}`;
    await getDb()
      .insert(inferenceProviders)
      .values({
        slug: router,
        displayName: `Router ${tag}`,
        kind: 'third_party',
        retainsPayloads: false,
        retentionDays: 0,
        trainsOnCustomerData: false,
        zeroDataRetentionAvailable: true,
      });
    if (options.realAnthropic !== true) {
      await getDb()
        .insert(inferenceProviders)
        .values({
          slug: direct,
          displayName: `Direct ${tag}`,
          kind: 'third_party',
          retainsPayloads: true,
          retentionDays: 30,
          trainsOnCustomerData: false,
          zeroDataRetentionAvailable: true,
        });
    }
    const model = options.realAnthropic === true ? 'anthropic/claude-sonnet-5.5' : `pub${tag}/chat`;
    const reference = `${model}@observed-2026-10-11`;
    const directDeployment = `dep_${direct}_${tag}`;
    const routerDeployment = `dep_${router}`;
    const reviewedRoutes: readonly ReviewedProviderRoute[] =
      options.realAnthropic === true
        ? KAANA_REVIEWED_PROVIDER_ROUTES
        : [
            {
              provider: direct,
              model,
              upstreamModelId: 'chat-1',
              price: { input: '2', cachedInput: '0.1', output: '10' },
              priceEvidenceRef: 'https://example.test/pricing@2026-10-11',
              acceptedParameters: ['maxOutputTokens', 'tools'],
            },
          ];
    const routes = [
      { deploymentId: directDeployment, provider: direct, modelReference: reference, regions: [] },
      { deploymentId: routerDeployment, provider: router, modelReference: reference, regions: [] },
    ];
    const entry = {
      model,
      modelReference: reference,
      providers: [direct, router].sort(),
      contextTokens: 1_000_000,
      maxOutputTokens: 64_000,
      inputModalities: ['image', 'text'],
      outputModalities: ['text'],
      supportsTools: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      // Only the router publishes a price; Anthropic's Models API publishes none.
      listPrices: [
        {
          deploymentId: routerDeployment,
          provider: router,
          currency: 'USD',
          input: '2',
          output: '10',
        },
      ],
    };
    return {
      line: model,
      direct,
      router,
      directDeployment,
      routerDeployment,
      reviewedRoutes,
      serve: () => reader([entry], routes),
    };
  }

  const resolve = (model: string, constraints = UNCONSTRAINED_ROUTING) =>
    resolveEdgeRoute(
      INTERNAL_VIEWER,
      model,
      constraints,
      TEXT_COMPLETION_MODALITY,
      'price',
      UNCONSTRAINED_EDGE_CAPACITY,
      undefined,
    );

  async function scorecardOf(deploymentId: string) {
    const [row] = await getDb()
      .select()
      .from(inferenceDeploymentRoutingScores)
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, deploymentId));
    return row;
  }

  it('writes the direct route at its reviewed price and prefers its promotional credit over the paid route', async () => {
    const world = await directWorld();
    const summary = await runKaanaCatalogueSync({
      reader: world.serve(),
      reviewedRoutes: world.reviewedRoutes,
      economics: economics({
        [world.direct]: [{ category: 'promotional' }],
        [world.router]: [{ category: 'paid' }],
      }),
    });
    expect(summary.deployments.created).toBe(2);
    expect(summary.deployments.skipped).toEqual({});

    const rows = await deploymentsOf(world.line);
    const directRow = rows.find((row) => row.internalRouteId === world.directDeployment);
    if (directRow === undefined) throw new Error('the direct route was not written');
    expect(directRow).toMatchObject({
      status: 'active',
      permissionState: 'approved',
      availabilityScope: 'platform_internal',
      retentionDays: 30,
      acceptedParameters: ['maxOutputTokens', 'tools'],
    });
    const units = await getDb()
      .select({ unit: priceVersionUnitPrices.unit, amount: priceVersionUnitPrices.amount })
      .from(priceVersionUnitPrices)
      .where(eq(priceVersionUnitPrices.priceVersionId, directRow.priceVersionId ?? ''));
    expect(
      Object.fromEntries(units.map((row) => [row.unit, normalizeDecimal(row.amount)])),
    ).toEqual({
      input_tokens: '2',
      cached_input_tokens: '0.1',
      output_tokens: '10',
      reasoning_tokens: '10',
      requests: '0',
    });

    const directCard = await scorecardOf(world.directDeployment);
    expect(directCard).toMatchObject({
      priceEvidenceRef: 'https://example.test/pricing@2026-10-11',
      fundingClass: 'promotional_credit',
      fundingState: 'available',
    });
    expect(
      (directCard.fundingValidUntil?.getTime() ?? 0) -
        (directCard.fundingObservedAt?.getTime() ?? 0),
    ).toBe(FUNDING_EVIDENCE_TTL_MS);
    expect(await scorecardOf(world.routerDeployment)).toMatchObject({
      fundingClass: 'standard_payg',
      fundingObservedAt: null,
    });

    // The same price on both routes: promotional credit ranks first, and the
    // paid route stays the same-model failover destination.
    const resolved = await resolve(world.line);
    expect(resolved).toMatchObject({
      status: 'resolved',
      route: { deploymentId: world.directDeployment, provider: world.direct },
      alternates: [{ deploymentId: world.routerDeployment, provider: world.router }],
    });

    // A rerun inside the window writes no new scorecard event.
    const rerun = await runKaanaCatalogueSync({
      reader: world.serve(),
      reviewedRoutes: world.reviewedRoutes,
      economics: economics({ [world.direct]: [{ category: 'promotional' }] }),
    });
    expect(rerun.scorecardsWritten).toBe(0);
    expect(rerun.priceVersionsCreated).toBe(0);
  });

  it('drops the direct route when its credit is spent or its evidence is stale, and serves the paid route', async () => {
    const world = await directWorld();
    await runKaanaCatalogueSync({
      reader: world.serve(),
      reviewedRoutes: world.reviewedRoutes,
      economics: economics({
        [world.direct]: [
          {
            category: 'promotional',
            evidence: [
              { kind: 'balance', observedAt: new Date().toISOString(), balancePicos: '0' },
            ],
          },
        ],
      }),
    });
    expect(await scorecardOf(world.directDeployment)).toMatchObject({
      fundingClass: 'promotional_credit',
      fundingState: 'exhausted',
    });
    expect(await resolve(world.line)).toMatchObject({
      status: 'resolved',
      route: { deploymentId: world.routerDeployment },
      alternates: [],
    });

    // Observed seven hours ago: the six-hour window has passed.
    await runKaanaCatalogueSync({
      reader: world.serve(),
      reviewedRoutes: world.reviewedRoutes,
      now: new Date(Date.now() - 7 * 60 * 60 * 1000),
      economics: economics({ [world.direct]: [{ category: 'promotional' }] }),
    });
    expect((await scorecardOf(world.directDeployment)).fundingState).toBe('available');
    expect(await resolve(world.line)).toMatchObject({
      status: 'resolved',
      route: { deploymentId: world.routerDeployment },
      alternates: [],
    });
  });

  // ADR 0038: Kaana walks the provider's whole key pool, grants first, so a
  // second key keeps the provider promotional while any grant is available.
  it('funds a two-key provider as promotional credit while a grant is available', async () => {
    const world = await directWorld();
    await runKaanaCatalogueSync({
      reader: world.serve(),
      reviewedRoutes: world.reviewedRoutes,
      economics: economics({
        [world.direct]: [{ category: 'promotional' }, { category: 'promotional' }],
      }),
    });
    expect(await scorecardOf(world.directDeployment)).toMatchObject({
      fundingClass: 'promotional_credit',
      fundingState: 'available',
    });
  });

  it('keeps the direct route as ordinary paid usage when its funding is unknown', async () => {
    const world = await directWorld();
    for (const unknown of [
      null,
      economics({ [world.direct]: [{ category: null }] }),
      economics({ [world.direct]: [{ category: 'paid' }, { category: null }] }),
      { read: async () => Promise.reject(new Error('Kaana answered 503')) },
    ]) {
      await runKaanaCatalogueSync({
        reader: world.serve(),
        reviewedRoutes: world.reviewedRoutes,
        economics: unknown,
      });
      expect(await scorecardOf(world.directDeployment)).toMatchObject({
        fundingClass: 'standard_payg',
        fundingState: 'available',
        fundingValidUntil: null,
      });
    }
    // Still served: same price, and the exact deployment id breaks the tie.
    const resolved = await resolve(world.line);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') return;
    expect(
      [resolved.route, ...resolved.alternates].map((route) => route.deploymentId).sort(),
    ).toEqual([world.directDeployment, world.routerDeployment].sort());
  });

  it('creates a line only Anthropic serves once Kaana publishes its modalities (OxyHQ/Kaana#168)', async () => {
    // Claude Fable 5.1: OpenRouter's row is withheld (no zero-retention
    // endpoint), so the direct deployment is the line's only reporter.
    const reference = 'anthropic/claude-fable-5.1@observed-2026-10-11';
    const deploymentId = `dep_anthropic_claude_fable_5_1_${suffix()}`;
    const kaanaAccepted = [
      'maxOutputTokens',
      'reasoning.effort',
      'sampling.stopSequences',
      'toolChoice',
      'toolChoice.none',
      'tools',
    ];
    const entry = (observed: Record<string, unknown>) => ({
      model: 'anthropic/claude-fable-5.1',
      modelReference: reference,
      providers: ['anthropic'],
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: ['low', 'medium', 'high'],
      listPrices: [],
      ...observed,
    });
    const route = { deploymentId, provider: 'anthropic', modelReference: reference, regions: [] };

    // Positive control: what Kaana published before — no modalities — is
    // skipped, exactly as production logged.
    const before = await runKaanaCatalogueSync({
      reader: reader([entry({})], [route]),
      economics: economics({ anthropic: [{ category: 'promotional' }] }),
    });
    expect(before.skippedModels).toContainEqual({
      modelId: 'anthropic/claude-fable-5.1',
      reason: 'missing_modalities',
    });

    const after = await runKaanaCatalogueSync({
      reader: reader(
        [
          entry({
            inputModalities: ['file', 'image', 'text'],
            outputModalities: ['text'],
            supportsTools: true,
            acceptedParameters: kaanaAccepted,
          }),
        ],
        [{ ...route, acceptedParameters: kaanaAccepted }],
      ),
      economics: economics({ anthropic: [{ category: 'promotional' }] }),
    });
    expect(after.skippedModels.map((skipped) => skipped.modelId)).not.toContain(
      'anthropic/claude-fable-5.1',
    );
    const [model] = await getDb()
      .select()
      .from(inferenceModels)
      .where(
        and(
          eq(inferenceModels.publisherSlug, 'anthropic'),
          eq(inferenceModels.slug, 'claude-fable-5.1'),
        ),
      );
    expect(model).toMatchObject({
      catalogueSource: 'kaana_sync',
      inputModalities: ['image', 'text'],
      outputModalities: ['text'],
      supportsTools: true,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    const [row] = (await deploymentsOf('anthropic/claude-fable-5.1')).filter(
      (deployment) => deployment.internalRouteId === deploymentId,
    );
    // Kaana's statement and the reviewed one agree: `none` and `auto`, no
    // forced choice, no sampling.
    expect(row?.acceptedParameters).toEqual(kaanaAccepted);
    expect((await scorecardOf(deploymentId)).priceEvidenceRef).toBe(
      'https://platform.claude.com/docs/en/about-claude/pricing@2026-10-11',
    );
  });

  it('serves anthropic/claude-sonnet-5.5 from the migrated anthropic row, and excludes it under zero data retention', async () => {
    const [anthropic] = await getDb()
      .select()
      .from(inferenceProviders)
      .where(eq(inferenceProviders.slug, 'anthropic'));
    expect(anthropic).toMatchObject({
      kind: 'third_party',
      retainsPayloads: true,
      retentionDays: 30,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    });

    const world = await directWorld({ realAnthropic: true });
    await runKaanaCatalogueSync({
      reader: world.serve(),
      economics: economics({ anthropic: [{ category: 'promotional' }] }),
    });
    const directRow = (await deploymentsOf(world.line)).find(
      (row) => row.internalRouteId === world.directDeployment,
    );
    expect(directRow?.acceptedParameters).toEqual([
      'maxOutputTokens',
      'reasoning.effort',
      'sampling.stopSequences',
      'toolChoice',
      'toolChoice.none',
      'tools',
    ]);
    expect((await scorecardOf(world.directDeployment)).priceEvidenceRef).toBe(
      'https://platform.claude.com/docs/en/about-claude/pricing@2026-10-11',
    );
    expect(await resolve(world.line)).toMatchObject({
      status: 'resolved',
      route: { deploymentId: world.directDeployment, provider: 'anthropic' },
      alternates: [{ deploymentId: world.routerDeployment }],
    });
    expect(
      await resolve(world.line, { ...UNCONSTRAINED_ROUTING, requireZeroDataRetention: true }),
    ).toMatchObject({
      status: 'resolved',
      route: { deploymentId: world.routerDeployment },
      alternates: [],
    });
  });
});
