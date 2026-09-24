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
  SYNCED_LICENSE,
  blockCatalogueModel,
  normalizeDecimal,
  parseKaanaCatalogue,
  planKaanaModel,
  runKaanaCatalogueSync,
  syncedPriceScore,
  unblockCatalogueModel,
} from '../kaanaCatalogueSync.service';

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
  await getDb().insert(inferenceProviders).values({
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
        { deploymentId: deploymentId(name), provider, currency: 'USD', input: '0.072', output: '0.28' },
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
    })
    .from(inferenceDeployments)
    .innerJoin(inferenceModelRevisions, eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id))
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
          listPrices: [{ deploymentId: 'dep_stub', provider: 'stub', currency: 'USD', input: '0.072', output: '0.28' }],
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
    expect(() => parseKaanaCatalogue({ error: 'nope' })).toThrow('no models array');
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
      syncedPriceScore({ input: '3', output: '15' })
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
        listPrices: [{ deploymentId: 'dep_a', provider: 'p1', currency: 'USD', input: '1', output: '2' }],
      },
    ],
  }).models[0];
  const attested = new Map([
    ['dep_a', { deploymentId: 'dep_a', provider: 'p1', modelReference: 'acme/chat@r1', regions: [] }],
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
      planKaanaModel({ ...base, model: 'alia/chat', modelReference: 'alia/chat@r1' }, context)
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

  it('refuses a non-USD price rather than converting it', () => {
    const eur = parseKaanaCatalogue({
      models: [
        {
          ...base,
          listPrices: [{ deploymentId: 'dep_a', provider: 'p1', currency: 'EUR', input: '1', output: '2' }],
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
    expect(Object.fromEntries(units.map((row) => [row.unit, normalizeDecimal(row.amount)]))).toEqual({
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
      undefined
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      route: { deploymentId: world.route('alpha').deploymentId, reasoningEfforts: ['low', 'medium', 'high'] },
    });

    // ...and it is listed internally with its efforts and release date, never publicly.
    const internal = (await listCatalogueForViewer(INTERNAL_VIEWER)).find(
      (entry) => entry.modelId === world.line('alpha')
    );
    expect(internal?.capabilities.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(internal?.releasedAt).toBe('2025-08-05T17:17:11.000Z');
    expect(internal?.availabilityScope).toBe('platform_internal');
    expect(
      (await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER)).some(
        (entry) => entry.modelId === world.line('alpha')
      )
    ).toBe(false);
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
    const summary = await runKaanaCatalogueSync({ reader: reader([changed], [world.route('gamma')]) });
    expect(summary.priceVersionsCreated).toBe(1);
    const [after] = await deploymentsOf(world.line('gamma'));
    expect(after.priceVersionId).not.toBe(before.priceVersionId);

    const versions = await getDb()
      .select({ id: priceVersions.id, status: priceVersions.status, supersedes: priceVersions.supersedesPriceVersionId })
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
      .where(eq(inferenceDeploymentRoutingScoreEvents.deploymentId, world.route('gamma').deploymentId));
    expect(events).toHaveLength(2);
  });

  it('retires a route Kaana stops reporting, and withholds a mass retirement unless confirmed', async () => {
    const world = await makeWorld();
    const names = ['d1', 'd2', 'd3'];
    await runKaanaCatalogueSync({
      reader: reader(names.map((name) => world.entry(name)), names.map((name) => world.route(name))),
    });

    const dropOne = await runKaanaCatalogueSync({
      reader: reader([world.entry('d1'), world.entry('d2')], [world.route('d1'), world.route('d2')]),
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
        undefined
      )
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
    await expect(runKaanaCatalogueSync({ reader: reader([], []) })).rejects.toThrow('empty catalogue');
  });

  it('blocks a line immediately and brings it back only after the block is lifted', async () => {
    const world = await makeWorld();
    const serve = reader([world.entry('eps'), world.entry('keep')], [world.route('eps'), world.route('keep')]);
    await runKaanaCatalogueSync({ reader: serve });

    const blocked = await blockCatalogueModel({ modelId: world.line('eps'), reason: 'incident test', userId: null });
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
    await db.insert(inferencePublishers).values({ slug: world.publisher, displayName: 'Reviewed Publisher' });
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
      .where(and(eq(inferenceModels.publisherSlug, world.publisher), eq(inferenceModels.slug, 'reviewed')));
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
        [world.route('ok'), world.route('nomax'), world.route('image'), world.route('unpriced')]
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
