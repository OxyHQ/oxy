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
  priceVersions,
  priceVersionUnitPrices,
} from '../../db/schema';
import {
  type CatalogueViewer,
  getCatalogueEntryForViewer,
  listCatalogueForViewer,
  listRoutingProfiles,
  PUBLIC_CATALOGUE_VIEWER,
  resolveCatalogueViewer,
  resolveEdgeRoute,
  selectRouteForViewer,
  TEXT_COMPLETION_MODALITY,
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
  availabilityScope: 'public_payg' | 'internal_alia' | 'oxy_hosted' | 'byok_only';
  commercialPermission:
    | 'public_resale_approved'
    | 'standard_application_use'
    | 'open_weight_hosting'
    | 'customer_byok';
  permissionState?: 'pending_review' | 'approved' | 'suspended';
  internalRouteId?: string;
  wholesaleCost?: { amount: string; currency: string; unit: 'input_tokens'; per: number };
  /**
   * A published customer price for this route. Omitted leaves
   * `price_version_id` null, which is what an unpriced route looks like — the
   * state the edge refuses with `unpriced-route`.
   *
   * `unitPrices: []` is a distinct, deliberately reachable case: a price VERSION
   * that exists with no unit prices under it.
   */
  price?: {
    currency: string;
    unitPrices: ReadonlyArray<{ unit: 'input_tokens' | 'output_tokens'; amount: string; per: number }>;
  };
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

  // The price version is scoped to `(modelReference, provider)` with no foreign
  // key back into the catalogue, exactly as the ledger defines it, so a receipt
  // stays reproducible after a revision retires.
  let priceVersionId: string | undefined;
  if (options.price !== undefined) {
    const [version] = await db
      .insert(priceVersions)
      .values({
        status: 'active',
        modelReference: `${model.modelId ?? ''}@${revision}`,
        provider: providerSlug,
        currency: options.price.currency,
        effectiveFrom: new Date(),
      })
      .returning({ id: priceVersions.id });
    priceVersionId = version.id;
    if (options.price.unitPrices.length > 0) {
      await db.insert(priceVersionUnitPrices).values(
        options.price.unitPrices.map((unitPrice) => ({
          priceVersionId: version.id,
          unit: unitPrice.unit,
          amount: unitPrice.amount,
          per: unitPrice.per,
        }))
      );
    }
  }

  const permissionState = options.permissionState ?? 'approved';
  const [deployment] = await db
    .insert(inferenceDeployments)
    .values({
      modelRevisionId: revisionRow.id,
      ...(priceVersionId === undefined ? {} : { priceVersionId }),
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

/* -------------------------------------------------------------------------- */
/*  1b. The published price on a catalogue entry                              */
/* -------------------------------------------------------------------------- */

/**
 * `pricing` on a catalogue entry, against real `price_versions` rows.
 *
 * The claim is that a route's published price REACHES the customer's entry, and
 * the control it needs is the opposite case in the same call: an unpriced route
 * carries no `pricing`. Without that pair, "the price is absent" and "this
 * serializer never populates prices at all" are the same observation — which is
 * exactly the state this code was in before, for a whole workstream, while the
 * edge beside it already refused to serve a route with no price.
 */
describe('a route’s published price reaches the catalogue entry', () => {
  it('carries the primary route’s price snapshot, and omits it for an unpriced route', async () => {
    const priced = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      price: {
        currency: 'USD',
        unitPrices: [
          // Two units with DIFFERENT `per` denominators, because a per-million
          // input price beside a per-thousand output price is the ordinary case
          // and a serializer that assumed one denominator would still pass a
          // fixture where both agreed.
          { unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000 },
          { unit: 'output_tokens', amount: '0.015000000000', per: 1_000 },
        ],
      },
    });
    const unpriced = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });

    const entries = await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER);

    const pricedEntry = entries.find((entry) => entry.modelId === priced.modelId);
    // Fixture control: if this row did not land, every assertion below would
    // read as "no price was published" rather than as a broken fixture.
    expect(pricedEntry).toBeDefined();
    expect(pricedEntry?.pricing?.currency).toBe('USD');
    // The amount is compared as the exact STRING the ledger stores. A numeric
    // comparison here would pass on a value that had been through a float.
    expect(pricedEntry?.pricing?.unitPrices).toEqual([
      { unit: 'input_tokens', amount: '3.000000000000', per: 1_000_000, currency: 'USD' },
      { unit: 'output_tokens', amount: '0.015000000000', per: 1_000, currency: 'USD' },
    ]);

    // THE CONTROL. Same call, same viewer, same code path: a route naming no
    // price version publishes no price.
    const unpricedEntry = entries.find((entry) => entry.modelId === unpriced.modelId);
    expect(unpricedEntry).toBeDefined();
    expect(unpricedEntry?.pricing).toBeUndefined();
  });

  it('cannot reach the BYOK case at all, so an absent price means exactly “not yet priced”', async () => {
    // Worth pinning, because the tempting reading of an absent `pricing` is
    // "BYOK-only" — the database's `inference_deployments_byok_has_no_price_version`
    // does force a BYOK route's price version to be null. But `byok_only` is in
    // UNGRANTABLE_SCOPES, so no viewer is ever served one and no BYOK route is
    // ever LISTED. An absent price on an entry a customer can actually see
    // therefore has one meaning: the route is not yet priced, which is the state
    // `resolveEdgeRoute` refuses with `unpriced-route`.
    const byok = await insertRoute({
      availabilityScope: 'byok_only',
      commercialPermission: 'customer_byok',
    });
    const priced = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      price: {
        currency: 'USD',
        unitPrices: [{ unit: 'input_tokens', amount: '2.000000000000', per: 1_000_000 }],
      },
    });

    for (const viewer of [PUBLIC_CATALOGUE_VIEWER, INTERNAL_VIEWER]) {
      const ids = (await listCatalogueForViewer(viewer)).map((entry) => entry.modelId);
      expect(ids).not.toContain(byok.modelId);
      // CONTROL, per viewer: the listing is not simply empty. Without this, a
      // broken fixture or a predicate matching nothing reads the same way.
      expect(ids).toContain(priced.modelId);
    }
  });

  it('publishes no price for a version that exists with no unit prices', async () => {
    // `priceSnapshotSchema` requires at least one unit price, so an empty
    // snapshot cannot be published at all. The honest answer for a route whose
    // price version carries no prices is the same as for an unpriced one — and
    // crucially it must not THROW, which would take the whole listing down for
    // every customer over one malformed row.
    const emptyPrice = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      price: { currency: 'USD', unitPrices: [] },
    });

    const entries = await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER);
    const entry = entries.find((candidate) => candidate.modelId === emptyPrice.modelId);
    expect(entry).toBeDefined();
    expect(entry?.pricing).toBeUndefined();
  });

  it('never publishes the deployment’s own price_version_id as a top-level field', async () => {
    // The version id is customer-facing INSIDE the snapshot, where it names the
    // record a receipt can be re-priced against. It is not a property of the
    // entry, and the customer-safe column allow-list is what keeps it from
    // becoming one — `joinPriceVersionId` is a join key, not a serialized field.
    const priced = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      price: {
        currency: 'USD',
        unitPrices: [{ unit: 'input_tokens', amount: '1.500000000000', per: 1_000_000 }],
      },
    });

    const entry = (await listCatalogueForViewer(PUBLIC_CATALOGUE_VIEWER)).find(
      (candidate) => candidate.modelId === priced.modelId
    );
    expect(entry).toBeDefined();
    // POSITIVE CONTROL for the scan: the id IS findable where it belongs, so a
    // scan that looked at nothing could not report the same clean result.
    expect(entry?.pricing?.priceVersionId).toEqual(expect.any(String));
    expect(Object.keys(entry ?? {})).not.toContain('priceVersionId');
    expect(Object.keys(entry ?? {})).not.toContain('joinPriceVersionId');
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
    const internalRouteId = `kaana-route-${suffix()}`;
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

  it('uses the protected Kaana deployment id internally without publishing it', async () => {
    const internalRouteId = `dep_exact_${suffix()}`;
    const route = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
      internalRouteId,
      price: {
        currency: 'USD',
        unitPrices: [
          { unit: 'input_tokens', amount: '1.000000000000', per: 1_000_000 },
        ],
      },
    });

    const entry = await getCatalogueEntryForViewer(PUBLIC_CATALOGUE_VIEWER, route.modelId);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(internalRouteId);
    expect(route.deploymentId).not.toBe(internalRouteId);

    const resolution = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      route.modelId,
      UNCONSTRAINED_ROUTING,
      TEXT_COMPLETION_MODALITY
    );
    expect(resolution).toMatchObject({
      status: 'resolved',
      route: { deploymentId: internalRouteId },
    });
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

  it('uses the selected optimisation score to break equal-priority ties deterministically', async () => {
    const qualityRoute = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });
    const latencyRoute = await insertRoute({
      availabilityScope: 'public_payg',
      commercialPermission: 'public_resale_approved',
    });
    const rows = await getDb()
      .select({ id: inferenceModels.id, modelId: inferenceModels.modelId })
      .from(inferenceModels);
    const qualityModelId = rows.find((row) => row.modelId === qualityRoute.modelId)?.id;
    const latencyModelId = rows.find((row) => row.modelId === latencyRoute.modelId)?.id;
    if (qualityModelId === undefined || latencyModelId === undefined) {
      throw new Error('routing-profile optimisation fixture did not resolve its models');
    }

    const latencySlug = `latency${suffix()}`;
    const qualitySlug = `quality${suffix()}`;
    const profiles = await getDb()
      .insert(inferenceRoutingProfiles)
      .values([
        {
          slug: latencySlug,
          displayName: 'Latency fixture',
          optimiseFor: 'latency',
          isProductPreset: false,
        },
        {
          slug: qualitySlug,
          displayName: 'Quality fixture',
          optimiseFor: 'quality',
          isProductPreset: false,
        },
      ])
      .returning({ id: inferenceRoutingProfiles.id, slug: inferenceRoutingProfiles.slug });

    for (const profile of profiles) {
      await getDb()
        .insert(inferenceRoutingProfileCandidates)
        .values([
          {
            routingProfileId: profile.id,
            modelId: qualityModelId,
            priority: 0,
            latencyScore: 10,
            qualityScore: 90,
          },
          {
            routingProfileId: profile.id,
            modelId: latencyModelId,
            priority: 0,
            latencyScore: 90,
            qualityScore: 10,
          },
        ]);
    }

    const listed = await listRoutingProfiles();
    const latencyProfile = listed.find((profile) => profile.slug === latencySlug);
    const qualityProfile = listed.find((profile) => profile.slug === qualitySlug);
    expect(latencyProfile?.candidates.map((candidate) => candidate.modelReference)).toEqual([
      latencyRoute.modelId,
      qualityRoute.modelId,
    ]);
    expect(qualityProfile?.candidates.map((candidate) => candidate.modelReference)).toEqual([
      qualityRoute.modelId,
      latencyRoute.modelId,
    ]);
  });
});

function eqDeployment(id: string) {
  return eq(inferenceDeployments.id, id);
}

function eqModelId(modelId: string) {
  return eq(inferenceModels.modelId, modelId);
}
