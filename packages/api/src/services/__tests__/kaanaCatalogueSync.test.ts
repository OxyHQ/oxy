import { executeScopedLegalReview } from '../scopedLegalReviewOperation.service';
/**
 * The Kaana → Oxy catalogue sync, against a REAL Postgres.
 *
 * Every fixture id carries a random suffix, and every assertion is scoped to
 * the model lines this file creates. The sync's retirement step reads every
 * synced deployment in the database, so `beforeEach` retires the synced rows
 * this file left behind: no other suite writes a synced row.
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import * as dataPlane from '../../config/kaanaDataPlane';
import { scopedAudienceFixture } from '../../../../contracts/src/__tests__/scopedExecution.fixture';
import { createHttpKaanaCatalogueReader } from '../httpKaanaClient';
import { privateAutoSourceApprovalSchema, type ScopedExecutionAudience } from '@oxy.so/contracts';
import { privateAutoApprovalFixture } from '../../../../contracts/src/__tests__/privateAutoExecution.fixture';
import * as privateAutoSource from '../../config/privateAutoClassification';
import { executePrivateAutoLegalReview } from '../privateAutoLegalReviewOperation.service';
import { privateAutoHash } from '../privateAutoExecution.service';
import * as scopedSource from '../scopedExecution.service';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  users, securityActivities, accountClosureFences,
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
  type KaanaDeploymentDescriptor,
  SYNCED_LICENSE,
  blockCatalogueModel,
  normalizeAcceptedParameters,
  normalizeDecimal,
  parseKaanaCatalogue,
  planKaanaModel,
  runKaanaCatalogueSync,
  syncedPriceScore,
  syncedUnitPrices,
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
      scopedExecutionContractVersion: '3.6.0',
      deployments: routes
        .filter((route) => ids.includes(route.deploymentId))
        .map((route) => ({
          deploymentId: route.deploymentId,
          provider: route.provider,
          modelReference: route.modelReference,
          regions: route.regions ?? [],
        })),
    }),
    listPublishedDeployments: async () => ({
      snapshotId: 'snap_test',
      scopedExecutionContractVersion: '3.6.0',
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
      acceptedParameters: inferenceDeployments.acceptedParameters,
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
      ['dep_a', { deploymentId: 'dep_a', provider: 'p1', modelReference: 'acme/chat@r1', regions: [] }],
      ['dep_b', { deploymentId: 'dep_b', provider: 'p2', modelReference: 'acme/chat@r1', regions: [] }],
    ]);
    const acceptedOf = (plan: ReturnType<typeof planKaanaModel>) =>
      plan.status === 'planned' ? plan.model.routes.map((route) => route.acceptedParameters) : undefined;

    it('normalizes into Oxy vocabulary order, dropping unknown words, and keeps absent as unknown', () => {
      expect(normalizeAcceptedParameters(undefined)).toBeNull();
      expect(normalizeAcceptedParameters([])).toEqual([]);
      expect(
        normalizeAcceptedParameters(['tools', 'sampling.topK', 'sampling.temperature', 'maxOutputTokens', 'tools'])
      ).toEqual(['maxOutputTokens', 'sampling.temperature', 'tools']);
    });

    it('attributes a single-provider line’s set to its route', () => {
      const entry = { ...base, providers: ['p1'], acceptedParameters: ['tools', 'maxOutputTokens'] };
      expect(acceptedOf(planKaanaModel(entry, context))).toEqual([['maxOutputTokens', 'tools']]);
    });

    it('leaves the route unknown when the line reported nothing or names no providers', () => {
      expect(acceptedOf(planKaanaModel({ ...base, providers: ['p1'] }, context))).toEqual([null]);
      expect(acceptedOf(planKaanaModel({ ...base, acceptedParameters: ['tools'] }, context))).toEqual([null]);
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
    const internal = (await listCatalogueForViewer(INTERNAL_VIEWER, CATALOGUED)).find(
      (entry) => entry.modelId === world.line('alpha')
    );
    expect(internal?.capabilities.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(internal?.releasedAt).toBe('2025-08-05T17:17:11.000Z');
    expect(internal?.availabilityScope).toBe('platform_internal');
    expect(
      (await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER, CATALOGUED)).some(
        (entry) => entry.modelId === world.line('alpha')
      )
    ).toBe(false);
  });

  it('stores a route’s accepted parameters, keeps them current and lets the edge read them', async () => {
    const world = await makeWorld();
    await runKaanaCatalogueSync({
      reader: reader(
        [world.entry('params', { acceptedParameters: ['tools', 'maxOutputTokens'] })],
        [world.route('params')]
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
      undefined
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      route: { acceptedParameters: ['maxOutputTokens', 'tools'] },
    });

    // A later report that says nothing makes the route unknown again, never `[]`.
    await runKaanaCatalogueSync({ reader: reader([world.entry('params')], [world.route('params')]) });
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


describe('independent private Auto catalogue import', () => {
  afterEach(() => jest.restoreAllMocks());
  async function fixture(includeOrdinary = false) {
    const world = await makeWorld();
    await getDb().update(inferenceProviders).set({ retainsPayloads: false, retentionDays: 0 })
      .where(eq(inferenceProviders.slug, world.provider));
    const ordinary = world.route('privateauto');
    const route = { ...ordinary, deploymentId: `${ordinary.deploymentId}-auto` };
    const approval = privateAutoSourceApprovalSchema.parse({ ...privateAutoApprovalFixture,
      deploymentId: route.deploymentId, modelReference: route.modelReference, provider: route.provider,
      regions: route.regions, priceVersionId: randomUUID(), approvalId: `review-${world.tag}` });
    const descriptor = { ...route, regions: route.regions ?? [], privateAutoSourceApproval: approval,
      keyId: approval.keyId, upstreamModelId: approval.upstreamModelId,
      providerRateCardVersionId: approval.providerRateCardVersionId, providerSourceVersion: approval.providerSourceVersion };
    const descriptors = includeOrdinary ? [ordinary, descriptor] : [descriptor];
    const prices = descriptors.map(row => ({ deploymentId: row.deploymentId, provider: row.provider,
      currency: 'USD', input: '0.072', output: '0.28' }));
    const payload = { scopedExecutionContractVersion: '3.6.0', privateAutoExecutionContractVersion: '3.7.0',
      configuration: { snapshotId: 'snap_test' }, deployments: descriptors,
      models: [world.entry('privateauto', { listPrices: prices, outputModalities: includeOrdinary ? ['text'] : ['decisions'] })] };
    const privateReader: KaanaCatalogueReader = {
      listModels: async () => payload,
      attestDeployments: async (ids, options) => ({ snapshotId: 'snap_test',
        ...(options.privateAutoExecutionContractVersion === undefined ? { scopedExecutionContractVersion: '3.6.0' as const } : { privateAutoExecutionContractVersion: '3.7.0' as const }),
        deployments: descriptors.filter(row => ids.includes(row.deploymentId)).map(row => ({ ...row, regions: row.regions ?? [] })) }),
      listPublishedDeployments: async () => ({ snapshotId: 'snap_test', scopedExecutionContractVersion: '3.6.0', privateAutoExecutionContractVersion: '3.7.0',
        deployments: descriptors.map(row => ({ ...row, regions: row.regions ?? [] })) }),
    };
    const rows = () => getDb().select({ id: inferenceDeployments.id, modelRevisionId: inferenceDeployments.modelRevisionId,
      providerSlug: inferenceDeployments.providerSlug, regions: inferenceDeployments.regions,
      retainsPayloads: inferenceDeployments.retainsPayloads, retentionDays: inferenceDeployments.retentionDays,
      trainsOnCustomerData: inferenceDeployments.trainsOnCustomerData, zeroDataRetentionAvailable: inferenceDeployments.zeroDataRetentionAvailable,
      internalRouteId: inferenceDeployments.internalRouteId, privateAutoSourceApproval: inferenceDeployments.privateAutoSourceApproval,
      scopedExecution: inferenceDeployments.scopedExecution, priceVersionId: inferenceDeployments.priceVersionId,
      availabilityScope: inferenceDeployments.availabilityScope, commercialPermission: inferenceDeployments.commercialPermission,
      permissionState: inferenceDeployments.permissionState, status: inferenceDeployments.status, autoApprovalPolicyId: inferenceDeployments.autoApprovalPolicyId,
      legalReviewStatus: inferenceDeployments.legalReviewStatus, legalReviewEvidenceRef: inferenceDeployments.legalReviewEvidenceRef })
      .from(inferenceDeployments).where(inArray(inferenceDeployments.internalRouteId, descriptors.map(row => row.deploymentId)));
    return { world, approval, route, ordinary, privateReader, rows, prices, payload };
  }
  it('imports ordinary, commissioning and Auto through real separate signed HTTP projections and preserves private DENY', async () => {
    const f = await fixture();
    const ordinary = f.world.route('combined-ordinary');
    const commissioning = { ...f.route, deploymentId: `${f.route.deploymentId}-commissioning` };
    const audience: ScopedExecutionAudience = { ...scopedAudienceFixture, expiresAt: '2030-01-01T00:00:00Z',
      deploymentId: commissioning.deploymentId, modelReference: commissioning.modelReference, provider: commissioning.provider,
      priceVersionId: f.approval.priceVersionId };
    const privateDescriptor = f.payload.deployments[0]!;
    const scopedDescriptor = { ...commissioning, regions: commissioning.regions ?? [], scopedExecution: audience,
      keyId: audience.keyId, upstreamModelId: audience.upstreamModelId, providerRateCardVersionId: audience.providerRateCardVersionId, providerSourceVersion: audience.providerSourceVersion };
    const model = f.payload.models[0]!;
    const scopedModel = { ...model, listPrices: [{ ...f.prices[0]!, deploymentId: commissioning.deploymentId }] };
    const ordinaryModel = f.world.entry('combined-ordinary');
    const scopedBody = { configuration: { snapshotId: 'snap_test' }, scopedExecutionContractVersion: '3.6.0',
      deployments: [ordinary, scopedDescriptor], models: [ordinaryModel, scopedModel] };
    const autoBody = { configuration: { snapshotId: 'snap_test' }, privateAutoExecutionContractVersion: '3.7.0',
      deployments: [ordinary, privateDescriptor], models: [ordinaryModel, model] };
    jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(f.approval);
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockReturnValue(audience);
    const keys = generateKeyPairSync('ed25519');
    jest.spyOn(dataPlane, 'resolveKaanaDataPlane').mockReturnValue({ status: 'configured',
      config: { baseUrl: 'https://kaana.ai', keyId: 'synthetic-composition', privateKey: keys.privateKey } });
    const fetcher = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const query = JSON.parse((init!.body as Buffer).toString());
      expect(Boolean(query.scopedExecutionContractVersion)).not.toBe(Boolean(query.privateAutoExecutionContractVersion));
      const projection = query.privateAutoExecutionContractVersion === '3.7.0' ? autoBody : scopedBody;
      return new Response(JSON.stringify(String(url).endsWith('/models/query') ? projection : {
        snapshotId: 'snap_test',
        ...(query.privateAutoExecutionContractVersion === '3.7.0' ? { privateAutoExecutionContractVersion: '3.7.0' } : { scopedExecutionContractVersion: '3.6.0' }),
        deployments: projection.deployments.filter(row => query.deploymentIds.includes(row.deploymentId)),
      }), { status: 200, headers: { 'Cache-Control': 'no-store' } });
    });
    const first = await runKaanaCatalogueSync({ reader: createHttpKaanaCatalogueReader()! });
    expect(first.status).toBe('synced'); expect(first.skippedModels).toEqual([]); expect(first.deployments.created).toBe(3);
    const ids = [ordinary.deploymentId, commissioning.deploymentId, f.route.deploymentId];
    const rows = () => getDb().select().from(inferenceDeployments).where(inArray(inferenceDeployments.internalRouteId, ids));
    const before = await rows();
    expect(before.filter(row => row.internalRouteId !== ordinary.deploymentId)).toHaveLength(2);
    for (const row of before.filter(row => row.internalRouteId !== ordinary.deploymentId)) {
      expect(row).toMatchObject({ status: 'disabled', permissionState: 'pending_review', legalReviewStatus: 'not_started', autoApprovalPolicyId: null });
    }
    expect(before.find(row => row.internalRouteId === ordinary.deploymentId)).toMatchObject({ status: 'active', autoApprovalPolicyId: KAANA_SYNC_AUTO_APPROVAL_POLICY_ID });
    const second = await runKaanaCatalogueSync({ reader: createHttpKaanaCatalogueReader()! });
    expect(second.deployments.created).toBe(0); expect(second.deployments.retired).toBe(0);
    const stable = (items: typeof before) => items.map(({ updatedAt: _updatedAt, ...facts }) => facts).sort((a,b) => a.id.localeCompare(b.id));
    const after = await rows(); expect(stable(after)).toEqual(stable(before));
    expect(after.every(row => row.updatedAt >= before.find(old => old.id === row.id)!.updatedAt)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  async function legalFixture() {
    const f = await fixture();
    jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(f.approval);
    await runKaanaCatalogueSync({ reader: f.privateReader });
    const [row] = await f.rows();
    if (!row) throw new Error('Synthetic private row absent');
    const reviewerUserId = randomUUID();
    await getDb().insert(users).values({ id: reviewerUserId, username: `reviewer${suffix()}`,
      isStaff: true, staffCapabilities: ['inference:catalogue:publish'] });
    const plan = { kind: 'private-auto-legal-review-v1' as const, reviewerUserId, deploymentRowId: row.id,
      approval: f.approval, expectedLegalStatus: 'not_started' as const, expectedEvidenceRef: null as string | null,
      evidenceRef: f.approval.review.legalReviewEvidenceRef, reason: 'Synthetic private internal-use review',
      operator: 'synthetic-root-operator', sessionApprovalRef: 'synthetic-review-session' };
    const context = { applicationId: f.approval.principal.applicationId, environment: f.approval.principal.environment,
      privateAuto: { approval: f.approval, principal: f.approval.principal } };
    const resolve = (constraints = UNCONSTRAINED_ROUTING, actualContext = context) => resolveEdgeRoute(INTERNAL_VIEWER,
      f.approval.modelReference, constraints, { input: 'text', output: 'decisions', apiFormat: 'decisions', requiresDeclaredApiFormat: true }, 'price', UNCONSTRAINED_EDGE_CAPACITY, actualContext);
    return { ...f, row, plan, resolve, context };
  }
  it('reviews only internal use, then selects exact source/price without claiming commercial rights or public permission', async () => {
    const f = await legalFixture();
    expect(await f.resolve()).toMatchObject({ status: 'unknown-model' });
    const before = await f.rows();
    const dry = await executePrivateAutoLegalReview(f.plan);
    expect(dry).toMatchObject({ applied: false, publicServingApproved: false, inferenceAuthorized: false });
    expect(await f.rows()).toEqual(before);
    await executePrivateAutoLegalReview(f.plan, { apply: true, expectedPlanSha256: dry.planSha256 });
    expect(await f.resolve()).toMatchObject({ status: 'resolved', route: { deploymentId: f.approval.deploymentId,
      privateAutoCatalogueEvidence: { admission: 'private_auto_classifier', permissionState: 'pending_review',
        deploymentStatus: 'disabled', sourceApprovalSha256: privateAutoHash(f.approval),
        eligibility: { commercialUseAllowed: false, policyAdmitted: true, privacyAdmitted: true, capabilityAdmitted: true } } } });
    expect(await resolveEdgeRoute(INTERNAL_VIEWER, f.approval.modelReference, UNCONSTRAINED_ROUTING,
      TEXT_COMPLETION_MODALITY, 'price', UNCONSTRAINED_EDGE_CAPACITY, undefined)).toMatchObject({ status: 'unknown-model' });
    expect(await f.resolve({ ...UNCONSTRAINED_ROUTING, requireCommercialUseRights: true })).toMatchObject({ status: 'policy-excluded', constraints: ['requireCommercialUseRights'] });
    expect(await f.rows()).toEqual([expect.objectContaining({ permissionState: 'pending_review', status: 'disabled', legalReviewStatus: 'approved' })]);
    expect(await getDb().select({ metadata: securityActivities.metadata }).from(securityActivities).where(eq(securityActivities.userId, f.plan.reviewerUserId)))
      .toEqual([{ metadata: expect.objectContaining({ operation: 'private_auto_internal_use_legal_review', publicServingApproved: false }) }]);
    await expect(executePrivateAutoLegalReview(f.plan, { apply: true, expectedPlanSha256: dry.planSha256 })).rejects.toThrow('precondition');
  });
  it.each(['not-staff', 'fenced', 'wrong-hash', 'wrong-evidence', 'source-withdrawn', 'rights-drift'])
    ('legal review rejects %s with no review/audit mutation', async (failure) => {
      const f = await legalFixture();
      if (failure === 'not-staff') await getDb().update(users).set({ isStaff: false }).where(eq(users.id, f.plan.reviewerUserId));
      if (failure === 'fenced') await getDb().insert(accountClosureFences).values({ accountId: f.plan.reviewerUserId });
      if (failure === 'wrong-evidence') f.plan.evidenceRef = 'other-review';
      if (failure === 'source-withdrawn') jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(undefined);
      if (failure === 'rights-drift') await getDb().update(inferenceModels).set({ commercialUseAllowed: true }).where(eq(inferenceModels.modelId, f.world.line('privateauto')));
      const before = await f.rows();
      await expect(executePrivateAutoLegalReview(f.plan, { apply: true,
        expectedPlanSha256: failure === 'wrong-hash' ? 'wrong' : privateAutoHash(f.plan) })).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect(await getDb().select({ id: securityActivities.id }).from(securityActivities).where(eq(securityActivities.userId, f.plan.reviewerUserId))).toEqual([]);
    });
  it.each(['expired', 'foreign-principal', 'changed-approval', 'wrong-price', 'privacy-drift', 'source-after-lookup'])
    ('private selection rejects %s and never widens the ordinary catalogue', async (failure) => {
      const f = await legalFixture();
      await executePrivateAutoLegalReview(f.plan, { apply: true, expectedPlanSha256: privateAutoHash(f.plan) });
      if (failure === 'expired') jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue({ ...f.approval, expiresAt: new Date(Date.now() - 1).toISOString() });
      if (failure === 'foreign-principal') f.context.privateAuto.principal = { ...f.approval.principal, credentialId: 'foreign' };
      if (failure === 'changed-approval') f.context.privateAuto.approval = { ...f.approval, approvalVersion: 2 };
      if (failure === 'wrong-price') await getDb().update(priceVersions).set({ status: 'superseded', effectiveUntil: new Date() }).where(eq(priceVersions.id, f.approval.priceVersionId));
      if (failure === 'privacy-drift') await getDb().update(inferenceDeployments).set({ retainsPayloads: true, retentionDays: 1, zeroDataRetentionAvailable: false }).where(eq(inferenceDeployments.id, f.row.id));
      if (failure === 'source-after-lookup') jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval')
        .mockReturnValueOnce(f.approval).mockReturnValueOnce(f.approval).mockReturnValue(undefined);
      expect((await f.resolve()).status).not.toBe('resolved');
      expect((await listCatalogueForViewer(INTERNAL_VIEWER, CATALOGUED)).some(model => model.modelId === f.world.line('privateauto'))).toBe(false);
    });
  it('does not authorize import or allocate price from signed metadata without local source approval', async () => {
    const f = await fixture();
    jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(undefined);
    expect(privateAutoSource.privateAutoClassifierSourceApproval()).toBeUndefined();
    expect((await runKaanaCatalogueSync({ reader: f.privateReader })).deployments.skipped.unattested_route).toBe(1);
    expect(await f.rows()).toEqual([]);
    expect(await getDb().select({ id: priceVersions.id }).from(priceVersions).where(eq(priceVersions.id, f.approval.priceVersionId))).toEqual([]);
  });
  it('imports only exact fresh reviewed authority, retaining pending/disabled/internal and separate metadata', async () => {
    const f = await fixture();
    jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(f.approval);
    await runKaanaCatalogueSync({ reader: f.privateReader });
    expect(await f.rows()).toEqual([expect.objectContaining({ privateAutoSourceApproval: f.approval,
      scopedExecution: null, permissionState: 'pending_review', status: 'disabled', availabilityScope: 'platform_internal',
      autoApprovalPolicyId: null, legalReviewStatus: 'not_started', priceVersionId: f.approval.priceVersionId })]);
    expect((await listCatalogueForViewer(INTERNAL_VIEWER, CATALOGUED)).some(model => model.modelId === f.world.line('privateauto'))).toBe(false);
  });
  it.each(['expired', 'changed-key'])('refuses %s source approval before allocating its price', async (kind) => {
    const f = await fixture();
    jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(kind === 'expired' ?
      { ...f.approval, expiresAt: new Date(Date.now() - 1).toISOString() } : { ...f.approval, keyId: 'changed' });
    await runKaanaCatalogueSync({ reader: f.privateReader });
    expect(await f.rows()).toEqual([]);
  });
  it('preserves ordinary uniqueness and permits separate private row without duplicate private route on renewal', async () => {
    const f = await fixture(true);
    // Establish the immutable shared list price first, preserving all ordinary rights.
    await getDb().insert(priceVersions).values({ id: f.approval.priceVersionId, modelReference: f.route.modelReference,
      provider: f.route.provider, currency: 'USD', status: 'active', effectiveFrom: new Date('2020-01-01') });
    await getDb().insert(priceVersionUnitPrices).values(syncedUnitPrices({ input: '0.072', output: '0.28' })
      .map(unit => ({ priceVersionId: f.approval.priceVersionId, ...unit })));
    jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(f.approval);
    await runKaanaCatalogueSync({ reader: f.privateReader });
    const rows = await f.rows();
    expect(rows).toHaveLength(2);
    const ordinary = rows.find(row => row.privateAutoSourceApproval === null);
    const auto = rows.find(row => row.privateAutoSourceApproval !== null);
    if (!ordinary || !auto) throw new Error('Synthetic catalogue identities missing');
    expect(ordinary).toMatchObject({ permissionState: 'approved', status: 'active', autoApprovalPolicyId: KAANA_SYNC_AUTO_APPROVAL_POLICY_ID });
    await expect(getDb().insert(inferenceDeployments).values({ ...ordinary, id: randomUUID(), internalRouteId: 'duplicate-ordinary' })).rejects.toThrow();
    await expect(getDb().insert(inferenceDeployments).values({ ...auto, id: randomUUID(), privateAutoSourceApproval: { ...f.approval, approvalVersion: 2 } })).rejects.toThrow();
    expect(await f.rows()).toEqual(rows);
  });
  it.each(['public', 'approved', 'active', 'mixed-commissioning'])('database rejects %s widening of a private Auto row', async (kind) => {
    const f = await fixture();
    jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(f.approval);
    await runKaanaCatalogueSync({ reader: f.privateReader });
    const [row] = await f.rows();
    if (!row) throw new Error('Synthetic private row absent');
    const delta = kind === 'public' ? { availabilityScope: 'public_payg' as const } : kind === 'approved' ?
      { permissionState: 'approved' as const, legalReviewStatus: 'approved' as const, legalReviewEvidenceRef: 'synthetic' } :
      kind === 'active' ? { status: 'active' as const } : { scopedExecution: { permitId: 'not-compatible' } as never };
    await expect(getDb().update(inferenceDeployments).set(delta).where(eq(inferenceDeployments.id, row.id))).rejects.toThrow();
    expect(await f.rows()).toEqual([row]);
  });
  it('reimports identical private metadata without rewriting its exact legal review', async () => {
    const f = await fixture();
    jest.spyOn(privateAutoSource, 'privateAutoClassifierSourceApproval').mockReturnValue(f.approval);
    await runKaanaCatalogueSync({ reader: f.privateReader });
    const [row] = await f.rows();
    if (!row) throw new Error('Synthetic private row absent');
    await getDb().update(inferenceDeployments).set({ legalReviewStatus: 'approved', legalReviewEvidenceRef: f.approval.review.legalReviewEvidenceRef, legalReviewedAt: new Date() })
      .where(eq(inferenceDeployments.id, row.id));
    const before = await f.rows();
    await runKaanaCatalogueSync({ reader: f.privateReader });
    expect(await f.rows()).toEqual(before);
  });
});

describe('source-reviewed scoped price bootstrap', () => {
  afterEach(() => jest.restoreAllMocks());

  async function fixture() {
    const world = await makeWorld();
    const route = world.route('private');
    const scope: ScopedExecutionAudience = {
      permitId: `permit-${world.tag}`, idempotencyKey: `request-${world.tag}`, fixtureSha256: 'a'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z',
      principal: { accountId: 'fixture', applicationId: 'fixture', credentialId: 'fixture', environment: 'production' },
      policy: { routingPolicyId: 'fixture', policyVersion: 1 },
      deploymentId: route.deploymentId, provider: route.provider, modelReference: route.modelReference,
      keyId: 'fixture-key', upstreamModelId: 'fixture-dated-model', priceVersionId: randomUUID(),
      providerRateCardVersionId: 'fixture-card', providerSourceVersion: 'fixture-source', maxCostUsd: '0.01',
    };
    const descriptor = { ...route, regions: route.regions ?? [], scopedExecution: scope,
      keyId: scope.keyId, upstreamModelId: scope.upstreamModelId,
      providerRateCardVersionId: scope.providerRateCardVersionId, providerSourceVersion: scope.providerSourceVersion };
    const base = reader([world.entry('private', { inputModalities: ['text'], outputModalities: ['decisions'] })], [route]);
    const scopedReader: KaanaCatalogueReader = { ...base,
      listModels: async () => ({ ...await base.listModels(), scopedExecutionContractVersion: '3.6.0', deployments: [descriptor] }),
      attestDeployments: async () => ({ snapshotId: 'snap_test', scopedExecutionContractVersion: '3.6.0', deployments: [descriptor] }),
    };
    const prices = () => getDb().select().from(priceVersions).where(eq(priceVersions.modelReference, route.modelReference));
    return { world, route, scope, scopedReader, prices, descriptor };
  }

  it('does not let authenticated remote metadata authorize a local price identity', async () => {
    const f = await fixture();
    jest.spyOn(scopedSource, "sourceReviewedScopedAudience").mockReturnValue(undefined);
    expect(scopedSource.sourceReviewedScopedAudience()).toBeUndefined();
    const result = await runKaanaCatalogueSync({ reader: f.scopedReader });
    expect(result.deployments.skipped.unattested_route).toBe(1);
    expect(await f.prices()).toEqual([]);
    expect(await deploymentsOf(f.world.line('private'))).toEqual([]);
  });

  it('creates the exact reviewed price from the signed list price but leaves execution disabled', async () => {
    const f = await fixture();
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockReturnValue(f.scope);
    const result = await runKaanaCatalogueSync({ reader: f.scopedReader });
    expect(result.priceVersionsCreated).toBe(1);
    expect(await f.prices()).toEqual([expect.objectContaining({ id: f.scope.priceVersionId, currency: 'USD', status: 'active' })]);
    const units = await getDb().select().from(priceVersionUnitPrices).where(eq(priceVersionUnitPrices.priceVersionId, f.scope.priceVersionId));
    expect(units.map(row => ({ ...row, amount: normalizeDecimal(row.amount) }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: 'input_tokens', amount: '0.072', per: 1000000 }),
      expect.objectContaining({ unit: 'output_tokens', amount: '0.28', per: 1000000 }),
    ]));
    expect(await deploymentsOf(f.world.line('private'))).toEqual([expect.objectContaining({
      status: 'disabled', permissionState: 'pending_review', autoApprovalPolicyId: null, priceVersionId: f.scope.priceVersionId,
    })]);
  });

  it('imports genuine decisions with contract capability, then resolves only exact private reviewed authority', async () => {
    const f = await fixture();
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockReturnValue(f.scope);
    await runKaanaCatalogueSync({ reader: f.scopedReader });
    const [model] = await getDb().select().from(inferenceModels).where(eq(inferenceModels.modelId, f.world.line('private')));
    expect(model).toMatchObject({ inputModalities: ['text'], outputModalities: ['decisions'], apiFormats: ['decisions'], supportsStreaming: false });
    const [row] = await getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.internalRouteId, f.scope.deploymentId));
    if (!row) throw new Error('Private import missing');
    expect(row).toMatchObject({ status: 'disabled', permissionState: 'pending_review', legalReviewStatus: 'not_started' });
    const required = { input: 'text' as const, output: 'decisions' as const, apiFormat: 'decisions' as const, requiresDeclaredApiFormat: true };
    const resolve = () => resolveEdgeRoute(INTERNAL_VIEWER, f.route.modelReference, UNCONSTRAINED_ROUTING, required, 'price', UNCONSTRAINED_EDGE_CAPACITY,
      { applicationId: f.scope.principal.applicationId, environment: 'production', scopedExecution: f.scope });
    expect((await resolve()).status).not.toBe('resolved');
    jest.spyOn(scopedSource, 'privateCommissioningAudience').mockReturnValue(f.scope);
    const reviewerUserId = randomUUID();
    await getDb().insert(users).values({ id: reviewerUserId, username: `reviewer${suffix()}`, isStaff: true, staffCapabilities: ['inference:catalogue:publish'] });
    const legalPlan = { kind: 'scoped-legal-review-v1', reviewerUserId, deploymentRowId: row.id, audience: f.scope,
      expectedLegalStatus: 'not_started', expectedEvidenceRef: null, evidenceRef: 'synthetic-specific-review',
      reason: 'Synthetic private decisions fixture', operator: 'synthetic-root-operator', sessionApprovalRef: 'synthetic-reviewed-session' };
    const dry = await executeScopedLegalReview(legalPlan);
    await executeScopedLegalReview(legalPlan, { apply: true, expectedPlanSha256: dry.planSha256 });
    expect(await resolve()).toMatchObject({ status: 'resolved', route: { outputModalities: ['decisions'], apiFormats: ['decisions'] } });
    expect((await resolveEdgeRoute(INTERNAL_VIEWER, f.route.modelReference, UNCONSTRAINED_ROUTING, required)).status).not.toBe('resolved');
    expect((await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER, CATALOGUED)).some(entry => entry.modelId === f.world.line('private'))).toBe(false);
    // A genuine output transition must remove only our derived contract capability.
    const body = await f.scopedReader.listModels() as { models: Record<string, unknown>[] };
    await runKaanaCatalogueSync({ reader: { ...f.scopedReader, listModels: async () => ({ ...body, models: body.models.map(entry => ({ ...entry, outputModalities: ['text'] })) }) } });
    expect((await getDb().select().from(inferenceModels).where(eq(inferenceModels.id, model.id)))[0]).toMatchObject({ outputModalities: ['text'], apiFormats: null });
    await getDb().update(inferenceModels).set({ apiFormats: ['responses'] }).where(eq(inferenceModels.id, model.id));
    await runKaanaCatalogueSync({ reader: { ...f.scopedReader, listModels: async () => ({ ...body, models: body.models.map(entry => ({ ...entry, outputModalities: ['text'] })) }) } });
    expect((await getDb().select().from(inferenceModels).where(eq(inferenceModels.id, model.id)))[0].apiFormats).toEqual(['responses']);
    expect(await resolve()).toMatchObject({ status: 'unknown-model' });
    const rereview = await executeScopedLegalReview(legalPlan);
    await executeScopedLegalReview(legalPlan, { apply: true, expectedPlanSha256: rereview.planSha256 });
    expect(await resolve()).toMatchObject({ status: 'modality-unsupported' });
    await expect(getDb().update(inferenceModels).set({ inputModalities: ['decisions'] }).where(eq(inferenceModels.id, model.id))).rejects.toThrow();
    await expect(getDb().update(inferenceModels).set({ outputModalities: ['image'] }).where(eq(inferenceModels.id, model.id))).rejects.toThrow();
    await expect(getDb().update(inferenceModels).set({ outputModalities: ['unknown'] }).where(eq(inferenceModels.id, model.id))).rejects.toThrow();
    await expect(getDb().update(inferenceModels).set({ outputModalities: [] }).where(eq(inferenceModels.id, model.id))).rejects.toThrow();
  });

  it('withdraws expired source after model-lock acquisition without importing a capability or price', async () => {
    const f = await fixture();
    const valid = Date.now();
    // First source read plans the exact route; the post-lock clock is past expiry.
    f.scope.expiresAt = new Date(valid + 1000).toISOString();
    const now = jest.spyOn(Date, 'now').mockReturnValue(valid);
    let calls = 0;
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockImplementation(() => {
      if (++calls === 2) now.mockReturnValue(valid + 2000);
      return f.scope;
    });
    await expect(runKaanaCatalogueSync({ reader: f.scopedReader, now: new Date(valid) })).rejects.toThrow('source authority changed');
    expect(await f.prices()).toEqual([]);
    expect(await getDb().select().from(inferenceModels).where(eq(inferenceModels.modelId, f.world.line('private')))).toEqual([]);
    expect(await deploymentsOf(f.world.line('private'))).toEqual([]);
  });

  it('rejects an audience different from the source review without creating a price', async () => {
    const f = await fixture();
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockReturnValue({ ...f.scope, keyId: 'other' });
    expect((await runKaanaCatalogueSync({ reader: f.scopedReader })).deployments.skipped.unattested_route).toBe(1);
    expect(await f.prices()).toEqual([]);
  });

  it.each(['other-id', 'other-price'])('preserves an existing active version on %s mismatch', async (mismatch) => {
    const f = await fixture();
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockReturnValue(f.scope);
    const id = mismatch === 'other-id' ? randomUUID() : f.scope.priceVersionId;
    await getDb().insert(priceVersions).values({ id, modelReference: f.route.modelReference, provider: f.route.provider,
      currency: 'USD', status: 'active', effectiveFrom: new Date('2020-01-01') });
    await getDb().insert(priceVersionUnitPrices).values(syncedUnitPrices({ input: mismatch === 'other-price' ? '0.099' : '0.072', output: '0.28' }).map(unit => ({ priceVersionId: id, ...unit })));
    const before = await f.prices();
    expect((await runKaanaCatalogueSync({ reader: f.scopedReader })).deployments.skipped.unattested_route).toBe(1);
    expect(await f.prices()).toEqual(before);
    expect(await deploymentsOf(f.world.line('private'))).toEqual([]);
  });

  it('reuses an exactly matching pre-existing version without replacing it', async () => {
    const f = await fixture();
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockReturnValue(f.scope);
    await getDb().insert(priceVersions).values({ id: f.scope.priceVersionId, modelReference: f.route.modelReference, provider: f.route.provider,
      currency: 'USD', status: 'active', effectiveFrom: new Date('2020-01-01') });
    await getDb().insert(priceVersionUnitPrices).values(syncedUnitPrices({ input: '0.072', output: '0.28' }).map(unit => ({ priceVersionId: f.scope.priceVersionId, ...unit })));
    const before = await f.prices();
    const result = await runKaanaCatalogueSync({ reader: f.scopedReader });
    expect(result.priceVersionsCreated).toBe(0);
    expect(await f.prices()).toEqual(before);
    expect(await deploymentsOf(f.world.line('private'))).toEqual([expect.objectContaining({ priceVersionId: f.scope.priceVersionId, status: 'disabled' })]);
  });

  async function reviewedFixture() {
    const f = await fixture();
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockImplementation(() => f.scope);
    await runKaanaCatalogueSync({ reader: f.scopedReader });
    const [deployment] = await getDb().select().from(inferenceDeployments)
      .where(eq(inferenceDeployments.internalRouteId, f.scope.deploymentId));
    const reviewedAt = new Date('2026-10-04T10:00:00Z');
    await getDb().update(inferenceDeployments).set({ legalReviewStatus: 'approved',
      legalReviewEvidenceRef: 'synthetic-specific-private-review', legalReviewedAt: reviewedAt })
      .where(eq(inferenceDeployments.id, deployment.id));
    const row = () => getDb().select().from(inferenceDeployments).where(eq(inferenceDeployments.id, deployment.id));
    return { ...f, row, reviewedAt };
  }

  it('preserves the exact private legal review across identical canonical reimport', async () => {
    const f = await reviewedFixture();
    const before = await f.row();
    const result = await runKaanaCatalogueSync({ reader: f.scopedReader });
    expect(result.deployments.upserted).toBe(1);
    expect(result.priceVersionsCreated).toBe(0);
    const facts = (rows: typeof before) => rows.map(({ updatedAt: _importTimestamp, ...row }) => row);
    expect(facts(await f.row())).toEqual(facts(before));
  });

  it.each(['privacy', 'regions', 'model', 'audience', 'price', 'parameters', 'route', 'revision'] as const)
    ('invalidates the prior private review before reimport with changed %s', async (change) => {
      const f = await reviewedFixture();
      const body = await f.scopedReader.listModels();
      const payload = body as { models: Record<string, unknown>[] };
      const model = payload.models[0];
      if (change === 'privacy') await getDb().update(inferenceProviders).set({ retainsPayloads: false, retentionDays: 0 })
        .where(eq(inferenceProviders.slug, f.world.provider));
      if (change === 'regions') f.descriptor.regions = [];
      if (change === 'model') model.contextTokens = 65536;
      if (change === 'parameters') model.acceptedParameters = ['max_tokens'];
      if (change === 'audience') { f.scope.keyId = 'different-reviewed-key'; f.descriptor.keyId = f.scope.keyId; }
      if (change === 'price') (model.listPrices as { input: string }[])[0].input = '0.073';
      if (change === 'route') {
        f.scope.deploymentId += '-new';
        f.descriptor.deploymentId = f.scope.deploymentId;
        (model.listPrices as { deploymentId: string }[])[0].deploymentId = f.scope.deploymentId;
      }
      if (change === 'revision') {
        f.scope.modelReference = `${f.world.line('private')}@new-reviewed-revision`;
        f.descriptor.modelReference = f.scope.modelReference;
        model.modelReference = f.scope.modelReference;
      }
      await runKaanaCatalogueSync({ reader: { ...f.scopedReader, listModels: async () => body } });
      expect(await f.row()).toEqual([expect.objectContaining({ status: 'disabled', permissionState: 'pending_review',
        legalReviewStatus: 'not_started', legalReviewEvidenceRef: null, legalReviewedAt: null, legalReviewedByUserId: null })]);
      expect(await f.prices()).toEqual([expect.objectContaining({ id: f.scope.priceVersionId, status: 'active' })]);
    });

  it('refuses a price ID belonging to a foreign route without modifying that route', async () => {
    const f = await fixture();
    jest.spyOn(scopedSource, 'sourceReviewedScopedAudience').mockReturnValue(f.scope);
    await getDb().insert(priceVersions).values({ id: f.scope.priceVersionId, modelReference: 'fixture/foreign@v1', provider: f.route.provider,
      currency: 'USD', status: 'active', effectiveFrom: new Date('2020-01-01') });
    const foreign = () => getDb().select().from(priceVersions).where(eq(priceVersions.id, f.scope.priceVersionId));
    const before = await foreign();
    expect((await runKaanaCatalogueSync({ reader: f.scopedReader })).deployments.skipped.unattested_route).toBe(1);
    expect(await f.prices()).toEqual([]);
    expect(await foreign()).toEqual(before);
  });
});
