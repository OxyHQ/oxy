/**
 * A routing policy's constraints, applied to real candidate routes in a real
 * Postgres (issue #1011, epic #972 workstream 6).
 *
 * ## Why the fixture is the whole test
 *
 * The catalogue is EMPTY in production, so a filter over it passes trivially and
 * proves nothing. Every case here supplies its own candidates — normally TWO
 * deployments of ONE model revision, differing only in the column the control
 * under test reads.
 *
 * ## Which LEVEL a control lives at decides its test shape — check first
 *
 * A control read off `inference_deployments` (retention, training, provider,
 * regions, scope, dedicated capacity) can differ between two candidates of one
 * model, so it gets the two-deployments-differing-in-one-field shape below. A
 * control read off `inference_models` (`allowedLicenseIds`,
 * `requireCommercialUseRights`) CANNOT: every deployment of a model shares its
 * licence, so both candidates stand or fall together and the only honest shape
 * is the refusal plus a positive control on a second MODEL that satisfies it.
 * Choosing the wrong shape for a model-level control produces a fixture that
 * cannot express the case at all. Establish the level before writing the test.
 *
 * ## The ordering is the mutation guard
 *
 * Candidates are ordered by provider slug and the resolver takes the first that
 * qualifies, so each pair is planted with the VIOLATING route on an `a…` slug
 * and the conforming one on a `z…` slug. Each case then asserts BOTH directions
 * against the same pair:
 *
 *  - with the control set, the `z…` route is served;
 *  - with the control absent, the `a…` route is served.
 *
 * The second assertion is what makes the first falsifiable. Delete the filter
 * and the first goes red, because the violating route sorts first — a fixture
 * whose conforming route happened to sort first would pass with no filter at
 * all, which is the shape of a test that measures nothing.
 *
 * ## A refusal has to say WHY it refused
 *
 * `policy-excluded` and `unknown-model` are different answers and the tests
 * assert which one came back, never merely that something was refused: an empty
 * candidate set, an unapproved route and a model that does not exist all produce
 * a refusal too, and any of them would satisfy a bare "it did not resolve".
 *
 * ## The data policy read is the DEPLOYMENT's
 *
 * Every provider ORGANISATION row here is planted with a retaining, training
 * posture, so a filter that read the provider's default instead of the route's
 * own columns would exclude the conforming deployment and go red.
 */

import { randomUUID } from 'node:crypto';
import { routingPolicySchema, type RoutingPolicy } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
} from '../../db/schema';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import {
  EVERY_ROUTING_CONTROL_IS_CLASSIFIED,
  PUBLIC_CATALOGUE_VIEWER,
  resolveCatalogueViewer,
  resolveEdgeRoute,
  routingConstraintsOf,
  selectRouteForViewer,
  UNCONSTRAINED_ROUTING,
  UNFILTERED_ROUTING_CONTROLS,
  type RoutingConstraints,
} from '../inferenceCatalogue.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

jest.setTimeout(60_000);

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

const INTERNAL_VIEWER = resolveCatalogueViewer({ type: 'internal', isInternal: true });

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

interface ModelFixture {
  /** The `inference_models` row id, for further inserts. */
  readonly rowId: string;
  /** The canonical `<publisher>/<model>` a customer names. */
  readonly modelId: string;
  readonly revisionId: string;
  readonly revision: string;
  readonly modelReference: string;
}

/** One publisher, one model, one current revision. */
async function insertModel(
  options: { licenseId?: string; commercialUseAllowed?: boolean } = {}
): Promise<ModelFixture> {
  const db = getDb();
  const publisherSlug = `pub${suffix()}`;
  const modelSlug = `mdl${suffix()}`;
  const revision = `r${suffix()}`;

  await db
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: 'Constraint Fixture Publisher' });

  const [model] = await db
    .insert(inferenceModels)
    .values({
      publisherSlug,
      slug: modelSlug,
      displayName: 'Constraint Fixture Model',
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
      licenseId: options.licenseId ?? 'apache-2.0',
      licenseDisplayName: 'Fixture Licence',
      commercialUseAllowed: options.commercialUseAllowed ?? true,
      requiresAttribution: false,
      releaseKind: 'open_weight',
    })
    .returning({ id: inferenceModels.id, modelId: inferenceModels.modelId });

  const [revisionRow] = await db
    .insert(inferenceModelRevisions)
    .values({ modelId: model.id, revision, releasedAt: new Date(), isCurrent: true })
    .returning({ id: inferenceModelRevisions.id });

  if (model.modelId === null) throw new Error('the generated model id did not compose');

  return {
    rowId: model.id,
    modelId: model.modelId,
    revisionId: revisionRow.id,
    revision,
    modelReference: `${model.modelId}@${revision}`,
  };
}

interface DeploymentOptions {
  /**
   * Fixes the provider slug's first character, and therefore this route's place
   * in the resolver's `order by provider_slug`. `'a'` is the route a broken
   * filter would serve; `'z'` is the conforming one.
   */
  readonly rank: 'a' | 'z';
  readonly retainsPayloads?: boolean;
  readonly retentionDays?: number;
  readonly trainsOnCustomerData?: boolean;
  readonly zeroDataRetentionAvailable?: boolean;
  readonly regions?: string[];
  readonly availabilityScope?: 'public_payg' | 'oxy_hosted' | 'internal_alia';
  readonly dedicatedCapacity?: boolean;
  /** Publish the route with no price version, so nothing can be quoted. */
  readonly unpriced?: boolean;
}

/**
 * The commercial permission each audience requires.
 *
 * The table refuses a `public_payg` route without an approved resale permission
 * and this fixture obeys the constraint rather than working around it.
 */
const PERMISSION_FOR_SCOPE = {
  public_payg: 'public_resale_approved',
  oxy_hosted: 'open_weight_hosting',
  internal_alia: 'standard_application_use',
} as const;

/** One approved, priced deployment of `model`, on its own provider. */
async function insertDeployment(
  model: ModelFixture,
  options: DeploymentOptions
): Promise<{ providerSlug: string }> {
  const db = getDb();
  const providerSlug = `${options.rank}prv${suffix()}`;
  const scope = options.availabilityScope ?? 'public_payg';

  // The provider ORGANISATION's own posture is deliberately the OPPOSITE of the
  // conforming deployment's: it retains, it trains, and it offers no zero
  // retention. A filter reading the organisation rather than the route would
  // exclude every conforming candidate here and fail loudly.
  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: 'Constraint Fixture Provider',
    kind: 'third_party',
    retainsPayloads: true,
    retentionDays: 30,
    trainsOnCustomerData: true,
    zeroDataRetentionAvailable: false,
  });

  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: model.modelReference,
      provider: providerSlug,
      status: 'active',
      effectiveFrom: new Date(Date.now() - 60_000),
    })
    .returning({ id: priceVersions.id });

  await db.insert(priceVersionUnitPrices).values([
    {
      priceVersionId: priceVersion.id,
      unit: 'input_tokens',
      amount: '3.000000000000',
      per: 1_000_000,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'output_tokens',
      amount: '15.000000000000',
      per: 1_000_000,
    },
  ]);

  await db.insert(inferenceDeployments).values({
    modelRevisionId: model.revisionId,
    providerSlug,
    regions: options.regions ?? ['us-west-2'],
    retainsPayloads: options.retainsPayloads ?? false,
    retentionDays: options.retentionDays ?? 0,
    trainsOnCustomerData: options.trainsOnCustomerData ?? false,
    zeroDataRetentionAvailable: options.zeroDataRetentionAvailable ?? true,
    availabilityScope: scope,
    commercialPermission: PERMISSION_FOR_SCOPE[scope],
    dedicatedCapacity: options.dedicatedCapacity ?? false,
    status: 'active',
    legalReviewStatus: 'approved',
    legalReviewedAt: new Date(),
    legalReviewEvidenceRef: `contract-register/${suffix()}`,
    permissionState: 'approved',
    ...(options.unpriced ? {} : { priceVersionId: priceVersion.id }),
  });

  return { providerSlug };
}

/** The constraints a policy with exactly these controls set would impose. */
function constrain(overrides: Partial<RoutingConstraints>): RoutingConstraints {
  return { ...UNCONSTRAINED_ROUTING, ...overrides };
}

/** The provider a request resolves to, or the refusal it produced instead. */
async function servingProvider(
  modelReference: string,
  constraints: RoutingConstraints
): Promise<string> {
  const resolution = await resolveEdgeRoute(
    PUBLIC_CATALOGUE_VIEWER,
    modelReference,
    constraints
  );
  if (resolution.status !== 'resolved') {
    throw new Error(`expected a resolved route, got ${resolution.status}`);
  }
  return resolution.route.provider;
}

/* -------------------------------------------------------------------------- */
/*  1. Each control excludes the route that fails it — both directions         */
/* -------------------------------------------------------------------------- */

describe('a data-handling control excludes the route that fails it', () => {
  it('serves the zero-retention route, and the retaining one when nothing requires it', async () => {
    const model = await insertModel();
    const retaining = await insertDeployment(model, {
      rank: 'a',
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: false,
    });
    const zeroRetention = await insertDeployment(model, { rank: 'z' });

    // THE CLAIM: the constrained route is not selected, the conforming one is.
    await expect(
      servingProvider(model.modelId, constrain({ requireZeroDataRetention: true }))
    ).resolves.toBe(zeroRetention.providerSlug);

    // POSITIVE CONTROL, and the mutation guard: with the control absent, the
    // route that violates it is exactly what this pair resolves to. Remove the
    // filter and the assertion above returns THIS provider instead.
    await expect(servingProvider(model.modelId, UNCONSTRAINED_ROUTING)).resolves.toBe(
      retaining.providerSlug
    );
  });

  it('reads the ROUTE’s retention columns, not the provider organisation’s', async () => {
    // Every provider row this file plants retains and trains. If the filter read
    // the organisation's default, the zero-retention deployment below would be
    // excluded and the request would be refused instead of served.
    const model = await insertModel();
    const zeroRetention = await insertDeployment(model, { rank: 'a' });

    await expect(
      servingProvider(
        model.modelId,
        constrain({ requireZeroDataRetention: true, prohibitTrainingOnCustomerData: true })
      )
    ).resolves.toBe(zeroRetention.providerSlug);
  });

  it('excludes a route that offers zero retention as a CAPABILITY while still retaining', async () => {
    // `zero_data_retention_available` says the route CAN be run without
    // retention; `retains_payloads` says what it does. A capability-only check
    // would serve this route and tell the customer their data is not kept.
    const model = await insertModel();
    await insertDeployment(model, {
      rank: 'a',
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: true,
    });
    const actuallyZero = await insertDeployment(model, { rank: 'z' });

    await expect(
      servingProvider(model.modelId, constrain({ requireZeroDataRetention: true }))
    ).resolves.toBe(actuallyZero.providerSlug);
  });

  it('serves the non-training route, and the training one when nothing prohibits it', async () => {
    const model = await insertModel();
    // The table refuses training without retention, so both routes retain and
    // differ ONLY in the training flag.
    const training = await insertDeployment(model, {
      rank: 'a',
      retainsPayloads: true,
      retentionDays: 30,
      trainsOnCustomerData: true,
      zeroDataRetentionAvailable: false,
    });
    const notTraining = await insertDeployment(model, {
      rank: 'z',
      retainsPayloads: true,
      retentionDays: 30,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: false,
    });

    await expect(
      servingProvider(model.modelId, constrain({ prohibitTrainingOnCustomerData: true }))
    ).resolves.toBe(notTraining.providerSlug);
    await expect(servingProvider(model.modelId, UNCONSTRAINED_ROUTING)).resolves.toBe(
      training.providerSlug
    );
  });
});

describe('the provider, residency and hosting controls exclude the same way', () => {
  it('honours a provider denylist', async () => {
    const model = await insertModel();
    const denied = await insertDeployment(model, { rank: 'a' });
    const permitted = await insertDeployment(model, { rank: 'z' });

    await expect(
      servingProvider(model.modelId, constrain({ providerDenylist: [denied.providerSlug] }))
    ).resolves.toBe(permitted.providerSlug);
    await expect(servingProvider(model.modelId, UNCONSTRAINED_ROUTING)).resolves.toBe(
      denied.providerSlug
    );
  });

  it('honours a provider allowlist, and an EMPTY allowlist constrains nothing', async () => {
    const model = await insertModel();
    const first = await insertDeployment(model, { rank: 'a' });
    const allowed = await insertDeployment(model, { rank: 'z' });

    await expect(
      servingProvider(model.modelId, constrain({ providerAllowlist: [allowed.providerSlug] }))
    ).resolves.toBe(allowed.providerSlug);

    // The degenerate input. `[].includes(x)` is false for every x, so an empty
    // allowlist written as a bare membership test would exclude EVERY route —
    // the contract says it means "no allowlist".
    await expect(
      servingProvider(model.modelId, constrain({ providerAllowlist: [] }))
    ).resolves.toBe(first.providerSlug);
  });

  it('requires every region of a route to be allowed, not merely one of them', async () => {
    const model = await insertModel();
    // Which region inside a deployment serves a request is the data plane's
    // decision, so a route that MAY run outside the allowed set cannot honour a
    // residency requirement — the qualifying test is a subset, not an overlap.
    const spillsOutside = await insertDeployment(model, {
      rank: 'a',
      regions: ['eu-west-1', 'us-west-2'],
    });
    const contained = await insertDeployment(model, { rank: 'z', regions: ['eu-west-1'] });

    await expect(
      servingProvider(model.modelId, constrain({ allowedRegions: ['eu-west-1'] }))
    ).resolves.toBe(contained.providerSlug);
    await expect(servingProvider(model.modelId, UNCONSTRAINED_ROUTING)).resolves.toBe(
      spillsOutside.providerSlug
    );
  });

  it('honours a denied region', async () => {
    const model = await insertModel();
    const denied = await insertDeployment(model, { rank: 'a', regions: ['us-west-2'] });
    const permitted = await insertDeployment(model, { rank: 'z', regions: ['eu-west-1'] });

    await expect(
      servingProvider(model.modelId, constrain({ deniedRegions: ['us-west-2'] }))
    ).resolves.toBe(permitted.providerSlug);
    await expect(servingProvider(model.modelId, UNCONSTRAINED_ROUTING)).resolves.toBe(
      denied.providerSlug
    );
  });

  it('honours Oxy-hosted-only', async () => {
    const model = await insertModel();
    const thirdParty = await insertDeployment(model, { rank: 'a', availabilityScope: 'public_payg' });
    const oxyHosted = await insertDeployment(model, { rank: 'z', availabilityScope: 'oxy_hosted' });

    await expect(
      servingProvider(model.modelId, constrain({ oxyHostedOnly: true }))
    ).resolves.toBe(oxyHosted.providerSlug);
    await expect(servingProvider(model.modelId, UNCONSTRAINED_ROUTING)).resolves.toBe(
      thirdParty.providerSlug
    );
  });

  it('requires dedicated capacity when the policy requires it, and “prefer” filters nothing', async () => {
    const model = await insertModel();
    const shared = await insertDeployment(model, { rank: 'a', dedicatedCapacity: false });
    const dedicated = await insertDeployment(model, { rank: 'z', dedicatedCapacity: true });

    await expect(
      servingProvider(model.modelId, constrain({ dedicatedCapacity: 'require' }))
    ).resolves.toBe(dedicated.providerSlug);

    // `prefer` is a RANKING among routes that already qualify — routing
    // execution, and the data plane's. It must never exclude a candidate.
    await expect(
      servingProvider(model.modelId, constrain({ dedicatedCapacity: 'prefer' }))
    ).resolves.toBe(shared.providerSlug);

    // `disabled` is the other arm a route can fail: reserved capacity belongs to
    // one enterprise account, so a policy that says "shared" gets shared.
    await expect(
      servingProvider(model.modelId, constrain({ dedicatedCapacity: 'disabled' }))
    ).resolves.toBe(shared.providerSlug);
  });
});

describe('the licence controls are model-level, so both candidates stand or fall together', () => {
  it('refuses a model with no commercial use rights, and serves one that has them', async () => {
    // `commercial_use_allowed` lives on `inference_models`, so two deployments of
    // one model can never differ on it. The pair here is two MODELS.
    const nonCommercial = await insertModel({ commercialUseAllowed: false });
    await insertDeployment(nonCommercial, { rank: 'a' });
    const commercial = await insertModel({ commercialUseAllowed: true });
    const served = await insertDeployment(commercial, { rank: 'a' });

    const constraints = constrain({ requireCommercialUseRights: true });

    const refused = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      nonCommercial.modelId,
      constraints
    );
    expect(refused).toEqual({
      status: 'policy-excluded',
      modelReference: nonCommercial.modelId,
      constraints: ['requireCommercialUseRights'],
    });

    // POSITIVE CONTROL on the same control: a model that HAS the rights resolves.
    await expect(servingProvider(commercial.modelId, constraints)).resolves.toBe(
      served.providerSlug
    );
    // SECOND CONTROL: the refused model is genuinely servable without the
    // control, so the refusal above is measuring the control and not a fixture
    // that never landed.
    await expect(
      servingProvider(nonCommercial.modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toBeTruthy();
  });

  it('honours an allowed-licence list, and an EMPTY list constrains nothing', async () => {
    const model = await insertModel({ licenseId: 'cc-by-nc-4.0' });
    const deployment = await insertDeployment(model, { rank: 'a' });

    const refused = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      model.modelId,
      constrain({ allowedLicenseIds: ['apache-2.0'] })
    );
    expect(refused).toEqual({
      status: 'policy-excluded',
      modelReference: model.modelId,
      constraints: ['allowedLicenseIds'],
    });

    await expect(
      servingProvider(model.modelId, constrain({ allowedLicenseIds: ['cc-by-nc-4.0'] }))
    ).resolves.toBe(deployment.providerSlug);
    await expect(
      servingProvider(model.modelId, constrain({ allowedLicenseIds: [] }))
    ).resolves.toBe(deployment.providerSlug);
  });
});

describe('byokPreference', () => {
  it('refuses every shared route when the policy REQUIRES the customer’s own credential', async () => {
    // `byok_only` is in `UNGRANTABLE_SCOPES` — no viewer can be served one until
    // workstream 10 lands provider connections — so `require` is unsatisfiable
    // today. Refusing loudly and naming the control is the point: the
    // alternative is serving an Oxy-credentialled route to a policy that said
    // "use mine", which is the substitution issue #1011 is about.
    const model = await insertModel();
    const shared = await insertDeployment(model, { rank: 'a' });

    const refused = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      model.modelId,
      constrain({ byokPreference: 'require' })
    );
    expect(refused).toEqual({
      status: 'policy-excluded',
      modelReference: model.modelId,
      constraints: ['byokPreference'],
    });

    await expect(
      servingProvider(model.modelId, constrain({ byokPreference: 'disabled' }))
    ).resolves.toBe(shared.providerSlug);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The refusal                                                            */
/* -------------------------------------------------------------------------- */

describe('a request that cannot be served under its own policy is refused', () => {
  it('refuses when EVERY candidate violates the policy, naming the control', async () => {
    const model = await insertModel();
    await insertDeployment(model, {
      rank: 'a',
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: false,
    });
    await insertDeployment(model, {
      rank: 'z',
      retainsPayloads: true,
      retentionDays: 7,
      zeroDataRetentionAvailable: false,
    });

    const refused = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      model.modelId,
      constrain({ requireZeroDataRetention: true })
    );

    // The exact answer, not merely "not resolved": the status, the reference and
    // the control. An unrelated refusal would fail this.
    expect(refused).toEqual({
      status: 'policy-excluded',
      modelReference: model.modelId,
      constraints: ['requireZeroDataRetention'],
    });

    // POSITIVE CONTROL: without the control, one of the very same candidates is
    // served — so the refusal is the policy and not an empty catalogue.
    const served = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      model.modelId,
      UNCONSTRAINED_ROUTING
    );
    expect(served.status).toBe('resolved');
  });

  it('names EVERY control that excluded a candidate, deterministically ordered', async () => {
    const model = await insertModel();
    // Two routes failing two DIFFERENT controls. Naming only one would tell the
    // customer a single edit will fix it, and it would not.
    await insertDeployment(model, {
      rank: 'a',
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: false,
    });
    await insertDeployment(model, {
      rank: 'z',
      retainsPayloads: true,
      retentionDays: 30,
      trainsOnCustomerData: true,
      zeroDataRetentionAvailable: true,
    });

    const refused = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      model.modelId,
      constrain({ requireZeroDataRetention: true, prohibitTrainingOnCustomerData: true })
    );
    expect(refused).toEqual({
      status: 'policy-excluded',
      modelReference: model.modelId,
      constraints: ['requireZeroDataRetention', 'prohibitTrainingOnCustomerData'],
    });
  });

  it('never widens to a non-conforming route when a conforming one is ranked second', async () => {
    // The failure this whole issue is about: `candidates[0]` is the violating
    // route, and the policy has to be applied to the SET rather than to the one
    // that happened to sort first.
    const model = await insertModel();
    await insertDeployment(model, {
      rank: 'a',
      trainsOnCustomerData: true,
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: false,
    });
    const conforming = await insertDeployment(model, { rank: 'z' });

    const resolution = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      model.modelId,
      constrain({ prohibitTrainingOnCustomerData: true, requireZeroDataRetention: true })
    );
    expect(resolution).toEqual({
      status: 'resolved',
      route: expect.objectContaining({
        provider: conforming.providerSlug,
        modelReference: model.modelReference,
      }),
    });
  });
});

describe('a policy refusal is never confused with an absent route', () => {
  it('answers unknown-model for a model that does not exist, however strict the policy', async () => {
    // An empty candidate set and a candidate set EMPTIED BY POLICY are the same
    // emptiness at the point of return, and collapsing them would tell a
    // customer their model does not exist when their own policy refused it.
    const constraints = constrain({
      requireZeroDataRetention: true,
      prohibitTrainingOnCustomerData: true,
    });

    const absent = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      `nobody/nothing${suffix()}`,
      constraints
    );
    expect(absent.status).toBe('unknown-model');

    // POSITIVE CONTROL in the same currency: the SAME constraints against a
    // model that DOES exist and violates them return the other arm. Without it,
    // an implementation that had merged the two arms into `unknown-model` would
    // satisfy the assertion above, and so would one that never reached the
    // policy at all.
    const present = await insertModel();
    await insertDeployment(present, {
      rank: 'a',
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: false,
    });
    const excluded = await resolveEdgeRoute(
      PUBLIC_CATALOGUE_VIEWER,
      present.modelId,
      constraints
    );
    expect(excluded).toEqual({
      status: 'policy-excluded',
      modelReference: present.modelId,
      constraints: ['requireZeroDataRetention'],
    });
  });

  it('answers unknown-model when the viewer may not see the only route', async () => {
    const model = await insertModel();
    await insertDeployment(model, { rank: 'a', availabilityScope: 'internal_alia' });

    // Withheld by AUDIENCE, not by policy — and the two must stay
    // distinguishable, because only one of them is the customer's to fix.
    await expect(
      resolveEdgeRoute(
        PUBLIC_CATALOGUE_VIEWER,
        model.modelId,
        constrain({ requireZeroDataRetention: true })
      )
    ).resolves.toEqual({ status: 'unknown-model', modelReference: model.modelId });

    // CONTROL: the route is real and resolvable — for the audience it is for.
    const internal = await resolveEdgeRoute(
      INTERNAL_VIEWER,
      model.modelId,
      constrain({ requireZeroDataRetention: true })
    );
    expect(internal.status).toBe('resolved');
  });

  it('reports a policy exclusion rather than an Oxy pricing gap', async () => {
    // Order matters: an unpriced route the policy also forbids is the customer's
    // configuration, not Oxy's. Reporting `unpriced-route` would send them to
    // support about a setting they own.
    const model = await insertModel();
    await insertDeployment(model, {
      rank: 'a',
      unpriced: true,
      trainsOnCustomerData: true,
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: false,
    });

    await expect(
      resolveEdgeRoute(
        PUBLIC_CATALOGUE_VIEWER,
        model.modelId,
        constrain({ prohibitTrainingOnCustomerData: true })
      )
    ).resolves.toEqual({
      status: 'policy-excluded',
      modelReference: model.modelId,
      constraints: ['prohibitTrainingOnCustomerData'],
    });

    // CONTROL: without the control it IS the pricing gap, so the assertion above
    // is about the ordering of the two checks and not about the fixture.
    await expect(
      resolveEdgeRoute(PUBLIC_CATALOGUE_VIEWER, model.modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toEqual({ status: 'unpriced-route', modelReference: model.modelId });
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The customer-facing resolver filters too                               */
/* -------------------------------------------------------------------------- */

describe('selectRouteForViewer applies the policy as well', () => {
  it('withholds the retaining route and serves the zero-retention one', async () => {
    const model = await insertModel();
    const retaining = await insertDeployment(model, {
      rank: 'a',
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: false,
    });
    const zeroRetention = await insertDeployment(model, { rank: 'z' });

    const constrained = await selectRouteForViewer(
      PUBLIC_CATALOGUE_VIEWER,
      model.modelId,
      constrain({ requireZeroDataRetention: true })
    );
    expect(constrained?.provider).toBe(zeroRetention.providerSlug);

    const unconstrained = await selectRouteForViewer(
      PUBLIC_CATALOGUE_VIEWER,
      model.modelId,
      UNCONSTRAINED_ROUTING
    );
    expect(unconstrained?.provider).toBe(retaining.providerSlug);
  });

  it('refuses outright when every candidate is excluded', async () => {
    const model = await insertModel();
    await insertDeployment(model, {
      rank: 'a',
      retainsPayloads: true,
      retentionDays: 30,
      zeroDataRetentionAvailable: false,
    });

    await expect(
      selectRouteForViewer(
        PUBLIC_CATALOGUE_VIEWER,
        model.modelId,
        constrain({ requireZeroDataRetention: true })
      )
    ).resolves.toBeUndefined();

    // CONTROL: the route exists and is selectable, so the refusal above is the
    // policy rather than an empty catalogue.
    await expect(
      selectRouteForViewer(PUBLIC_CATALOGUE_VIEWER, model.modelId, UNCONSTRAINED_ROUTING)
    ).resolves.toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Every control of the contract is classified                            */
/* -------------------------------------------------------------------------- */

/** A policy with EVERY control set, including the two optional ones. */
function everyControlPolicy(): RoutingPolicy {
  return routingPolicySchema.parse({
    schemaVersion: 1,
    routingPolicyId: `policy-${suffix()}`,
    policyVersion: 3,
    scope: { kind: 'account', accountId: `acct-${suffix()}` },
    defaultTarget: { kind: 'model', modelReference: 'openai/gpt-5' },
    providerAllowlist: ['openai'],
    providerDenylist: ['some-other-provider'],
    allowedRegions: ['eu-west-1'],
    deniedRegions: ['us-west-2'],
    requireZeroDataRetention: true,
    prohibitTrainingOnCustomerData: true,
    maxPricePerUnit: [
      { unit: 'input_tokens', amount: '4.000000000000', per: 1_000_000, currency: 'USD' },
    ],
    maxPricePerRequest: { amount: '1.000000000000', currency: 'USD' },
    optimiseFor: 'price',
    oxyHostedOnly: false,
    allowedLicenseIds: ['apache-2.0'],
    requireCommercialUseRights: true,
    fallback: { disabled: false, sameModelDeployment: true, authorizedCrossModel: [] },
    byokPreference: 'prefer',
    dedicatedCapacity: 'prefer',
    updatedAt: new Date().toISOString(),
  });
}

describe('the classification covers the contract exactly', () => {
  it('holds the type-level gate at runtime too', () => {
    // The compile-time half is the annotation on this constant: a control named
    // in neither list makes its type `false` and the assignment fails `tsc`.
    // Asserted here as well so the gate is visible in a test run, and so
    // deleting it is a red rather than a silent loss.
    expect(EVERY_ROUTING_CONTROL_IS_CLASSIFIED).toBe(true);
  });

  it('classifies every field a real parsed policy carries, and never twice', () => {
    const policy = everyControlPolicy();
    const enforced = Object.keys(UNCONSTRAINED_ROUTING);
    const unfiltered = Object.keys(UNFILTERED_ROUTING_CONTROLS);

    // VACUITY FLOOR: the scan sees a real, fully-populated policy. Without it,
    // "every field is classified" is also what an empty object reports.
    expect(Object.keys(policy).length).toBeGreaterThanOrEqual(
      enforced.length + unfiltered.length
    );

    for (const field of Object.keys(policy)) {
      expect([...enforced, ...unfiltered]).toContain(field);
    }
    for (const field of enforced) {
      expect(unfiltered).not.toContain(field);
    }
  });

  it('copies every enforced control off the policy verbatim', () => {
    const policy = everyControlPolicy();
    const constraints = routingConstraintsOf(policy);

    // Derived from the constraint shape rather than restated, so a control added
    // to `RoutingConstraints` is covered here the moment it exists.
    for (const field of Object.keys(UNCONSTRAINED_ROUTING) as (keyof RoutingConstraints)[]) {
      expect(constraints[field]).toEqual(policy[field]);
    }
  });
});
