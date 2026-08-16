/**
 * The catalogue's serving boundary and commercial-permission gate, against a
 * REAL Postgres.
 *
 * Two claims are load-bearing here and both are asserted with a positive
 * control beside them, because "the route was withheld" and "the fixture was
 * broken so nothing was found" are the same observation from inside a test:
 *
 *  1. **An internal-only route cannot be selected by a public credential** —
 *     paired with the same public viewer successfully selecting a PUBLIC route,
 *     and with the internal viewer successfully selecting the internal one. A
 *     fixture that failed to insert would fail those two, so the withholding
 *     cannot pass for the wrong reason.
 *  2. **A row carrying an internal route id and an upstream wholesale cost
 *     cannot serialize them** — paired with a scan that proves it CAN find a
 *     value which IS in the output. Without that control, a scanner that looked
 *     at nothing would report the same clean result.
 *
 * Every fixture owns its identifiers, so nothing here reads or counts a sibling
 * file's rows.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  inferenceRoutingProfileCandidates,
  inferenceRoutingProfiles,
} from '../../db/schema';
import {
  type CatalogueViewer,
  getCatalogueEntryForViewer,
  listCatalogueForViewer,
  listRoutingProfiles,
  PUBLIC_CATALOGUE_VIEWER,
  resolveCatalogueViewer,
  selectRouteForViewer,
  UNCONSTRAINED_ROUTING,
  UNGRANTABLE_SCOPES,
} from '../inferenceCatalogue.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

const INTERNAL_VIEWER = resolveCatalogueViewer({ type: 'internal', isInternal: true });

interface RouteFixture {
  readonly modelId: string;
  readonly modelReference: string;
  readonly revision: string;
  readonly providerSlug: string;
  readonly deploymentId: string;
}

/**
 * A complete, APPROVED route: publisher → model → current revision → provider →
 * deployment. Approved rather than default, because the default is deny and a
 * test of "who may see what" needs something visible to somebody.
 */
async function insertRoute(options: {
  availabilityScope: 'public_payg' | 'internal_alia' | 'oxy_hosted';
  commercialPermission:
    | 'public_resale_approved'
    | 'standard_application_use'
    | 'open_weight_hosting';
  permissionState?: 'pending_review' | 'approved' | 'suspended';
  internalRouteId?: string;
  wholesaleCost?: { amount: string; currency: string; unit: 'input_tokens'; per: number };
}): Promise<RouteFixture> {
  const db = getDb();
  const publisherSlug = `pub${suffix()}`;
  const modelSlug = `mdl${suffix()}`;
  const revision = `r${suffix()}`;
  const providerSlug = `prv${suffix()}`;

  await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: 'Fixture Pub' });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: 'Fixture Model',
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
    displayName: 'Fixture Provider',
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });

  const permissionState = options.permissionState ?? 'approved';
  const [deployment] = await db
    .insert(inferenceDeployments)
    .values({
      modelRevisionId: revisionRow.id,
      providerSlug,
      regions: ['us-west-2'],
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
      availabilityScope: options.availabilityScope,
      commercialPermission: options.commercialPermission,
      status: 'active',
      // The database refuses an approval whose legal review is not approved, so
      // an APPROVED fixture has to carry a review. That is the constraint doing
      // its job, and the fixture obeys it rather than working around it.
      ...(permissionState === 'approved'
        ? {
            legalReviewStatus: 'approved' as const,
            legalReviewedAt: new Date(),
            legalReviewEvidenceRef: `contract-register/${suffix()}`,
          }
        : {}),
      permissionState,
      ...(options.internalRouteId === undefined
        ? {}
        : { internalRouteId: options.internalRouteId }),
      ...(options.wholesaleCost === undefined
        ? {}
        : {
            upstreamWholesaleCostAmount: options.wholesaleCost.amount,
            upstreamWholesaleCostCurrency: options.wholesaleCost.currency,
            upstreamWholesaleCostUnit: options.wholesaleCost.unit,
            upstreamWholesaleCostPer: options.wholesaleCost.per,
          }),
    })
    .returning({ id: inferenceDeployments.id });

  if (model.modelId === null) throw new Error('the generated model id did not compose');

  return {
    modelId: model.modelId,
    modelReference: `${model.modelId}@${revision}`,
    revision,
    providerSlug,
    deploymentId: deployment.id,
  };
}

/* -------------------------------------------------------------------------- */
/*  1. Commercial permissions                                                 */
/* -------------------------------------------------------------------------- */

describe('an internal-only route cannot be selected by a public credential', () => {
  it('withholds the internal route, serves the public one, and shows the internal viewer both', async () => {
    const internalOnly = await insertRoute({
      availabilityScope: 'internal_alia',
      commercialPermission: 'standard_application_use',
    });
    const publicRoute = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });

    // The claim.
    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, internalOnly.modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toBeUndefined();

    // POSITIVE CONTROL, same viewer, same code path: a broken fixture or a
    // predicate that matched nothing would fail here, so the line above cannot
    // pass by accident.
    const served = await selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, publicRoute.modelId, UNCONSTRAINED_ROUTING);
    expect(served?.modelReference).toBe(publicRoute.modelReference);

    // SECOND CONTROL: the internal route is real and selectable — by the
    // principal it is for. Without this, "nobody can select it" and "it is
    // withheld from the public" are indistinguishable.
    const internalServed = await selectRouteForViewer(INTERNAL_VIEWER, internalOnly.modelId, UNCONSTRAINED_ROUTING);
    expect(internalServed?.modelReference).toBe(internalOnly.modelReference);
  });

  it('keeps the internal route out of the public catalogue listing too', async () => {
    const internalOnly = await insertRoute({
      availabilityScope: 'internal_alia',
      commercialPermission: 'standard_application_use',
    });
    const publicRoute = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });

    const publicIds = (await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER)).map(
      (entry) => entry.modelId
    );
    expect(publicIds).not.toContain(internalOnly.modelId);
    // Control, again scoped to a row this file owns rather than to a count.
    expect(publicIds).toContain(publicRoute.modelId);

    const internalIds = (await listCatalogueForViewer(INTERNAL_VIEWER)).map(
      (entry) => entry.modelId
    );
    expect(internalIds).toContain(internalOnly.modelId);
  });

  it('answers the detail read identically for withheld and non-existent', async () => {
    // Deliberately the same answer: distinguishing them would make the detail
    // endpoint an existence oracle for what Oxy runs internally.
    const internalOnly = await insertRoute({
      availabilityScope: 'internal_alia',
      commercialPermission: 'standard_application_use',
    });

    await expect(
      getCatalogueEntryForViewer(PUBLIC_CATALOGUE_VIEWER, internalOnly.modelId)
    ).resolves.toBeUndefined();
    await expect(
      getCatalogueEntryForViewer(PUBLIC_CATALOGUE_VIEWER, `nobody/nothing${suffix()}`)
    ).resolves.toBeUndefined();
  });
});

describe('the permission gate has no exemption', () => {
  it('withholds a pending_review PUBLIC route from the public viewer', async () => {
    const pending = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      permissionState: 'pending_review',
    });
    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, pending.modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toBeUndefined();
  });

  it('withholds a pending_review INTERNAL route from the internal viewer', async () => {
    // The exemption that does not exist. An internal route needs the same
    // approval a public one does; a branch here is where a gate silently widens.
    const pending = await insertRoute({
      availabilityScope: 'internal_alia',
      commercialPermission: 'standard_application_use',
      permissionState: 'pending_review',
    });
    await expect(selectRouteForViewer(INTERNAL_VIEWER, pending.modelId, UNCONSTRAINED_ROUTING)).resolves.toBeUndefined();

    // Control: the same viewer selects an APPROVED internal route, so the case
    // above is measuring the permission state and not the audience.
    const approved = await insertRoute({
      availabilityScope: 'internal_alia',
      commercialPermission: 'standard_application_use',
    });
    await expect(selectRouteForViewer(INTERNAL_VIEWER, approved.modelId, UNCONSTRAINED_ROUTING)).resolves.toBeDefined();
  });

  it('withholds a suspended route', async () => {
    const suspended = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      permissionState: 'suspended',
    });
    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, suspended.modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toBeUndefined();
  });
});

describe('the audience is default-deny', () => {
  it.each([
    ['no principal at all', undefined],
    ['an ordinary third-party application', { type: 'third_party', isInternal: false }],
    ['a first-party but customer-facing application', { type: 'first_party', isInternal: false }],
  ])('resolves %s to the public viewer', (_label, principal) => {
    const viewer = resolveCatalogueViewer(principal);
    expect(viewer.scopes).not.toContain('internal_alia');
    expect(viewer.label).toBe('public');
  });

  it.each([
    ['an internal application', { type: 'internal', isInternal: true }],
    ['a system application', { type: 'system', isInternal: false }],
    ['an application flagged internal', { type: 'third_party', isInternal: true }],
  ])('resolves %s to the internal viewer', (_label, principal) => {
    expect(resolveCatalogueViewer(principal).scopes).toContain('internal_alia');
  });

  it('grants no viewer a scope that is not grantable yet', async () => {
    // `enterprise` needs a billing entitlement and `byok_only` needs a validated
    // provider connection, neither of which exists. Asserted rather than left
    // implied, so adding one by hand goes red until somebody builds the check
    // that is supposed to guard it.
    const viewers: CatalogueViewer[] = [
      PUBLIC_CATALOGUE_VIEWER,
      INTERNAL_VIEWER,
      resolveCatalogueViewer(undefined),
      resolveCatalogueViewer({ type: 'third_party', isInternal: false }),
    ];
    for (const viewer of viewers) {
      for (const scope of UNGRANTABLE_SCOPES) {
        expect(viewer.scopes).not.toContain(scope);
      }
    }
  });

  it('serves nothing at all to a viewer with no scopes', async () => {
    const route = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });
    const empty: CatalogueViewer = { scopes: [], label: 'test-empty' };

    await expect(listCatalogueForViewer(empty)).resolves.toEqual([]);
    await expect(selectRouteForViewer(empty, route.modelId, UNCONSTRAINED_ROUTING)).resolves.toBeUndefined();

    // Control: the route is genuinely selectable, so the two lines above are
    // measuring the empty scope set and not a fixture that never landed.
    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, route.modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toBeDefined();
  });
});

describe('a pinned revision is never substituted', () => {
  it('refuses a revision that is not served, rather than falling back to the current one', async () => {
    const route = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });

    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, `${route.modelId}@does-not-exist`, UNCONSTRAINED_ROUTING)
    ).resolves.toBeUndefined();

    // Controls in both forms: the unpinned request resolves, and the correctly
    // pinned one resolves to exactly those weights.
    const unpinned = await selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, route.modelId, UNCONSTRAINED_ROUTING);
    expect(unpinned?.modelReference).toBe(route.modelReference);

    const pinned = await selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, route.modelReference, UNCONSTRAINED_ROUTING);
    expect(pinned?.modelReference).toBe(route.modelReference);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The customer-safe serializer                                           */
/* -------------------------------------------------------------------------- */

/** Every string anywhere in a JSON-shaped value, however deeply nested. */
function everyStringIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(everyStringIn);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(everyStringIn);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  return [];
}

describe('the customer view cannot carry an internal route id or a wholesale cost', () => {
  it('serializes neither, from a row that holds both', async () => {
    const internalRouteId = `relay-route-${suffix()}`;
    const wholesaleAmount = '3.140000000000';

    const route = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      internalRouteId,
      wholesaleCost: {
        amount: wholesaleAmount,
        currency: 'USD',
        unit: 'input_tokens',
        per: 1_000_000,
      },
    });

    const entries = await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER);
    const entry = entries.find((candidate) => candidate.modelId === route.modelId);

    // Vacuity floor for the whole test: the entry EXISTS. Without it, a fixture
    // that never became visible would make every "is absent" assertion below
    // trivially true.
    expect(entry).toBeDefined();

    const strings = everyStringIn(entry);

    // POSITIVE CONTROL on the scan itself: it can find a value that IS in the
    // output. A scanner that read nothing would report the same clean result as
    // a serializer that leaked nothing.
    expect(strings).toContain(route.modelId);
    expect(strings).toContain(route.providerSlug);

    // The claim.
    expect(strings).not.toContain(internalRouteId);
    expect(strings).not.toContain(wholesaleAmount);
    // And no partial reassembly: the unit and denominator are protected as a
    // group precisely so no subset of the rate survives.
    expect(strings).not.toContain('input_tokens');
    expect(strings).not.toContain('1000000');

    // Deeper than a key check: the serialized JSON does not contain the values
    // as SUBSTRINGS either, which a differently-named field would still fail.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(internalRouteId);
    expect(serialized).not.toContain(wholesaleAmount);
  });

  it('withholds the legal-review evidence reference too', async () => {
    const route = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });

    const [row] = await getDb()
      .select({ evidenceRef: inferenceDeployments.legalReviewEvidenceRef })
      .from(inferenceDeployments)
      .where(eqDeployment(route.deploymentId));

    expect(row.evidenceRef).not.toBeNull();

    const entries = await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER);
    const entry = entries.find((candidate) => candidate.modelId === route.modelId);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(row.evidenceRef ?? 'unreachable');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Routing profiles are not models                                        */
/* -------------------------------------------------------------------------- */

describe('routing profiles are a separate collection', () => {
  it('never appear among models, and resolve both candidate forms', async () => {
    const route = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });

    const slug = `fast${suffix()}`;
    const [profile] = await getDb()
      .insert(inferenceRoutingProfiles)
      .values({
        slug,
        displayName: 'Fixture Fast',
        optimiseFor: 'latency',
        isProductPreset: true,
      })
      .returning({ id: inferenceRoutingProfiles.id });

    const [modelRow] = await getDb()
      .select({ id: inferenceModels.id })
      .from(inferenceModels)
      .where(eqModelId(route.modelId));

    await getDb()
      .insert(inferenceRoutingProfileCandidates)
      .values({ routingProfileId: profile.id, modelId: modelRow.id, priority: 0 });

    const profiles = await listRoutingProfiles();
    const mine = profiles.find((candidate) => candidate.slug === slug);
    expect(mine).toBeDefined();
    // The UNPINNED form resolves to the model line, not to a revision.
    expect(mine?.candidates).toEqual([{ modelReference: route.modelId, priority: 0 }]);

    // A profile slug can never be read as a model id, so a caller always knows
    // whether they asked for a concrete model or for Oxy to choose one.
    expect(mine?.slug).not.toContain('/');

    const models = await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER);
    expect(models.map((entry) => entry.modelId)).not.toContain(slug);
    // Control: the catalogue read is working, so the line above is not vacuous.
    expect(models.map((entry) => entry.modelId)).toContain(route.modelId);
  });
});

function eqDeployment(id: string) {
  return eq(inferenceDeployments.id, id);
}

function eqModelId(modelId: string) {
  return eq(inferenceModels.modelId, modelId);
}
