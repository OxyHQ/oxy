/**
 * The routing policy service, against a REAL Postgres.
 *
 * The schema test (`db/schema/__tests__/inferenceRoutingPolicy.test.ts`) covers
 * what the DATABASE refuses. This covers what the SERVICE answers: that a
 * contradictory policy comes back as the contract's own issue list rather than a
 * constraint failure, that editing appends rather than overwrites, that an
 * application inherits its account's policy only when it has none of its own,
 * and — the invariant this workstream exists for — that a substitution the
 * customer never authorised is refused BY NAME rather than recorded.
 *
 * Every fixture owns its identifiers, so nothing here reads a sibling file's
 * rows and no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { routingPolicyScopeSchema, type RoutingPolicy } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { inferenceModelRevisions } from '../../db/schema/inferenceModelRevisions';
import { inferenceModels } from '../../db/schema/inferenceModels';
import { inferenceRouteSwitchEvents } from '../../db/schema/inferenceRouteSwitchEvents';
import { inferenceRoutingProfileCandidates } from '../../db/schema/inferenceRoutingProfileCandidates';
import { inferenceRoutingPolicyVersions } from '../../db/schema/inferenceRoutingPolicyVersions';
import { inferencePublishers } from '../../db/schema/inferencePublishers';
import { inferenceRoutingProfiles } from '../../db/schema/inferenceRoutingProfiles';
import { users } from '../../db/schema/users';
import {
  appendRoutingPolicyVersion,
  archiveRoutingPolicy,
  createRoutingPolicy,
  getRoutingPolicy,
  listRoutingPolicyVersions,
  listRouteSwitchEventsForApplication,
  recordRouteSwitch,
  resolveEffectiveRoutingPolicy,
  validateRoutingPolicy,
  type RoutingPolicyControls,
} from '../inferenceRoutingPolicy.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

async function insertAccount(): Promise<string> {
  const tag = suffix();
  const [row] = await getDb()
    .insert(users)
    .values({ username: `rps-${tag}`, email: `rps-${tag}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `RPS ${suffix()}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

function modelDefaults() {
  return {
    displayName: 'Fixture Model',
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
    licenseId: 'fixture-1.0',
    licenseDisplayName: 'Fixture Licence',
    commercialUseAllowed: true,
    requiresAttribution: false,
    releaseKind: 'open_weight' as const,
  };
}

interface ModelFixture {
  modelRowId: string;
  reference: string;
  pinnedReference: string;
  secondRevisionReference: string;
}

async function insertModel(): Promise<ModelFixture> {
  const publisherSlug = `pub${suffix()}`;
  await getDb()
    .insert(inferencePublishers)
    .values({ slug: publisherSlug, displayName: 'Fixture Publisher' });

  const slug = `mdl${suffix()}`;
  const [model] = await getDb()
    .insert(inferenceModels)
    .values({ publisherSlug, slug, ...modelDefaults() })
    .returning({ id: inferenceModels.id });

  const first = `rev${suffix()}`;
  const second = `rev${suffix()}`;
  await getDb()
    .insert(inferenceModelRevisions)
    .values([
      { modelId: model.id, revision: first, releasedAt: new Date(Date.now() - 60_000) },
      { modelId: model.id, revision: second, releasedAt: new Date(), isCurrent: true },
    ]);

  return {
    modelRowId: model.id,
    reference: `${publisherSlug}/${slug}`,
    pinnedReference: `${publisherSlug}/${slug}@${first}`,
    secondRevisionReference: `${publisherSlug}/${slug}@${second}`,
  };
}

async function insertProfile(): Promise<string> {
  const slug = `prof${suffix()}`;
  await getDb().insert(inferenceRoutingProfiles).values({
    slug,
    displayName: 'Fixture Profile',
    optimiseFor: 'balanced',
    isProductPreset: false,
  });
  return slug;
}

/**
 * A provider slug. Deliberately NOT a catalogue row: the allow/deny lists are
 * `text[]` with no foreign key, because a customer may legitimately deny a
 * provider Oxy has not onboarded yet and a constraint there would refuse a
 * policy that is merely ahead of the catalogue.
 */
function providerSlug(): string {
  return `prv${suffix()}`;
}

/** The least opinionated policy that is still valid. */
function minimalControls(): RoutingPolicyControls {
  return {
    providerAllowlist: [],
    providerDenylist: [],
    allowedRegions: [],
    deniedRegions: [],
    requireZeroDataRetention: false,
    prohibitTrainingOnCustomerData: false,
    maxPricePerUnit: [],
    optimiseFor: 'balanced',
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: false,
    fallback: { disabled: false, sameModelDeployment: true, authorizedCrossModel: [] },
    byokPreference: 'disabled',
    dedicatedCapacity: 'disabled',
  } as RoutingPolicyControls;
}

/* -------------------------------------------------------------------------- */

describe('validation is the contract’s refinement, reached through the service', () => {
  /**
   * PARSED, not cast. `accountId` is branded, and parsing is the one sanctioned
   * way to obtain the brand — a cast here would be exactly the hole the brand
   * exists to close, in the file whose job is to prove the brand is enforced.
   */
  const scope = routingPolicyScopeSchema.parse({ kind: 'account', accountId: 'acct-1' });

  function validate(overrides: Partial<RoutingPolicyControls>) {
    return validateRoutingPolicy({
      routingPolicyId: 'policy-1',
      policyVersion: 1,
      scope,
      controls: { ...minimalControls(), ...overrides } as RoutingPolicyControls,
      updatedAt: new Date(),
    });
  }

  it('accepts a minimal policy', () => {
    expect(validate({}).status).toBe('valid');
  });

  /**
   * One case per contradiction the contract's refinement names, asserted on the
   * PATH rather than on the message: the path is what a Console form binds an
   * error to, and a message comparison would go red on a rewording that changed
   * nothing.
   */
  it.each([
    [
      'a provider both required and denied',
      { providerAllowlist: ['bedrock'], providerDenylist: ['bedrock'] },
      'providerAllowlist.0',
    ],
    [
      'a region both allowed and denied',
      { allowedRegions: ['eu-central-1'], deniedRegions: ['eu-central-1'] },
      'allowedRegions.0',
    ],
    [
      'fallback disabled with same-model failover',
      { fallback: { disabled: true, sameModelDeployment: true, authorizedCrossModel: [] } },
      'fallback.sameModelDeployment',
    ],
    [
      'fallback disabled with an authorised substitute',
      {
        fallback: {
          disabled: true,
          sameModelDeployment: false,
          authorizedCrossModel: ['openai/gpt-5'],
        },
      },
      'fallback.authorizedCrossModel',
    ],
    [
      'Oxy-hosted-only requiring a customer credential',
      { oxyHostedOnly: true, byokPreference: 'require' as const },
      'byokPreference',
    ],
    [
      'two ceilings for one unit',
      {
        maxPricePerUnit: [
          { unit: 'input_tokens', amount: '1', per: 1_000_000, currency: 'USD' },
          { unit: 'input_tokens', amount: '2', per: 1_000_000, currency: 'USD' },
        ],
      },
      'maxPricePerUnit',
    ],
    [
      'ceilings in two currencies',
      {
        maxPricePerUnit: [{ unit: 'input_tokens', amount: '1', per: 1_000_000, currency: 'EUR' }],
        maxPricePerRequest: { amount: '5', currency: 'USD' },
      },
      'maxPricePerUnit.0.currency',
    ],
  ])('rejects %s', (_label, overrides, path) => {
    const result = validate(overrides as Partial<RoutingPolicyControls>);
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.issues.map((issue) => issue.path)).toContain(path);
  });
});

describe('a policy round-trips every control it carries', () => {
  it('writes and reads back a fully-populated policy unchanged', async () => {
    const accountId = await insertAccount();
    const model = await insertModel();
    const substitute = await insertModel();
    const profile = await insertProfile();
    const allowed = providerSlug();
    const denied = providerSlug();

    /**
     * EVERY control set to a non-default value. This is the projection gate: a
     * column left out of the service's select comes back as its default and one
     * of these assertions fails naming it.
     */
    const controls = {
      defaultTarget: { kind: 'routing_profile', routingProfile: profile },
      providerAllowlist: [allowed],
      providerDenylist: [denied],
      allowedRegions: ['eu-central-1'],
      deniedRegions: ['us-east-1'],
      requireZeroDataRetention: true,
      prohibitTrainingOnCustomerData: true,
      maxPricePerUnit: [
        { unit: 'input_tokens', amount: '0.000003000000', per: 1_000_000, currency: 'USD' },
        { unit: 'output_tokens', amount: '0.000015000000', per: 1_000_000, currency: 'USD' },
      ],
      maxPricePerRequest: { amount: '0.500000000000', currency: 'USD' },
      optimiseFor: 'latency',
      oxyHostedOnly: false,
      allowedLicenseIds: ['apache-2.0', 'mit'],
      requireCommercialUseRights: true,
      fallback: {
        disabled: false,
        sameModelDeployment: false,
        authorizedCrossModel: [substitute.reference, model.pinnedReference],
      },
      byokPreference: 'prefer',
      dedicatedCapacity: 'require',
    } as unknown as RoutingPolicyControls;

    const written = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls,
      createdByUserId: accountId,
    });
    expect(written.status).toBe('written');
    if (written.status !== 'written') return;

    const stored = await getRoutingPolicy(written.policy.routingPolicyId);
    expect(stored).toBeDefined();
    const read: RoutingPolicy = stored!.policy;

    expect(read.policyVersion).toBe(1);
    expect(read.scope).toEqual({ kind: 'account', accountId });
    expect(read.defaultTarget).toEqual({ kind: 'routing_profile', routingProfile: profile });
    expect(read.providerAllowlist).toEqual([allowed]);
    expect(read.providerDenylist).toEqual([denied]);
    expect(read.allowedRegions).toEqual(['eu-central-1']);
    expect(read.deniedRegions).toEqual(['us-east-1']);
    expect(read.requireZeroDataRetention).toBe(true);
    expect(read.prohibitTrainingOnCustomerData).toBe(true);
    expect(read.maxPricePerUnit.map((p) => p.unit).sort()).toEqual([
      'input_tokens',
      'output_tokens',
    ]);
    expect(read.maxPricePerUnit.every((p) => p.currency === 'USD')).toBe(true);
    expect(read.maxPricePerRequest).toEqual({ amount: '0.500000000000', currency: 'USD' });
    expect(read.optimiseFor).toBe('latency');
    expect(read.allowedLicenseIds).toEqual(['apache-2.0', 'mit']);
    expect(read.requireCommercialUseRights).toBe(true);
    expect(read.fallback.disabled).toBe(false);
    expect(read.fallback.sameModelDeployment).toBe(false);
    // Order is the CUSTOMER's, preserved through `position`.
    expect(read.fallback.authorizedCrossModel).toEqual([
      substitute.reference,
      model.pinnedReference,
    ]);
    expect(read.byokPreference).toBe('prefer');
    expect(read.dedicatedCapacity).toBe('require');
  });

  it('refuses a policy naming a model Oxy does not serve', async () => {
    const accountId = await insertAccount();
    const result = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls: {
        ...minimalControls(),
        defaultTarget: { kind: 'model', modelReference: 'nobody/nothing' },
      } as RoutingPolicyControls,
      createdByUserId: accountId,
    });
    expect(result).toEqual({
      status: 'unknown-catalogue-reference',
      reference: 'nobody/nothing',
    });
  });

  it('refuses a second active policy on one scope, and admits one after archiving', async () => {
    const accountId = await insertAccount();
    const first = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls: minimalControls(),
      createdByUserId: accountId,
    });
    expect(first.status).toBe('written');
    if (first.status !== 'written') return;

    const second = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls: minimalControls(),
      createdByUserId: accountId,
    });
    expect(second.status).toBe('scope-taken');

    await expect(archiveRoutingPolicy(first.policy.routingPolicyId)).resolves.toEqual({
      status: 'archived',
      routingPolicyId: first.policy.routingPolicyId,
    });

    const third = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls: minimalControls(),
      createdByUserId: accountId,
    });
    expect(third.status).toBe('written');
  });
});

describe('editing appends a version and never rewrites one', () => {
  it('leaves the superseded version exactly as it was', async () => {
    const accountId = await insertAccount();
    const created = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls: { ...minimalControls(), optimiseFor: 'price' } as RoutingPolicyControls,
      createdByUserId: accountId,
    });
    expect(created.status).toBe('written');
    if (created.status !== 'written') return;
    const policyId = created.policy.routingPolicyId;

    const edited = await appendRoutingPolicyVersion({
      routingPolicyId: policyId,
      controls: { ...minimalControls(), optimiseFor: 'throughput' } as RoutingPolicyControls,
      createdByUserId: accountId,
    });
    expect(edited.status).toBe('written');
    if (edited.status !== 'written') return;
    expect(edited.policy.policyVersion).toBe(2);

    // Version 1 still says what it said: the whole point of the reference a
    // settled receipt keeps.
    const historical = await getRoutingPolicy(policyId, 1);
    expect(historical?.policy.optimiseFor).toBe('price');

    // The current read follows the new version.
    const current = await getRoutingPolicy(policyId);
    expect(current?.policy.policyVersion).toBe(2);
    expect(current?.policy.optimiseFor).toBe('throughput');

    // Exactly one version is current, scoped to THIS policy's rows.
    const rows = await getDb()
      .select({
        version: inferenceRoutingPolicyVersions.version,
        isCurrent: inferenceRoutingPolicyVersions.isCurrent,
      })
      .from(inferenceRoutingPolicyVersions)
      .where(eq(inferenceRoutingPolicyVersions.routingPolicyId, policyId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.isCurrent)).toHaveLength(1);

    const history = await listRoutingPolicyVersions(policyId);
    expect(history.map((entry) => entry.policy.policyVersion)).toEqual([2, 1]);
  });

  it('refuses to edit an archived policy', async () => {
    const accountId = await insertAccount();
    const created = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls: minimalControls(),
      createdByUserId: accountId,
    });
    if (created.status !== 'written') throw new Error('fixture failed');
    await archiveRoutingPolicy(created.policy.routingPolicyId);

    const result = await appendRoutingPolicyVersion({
      routingPolicyId: created.policy.routingPolicyId,
      controls: minimalControls(),
      createdByUserId: accountId,
    });
    expect(result.status).toBe('archived-policy');
  });

  it('reports a contradictory edit as issues, not as a constraint failure', async () => {
    const accountId = await insertAccount();
    const created = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls: minimalControls(),
      createdByUserId: accountId,
    });
    if (created.status !== 'written') throw new Error('fixture failed');

    const result = await appendRoutingPolicyVersion({
      routingPolicyId: created.policy.routingPolicyId,
      controls: {
        ...minimalControls(),
        oxyHostedOnly: true,
        byokPreference: 'require',
      } as RoutingPolicyControls,
      createdByUserId: accountId,
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.issues.map((issue) => issue.path)).toContain('byokPreference');

    // ...and nothing was written: the policy is still on version 1.
    const current = await getRoutingPolicy(created.policy.routingPolicyId);
    expect(current?.policy.policyVersion).toBe(1);
  });
});

describe('an application’s effective policy', () => {
  it('prefers its own policy, inherits the account’s, and otherwise has none', async () => {
    const accountId = await insertAccount();
    const applicationId = await insertApplication(accountId);

    await expect(resolveEffectiveRoutingPolicy(applicationId)).resolves.toEqual({
      status: 'none',
      applicationId,
    });

    const accountPolicy = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls: { ...minimalControls(), optimiseFor: 'price' } as RoutingPolicyControls,
      createdByUserId: accountId,
    });
    if (accountPolicy.status !== 'written') throw new Error('fixture failed');

    const inherited = await resolveEffectiveRoutingPolicy(applicationId);
    expect(inherited.status).toBe('resolved');
    if (inherited.status !== 'resolved') return;
    expect(inherited.source).toBe('account');
    expect(inherited.stored.policy.optimiseFor).toBe('price');

    const appPolicy = await createRoutingPolicy({
      target: { kind: 'application', accountId, applicationId },
      controls: { ...minimalControls(), optimiseFor: 'latency' } as RoutingPolicyControls,
      createdByUserId: accountId,
    });
    if (appPolicy.status !== 'written') throw new Error('fixture failed');

    const own = await resolveEffectiveRoutingPolicy(applicationId);
    expect(own.status).toBe('resolved');
    if (own.status !== 'resolved') return;
    expect(own.source).toBe('application');
    expect(own.stored.policy.optimiseFor).toBe('latency');
    expect(own.stored.policy.scope).toEqual({ kind: 'application', accountId, applicationId });
  });

  it('answers for an application that does not exist', async () => {
    await expect(resolveEffectiveRoutingPolicy('no-such-application')).resolves.toEqual({
      status: 'unknown-application',
      applicationId: 'no-such-application',
    });
  });
});

describe('a concrete model is never silently substituted', () => {
  interface SwitchFixture {
    accountId: string;
    applicationId: string;
    versionId: string;
    requested: ModelFixture;
    substitute: ModelFixture;
    unauthorized: ModelFixture;
  }

  async function switchFixture(
    fallbackOverride?: Partial<RoutingPolicyControls['fallback']>
  ): Promise<SwitchFixture> {
    const accountId = await insertAccount();
    const applicationId = await insertApplication(accountId);
    const requested = await insertModel();
    const substitute = await insertModel();
    const unauthorized = await insertModel();

    const created = await createRoutingPolicy({
      target: { kind: 'application', accountId, applicationId },
      controls: {
        ...minimalControls(),
        fallback: {
          disabled: false,
          sameModelDeployment: true,
          authorizedCrossModel: [substitute.reference],
          ...fallbackOverride,
        },
      } as RoutingPolicyControls,
      createdByUserId: accountId,
    });
    if (created.status !== 'written') throw new Error('fixture failed');

    const stored = await getRoutingPolicy(created.policy.routingPolicyId);
    if (stored === undefined) throw new Error('fixture failed');

    return {
      accountId,
      applicationId,
      versionId: stored.versionId,
      requested,
      substitute,
      unauthorized,
    };
  }

  function base(f: SwitchFixture) {
    return {
      requestId: `req-${randomUUID()}`,
      sequence: 0,
      accountId: f.accountId,
      applicationId: f.applicationId,
      environment: 'production' as const,
      routingPolicyVersionId: f.versionId,
      reason: 'provider_error' as const,
      occurredAt: new Date(),
    };
  }

  it('records a same-model deployment failover', async () => {
    const f = await switchFixture();
    const result = await recordRouteSwitch({
      ...base(f),
      detail: {
        scope: 'deployment',
        modelReference: f.requested.reference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result.status).toBe('recorded');
  });

  it('records an authorised cross-model substitution', async () => {
    const f = await switchFixture();
    const result = await recordRouteSwitch({
      ...base(f),
      authorization: { kind: 'policy_fallback' },
      detail: {
        scope: 'model',
        requestedModelId: f.requested.reference,
        fromModelReference: f.requested.reference,
        toModelReference: f.substitute.reference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result.status).toBe('recorded');

    const events = await listRouteSwitchEventsForApplication(f.applicationId);
    expect(events).toHaveLength(1);
    expect(events[0].scope).toBe('model');
    expect(events[0].requestedModelId).toBe(f.requested.reference);
    expect(events[0].toModelReference).toBe(f.substitute.reference);
  });

  it('refuses a substitution the policy never authorised', async () => {
    const f = await switchFixture();
    const result = await recordRouteSwitch({
      ...base(f),
      authorization: { kind: 'policy_fallback' },
      detail: {
        scope: 'model',
        requestedModelId: f.requested.reference,
        fromModelReference: f.requested.reference,
        toModelReference: f.unauthorized.reference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result).toEqual({
      status: 'unauthorized-substitution',
      requestedModelId: f.requested.reference,
      toModelReference: f.unauthorized.reference,
    });

    // Nothing was recorded — a refusal that still wrote the row would be a
    // customer-visible notice of a switch that must not have happened.
    await expect(listRouteSwitchEventsForApplication(f.applicationId)).resolves.toEqual([]);
  });

  /**
   * The invariant, at the service layer. The column's own CHECK refuses this too
   * (see the schema test); the two exist because they fail differently — this one
   * names the model in an answer a caller can act on, the CHECK is what still
   * holds for a writer that never came through here.
   */
  it('refuses to substitute a request that pinned an exact revision', async () => {
    const f = await switchFixture();
    const result = await recordRouteSwitch({
      ...base(f),
      authorization: { kind: 'policy_fallback' },
      detail: {
        scope: 'model',
        requestedModelId: f.requested.pinnedReference,
        fromModelReference: f.requested.pinnedReference,
        toModelReference: f.substitute.reference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result).toEqual({
      status: 'pinned-revision-not-substitutable',
      requestedModel: f.requested.pinnedReference,
    });
    await expect(listRouteSwitchEventsForApplication(f.applicationId)).resolves.toEqual([]);
  });

  it('refuses any switch under a policy whose fallback is disabled', async () => {
    const f = await switchFixture({
      disabled: true,
      sameModelDeployment: false,
      authorizedCrossModel: [],
    });
    const result = await recordRouteSwitch({
      ...base(f),
      detail: {
        scope: 'deployment',
        modelReference: f.requested.reference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result).toEqual({
      status: 'fallback-disabled',
      routingPolicyVersionId: f.versionId,
    });
  });

  it('treats a redelivered event as already recorded rather than a second switch', async () => {
    const f = await switchFixture();
    const event = {
      ...base(f),
      detail: {
        scope: 'deployment' as const,
        modelReference: f.requested.reference,
        toProvider: 'oxy-hosted',
      },
    };
    expect((await recordRouteSwitch(event)).status).toBe('recorded');
    expect((await recordRouteSwitch(event)).status).toBe('already-recorded');
    await expect(listRouteSwitchEventsForApplication(f.applicationId)).resolves.toHaveLength(1);
  });

  /**
   * An authorisation on the unpinned model line covers any revision of it; an
   * authorisation on a PINNED revision covers only those weights. Both
   * directions, because the permissive reading is the dangerous one — it would
   * let a policy that pinned one revision license a different one.
   */
  it('resolves an unpinned authorisation for a revision of the same model', async () => {
    const f = await switchFixture();
    const result = await recordRouteSwitch({
      ...base(f),
      authorization: { kind: 'policy_fallback' },
      detail: {
        scope: 'model',
        requestedModelId: f.requested.reference,
        fromModelReference: f.requested.reference,
        toModelReference: f.substitute.secondRevisionReference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result.status).toBe('recorded');
  });

  it('does not let a pinned authorisation license a different revision', async () => {
    const accountId = await insertAccount();
    const applicationId = await insertApplication(accountId);
    const requested = await insertModel();
    const substitute = await insertModel();

    const created = await createRoutingPolicy({
      target: { kind: 'application', accountId, applicationId },
      controls: {
        ...minimalControls(),
        fallback: {
          disabled: false,
          sameModelDeployment: true,
          // Pinned to the FIRST revision only.
          authorizedCrossModel: [substitute.pinnedReference],
        },
      } as RoutingPolicyControls,
      createdByUserId: accountId,
    });
    if (created.status !== 'written') throw new Error('fixture failed');
    const stored = await getRoutingPolicy(created.policy.routingPolicyId);
    if (stored === undefined) throw new Error('fixture failed');

    const result = await recordRouteSwitch({
      requestId: `req-${randomUUID()}`,
      sequence: 0,
      accountId,
      applicationId,
      environment: 'production',
      routingPolicyVersionId: stored.versionId,
      reason: 'capacity',
      occurredAt: new Date(),
      authorization: { kind: 'policy_fallback' },
      detail: {
        scope: 'model',
        requestedModelId: requested.reference,
        fromModelReference: requested.reference,
        // A DIFFERENT revision of the authorised model.
        toModelReference: substitute.secondRevisionReference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result.status).toBe('unauthorized-substitution');
  });

  it('records a routing-profile switch against its candidate, not a policy fallback', async () => {
    const f = await switchFixture();
    const slug = `prof${suffix()}`;
    const [profile] = await getDb()
      .insert(inferenceRoutingProfiles)
      .values({
        slug,
        displayName: 'Profile authorization fixture',
        optimiseFor: 'balanced',
        isProductPreset: false,
      })
      .returning({ id: inferenceRoutingProfiles.id });
    const [candidate] = await getDb()
      .insert(inferenceRoutingProfileCandidates)
      .values({
        routingProfileId: profile.id,
        modelId: f.unauthorized.modelRowId,
        priority: 0,
      })
      .returning({ id: inferenceRoutingProfileCandidates.id });

    const result = await recordRouteSwitch({
      ...base(f),
      authorization: {
        kind: 'routing_profile_candidate',
        routingProfileSlug: slug,
      },
      detail: {
        scope: 'model',
        requestedModelId: f.requested.reference,
        fromModelReference: f.requested.reference,
        toModelReference: f.unauthorized.reference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result.status).toBe('recorded');

    const [row] = await getDb()
      .select({
        authorizationId: inferenceRouteSwitchEvents.authorizationId,
        routingProfileCandidateId: inferenceRouteSwitchEvents.routingProfileCandidateId,
      })
      .from(inferenceRouteSwitchEvents)
      .where(eq(inferenceRouteSwitchEvents.applicationId, f.applicationId))
      .limit(1);
    expect(row).toEqual({
      authorizationId: null,
      routingProfileCandidateId: candidate.id,
    });
  });

  it('refuses a switch citing a policy version that does not exist', async () => {
    const f = await switchFixture();
    const result = await recordRouteSwitch({
      ...base(f),
      routingPolicyVersionId: 'no-such-version',
      detail: {
        scope: 'deployment',
        modelReference: f.requested.reference,
        toProvider: 'oxy-hosted',
      },
    });
    expect(result).toEqual({
      status: 'unknown-policy-version',
      routingPolicyVersionId: 'no-such-version',
    });
  });
});
