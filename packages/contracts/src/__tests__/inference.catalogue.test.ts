import {
  catalogueModelSchema,
  inferenceDataPolicySchema,
  inferenceProviderSchema,
  modelDeploymentSchema,
  modelPublisherSchema,
  modelRevisionSchema,
  RESERVED_ALIA_PUBLISHER,
  routingProfileSchema,
  safeParseContract,
} from '../index';

const dataPolicy = {
  retainsPayloads: false,
  retentionDays: 0,
  trainsOnCustomerData: false,
  zeroDataRetentionAvailable: true,
  subprocessors: [],
};

const capabilities = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  tools: true,
  parallelToolCalls: false,
  structuredOutput: true,
  jsonMode: true,
  reasoning: false,
  streaming: true,
  promptCaching: false,
  maxContextTokens: 128000,
  maxOutputTokens: 8192,
};

const license = {
  licenseId: 'Apache-2.0',
  displayName: 'Apache 2.0',
  commercialUseAllowed: true,
  requiresAttribution: true,
};

const model = {
  schemaVersion: 1 as const,
  modelId: 'meta/llama-4-70b',
  publisher: 'meta',
  slug: 'llama-4-70b',
  displayName: 'Llama 4 70B',
  capabilities,
  license,
  provenance: { releaseKind: 'open_weight' as const },
  currentRevision: '2026-03-01',
  deprecation: { status: 'active' as const },
};

const deployment = {
  schemaVersion: 2 as const,
  deploymentId: 'dep_1',
  provider: 'oxy-hosted',
  modelReference: 'meta/llama-4-70b@2026-03-01',
  regions: ['us-west-2'],
  dataPolicy,
  availabilityScope: 'public_payg' as const,
  commercialPermission: 'open_weight_hosting' as const,
  status: 'active' as const,
  dedicatedCapacity: false,
};

describe('the six catalogue objects are distinct', () => {
  it('parses a publisher, a model, a revision, a provider, a deployment and a profile', () => {
    expect(
      safeParseContract(modelPublisherSchema, {
        schemaVersion: 1,
        publisherId: 'pub_meta',
        slug: 'meta',
        displayName: 'Meta',
      }),
    ).not.toBeNull();

    expect(catalogueModelSchema.safeParse(model).success).toBe(true);

    expect(
      modelRevisionSchema.safeParse({
        schemaVersion: 1,
        revisionId: 'rev_1',
        modelId: 'meta/llama-4-70b',
        revision: '2026-03-01',
        reference: 'meta/llama-4-70b@2026-03-01',
        releasedAt: '2026-03-01T00:00:00.000Z',
        evaluations: [],
      }).success,
    ).toBe(true);

    expect(
      inferenceProviderSchema.safeParse({
        schemaVersion: 1,
        providerId: 'prv_oxy',
        slug: 'oxy-hosted',
        displayName: 'Oxy hosted',
        kind: 'oxy_hosted',
        regions: ['us-west-2'],
        dataPolicy,
      }).success,
    ).toBe(true);

    expect(modelDeploymentSchema.safeParse(deployment).success).toBe(true);

    expect(
      routingProfileSchema.safeParse({
        schemaVersion: 1,
        routingProfileId: 'rpf_fast',
        slug: 'fast',
        displayName: 'Fast',
        optimiseFor: 'latency',
        candidates: [{ modelReference: 'meta/llama-4-70b', priority: 0 }],
        isProductPreset: true,
      }).success,
    ).toBe(true);
  });

  it('keeps a routing profile from being written as a model id', () => {
    expect(
      routingProfileSchema.safeParse({
        schemaVersion: 1,
        routingProfileId: 'rpf_auto',
        slug: 'oxy/auto',
        displayName: 'Auto',
        optimiseFor: 'balanced',
        candidates: [{ modelReference: 'meta/llama-4-70b', priority: 0 }],
        isProductPreset: true,
      }).success,
    ).toBe(false);
  });

  it('refuses a profile with nothing to choose between', () => {
    expect(
      routingProfileSchema.safeParse({
        schemaVersion: 1,
        routingProfileId: 'rpf_auto',
        slug: 'auto',
        displayName: 'Auto',
        optimiseFor: 'balanced',
        candidates: [],
        isProductPreset: false,
      }).success,
    ).toBe(false);
  });
});

describe('catalogueModelSchema', () => {
  it('refuses a modelId that is not <publisher>/<model>', () => {
    expect(
      catalogueModelSchema.safeParse({ ...model, modelId: 'meta/llama-4-8b' }).success,
    ).toBe(false);
    expect(catalogueModelSchema.safeParse({ ...model, modelId: 'llama-4-70b' }).success).toBe(
      false,
    );
  });

  it('reserves the alia namespace for first-party releases', () => {
    const aliaModel = {
      ...model,
      modelId: `${RESERVED_ALIA_PUBLISHER}/assistant-1`,
      publisher: RESERVED_ALIA_PUBLISHER,
      slug: 'assistant-1',
    };

    // A provider alias published under `alia/*` would put an Oxy name on
    // somebody else's weights and license.
    expect(
      catalogueModelSchema.safeParse({
        ...aliaModel,
        provenance: { releaseKind: 'third_party_hosted' },
      }).success,
    ).toBe(false);

    expect(
      catalogueModelSchema.safeParse({
        ...aliaModel,
        provenance: { releaseKind: 'first_party_derived', baseModelId: 'meta/llama-4-70b' },
      }).success,
    ).toBe(true);
  });

  it('refuses a sunset date on a model that is not deprecated', () => {
    expect(
      catalogueModelSchema.safeParse({
        ...model,
        deprecation: { status: 'active', sunsetAt: '2027-01-01T00:00:00.000Z' },
      }).success,
    ).toBe(false);
    expect(
      catalogueModelSchema.safeParse({
        ...model,
        deprecation: {
          status: 'deprecated',
          sunsetAt: '2027-01-01T00:00:00.000Z',
          replacementModelReference: 'meta/llama-5-70b',
        },
      }).success,
    ).toBe(true);
  });

  it('carries no provider, region or price — those belong to a deployment', () => {
    const modelKeys = Object.keys(catalogueModelSchema.innerType().shape);
    expect(modelKeys).not.toContain('provider');
    expect(modelKeys).not.toContain('regions');
    expect(modelKeys).not.toContain('priceVersionId');
    expect(modelKeys).not.toContain('availabilityScope');
  });
});

describe('modelRevisionSchema', () => {
  const revision = {
    schemaVersion: 1 as const,
    revisionId: 'rev_1',
    modelId: 'meta/llama-4-70b',
    revision: '2026-03-01',
    reference: 'meta/llama-4-70b@2026-03-01',
    releasedAt: '2026-03-01T00:00:00.000Z',
    evaluations: [],
  };

  it('refuses a reference that resolves somewhere other than its own parts', () => {
    expect(
      modelRevisionSchema.safeParse({ ...revision, reference: 'meta/llama-4-70b@2026-04-01' })
        .success,
    ).toBe(false);
    expect(
      modelRevisionSchema.safeParse({ ...revision, reference: 'meta/llama-4-70b' }).success,
    ).toBe(false);
  });

  it('validates an artifact digest as sha256 hex', () => {
    expect(
      modelRevisionSchema.safeParse({ ...revision, artifactDigest: `sha256:${'a'.repeat(64)}` })
        .success,
    ).toBe(true);
    expect(
      modelRevisionSchema.safeParse({ ...revision, artifactDigest: 'sha256:short' }).success,
    ).toBe(false);
  });
});

describe('modelDeploymentSchema', () => {
  it('accepts only the current version and the platform-wide internal scope', () => {
    expect(modelDeploymentSchema.safeParse(deployment).success).toBe(true);
    expect(modelDeploymentSchema.safeParse({ ...deployment, schemaVersion: 1 }).success).toBe(
      false,
    );
    expect(
      modelDeploymentSchema.safeParse({ ...deployment, availabilityScope: 'internal_alia' })
        .success,
    ).toBe(false);
  });

  it('accepts an empty region set as unattested, never as a fabricated region', () => {
    const parsed = modelDeploymentSchema.parse({ ...deployment, regions: [] });
    expect(parsed.regions).toEqual([]);
  });

  it('requires a revision-pinned model reference', () => {
    expect(
      modelDeploymentSchema.safeParse({ ...deployment, modelReference: 'meta/llama-4-70b' })
        .success,
    ).toBe(false);
  });

  it('blocks a public route without an approved commercial permission', () => {
    // A technically callable provider route is not automatically resellable.
    expect(
      modelDeploymentSchema.safeParse({
        ...deployment,
        commercialPermission: 'standard_application_use',
      }).success,
    ).toBe(false);

    expect(
      modelDeploymentSchema.safeParse({
        ...deployment,
        availabilityScope: 'platform_internal',
        commercialPermission: 'standard_application_use',
      }).success,
    ).toBe(true);
  });

  it('serves a BYOK-only route under the customer’s own terms and no model price', () => {
    expect(
      modelDeploymentSchema.safeParse({
        ...deployment,
        availabilityScope: 'byok_only',
        commercialPermission: 'customer_byok',
      }).success,
    ).toBe(true);

    expect(
      modelDeploymentSchema.safeParse({
        ...deployment,
        availabilityScope: 'byok_only',
        commercialPermission: 'public_resale_approved',
      }).success,
    ).toBe(false);

    expect(
      modelDeploymentSchema.safeParse({
        ...deployment,
        availabilityScope: 'byok_only',
        commercialPermission: 'customer_byok',
        priceVersionId: 'pv_1',
      }).success,
    ).toBe(false);
  });
});

describe('inferenceDataPolicySchema', () => {
  it('parses a zero-retention policy', () => {
    expect(inferenceDataPolicySchema.safeParse(dataPolicy).success).toBe(true);
  });

  it('refuses a policy a routing rule could not be enforced against', () => {
    expect(
      inferenceDataPolicySchema.safeParse({ ...dataPolicy, retentionDays: 30 }).success,
    ).toBe(false);
    expect(
      inferenceDataPolicySchema.safeParse({ ...dataPolicy, trainsOnCustomerData: true }).success,
    ).toBe(false);
    expect(
      inferenceDataPolicySchema.safeParse({
        ...dataPolicy,
        retainsPayloads: true,
        retentionDays: 30,
        trainsOnCustomerData: true,
      }).success,
    ).toBe(true);
  });
});
