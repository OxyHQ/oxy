import {
  effectiveSameModelDeployment,
  modelCatalogueEntrySchema,
  modelPowerClassSchema,
  powerLevelSchema,
  routingPolicySchema,
  routingProfileSchema,
} from '../index';

const POLICY = {
  schemaVersion: 2,
  routingPolicyId: 'rp_1',
  policyVersion: 1,
  scope: { kind: 'account', accountId: 'a'.repeat(24) },
  requireZeroDataRetention: false,
  prohibitTrainingOnCustomerData: false,
  optimiseFor: 'price',
  oxyHostedOnly: false,
  requireCommercialUseRights: false,
  fallback: { disabled: false },
  byokPreference: 'disabled',
  dedicatedCapacity: 'disabled',
  updatedAt: '2026-09-30T00:00:00.000Z',
};

describe('power levels (contract set 3.4.0)', () => {
  it('names seven levels and five model classes, and neither contains a slash', () => {
    expect(powerLevelSchema.options).toEqual([
      'auto',
      'instant',
      'medium',
      'high',
      'xhigh',
      'pro',
      'ultra',
    ]);
    expect(modelPowerClassSchema.options).toEqual(['instant', 'medium', 'high', 'pro', 'ultra']);
    expect(modelPowerClassSchema.safeParse('xhigh').success).toBe(false);
    expect(modelPowerClassSchema.safeParse('auto').success).toBe(false);
  });

  it('carries the level and its effort on a routing profile', () => {
    const profile = routingProfileSchema.parse({
      schemaVersion: 1,
      routingProfileId: 'power-medium',
      slug: 'medium',
      displayName: 'Medium',
      optimiseFor: 'price',
      candidates: [{ modelReference: 'pub/model', priority: 0 }],
      isProductPreset: true,
      powerLevel: 'medium',
      reasoningEffort: 'low',
    });
    expect(profile.powerLevel).toBe('medium');
    expect(profile.reasoningEffort).toBe('low');
    expect(routingProfileSchema.safeParse({ ...profile, powerLevel: 'turbo' }).success).toBe(false);
  });

  it('keeps powerClass optional on a catalogue entry and closed when present', () => {
    const shape = modelCatalogueEntrySchema.shape.powerClass;
    expect(shape.safeParse(undefined).success).toBe(true);
    expect(shape.safeParse('pro').success).toBe(true);
    expect(shape.safeParse('xhigh').success).toBe(false);
  });
});

describe('routing policy additions', () => {
  it('defaults allowedRoutingProfileIds to no restriction', () => {
    expect(routingPolicySchema.parse(POLICY).allowedRoutingProfileIds).toEqual([]);
  });

  it('refuses a default profile outside a non-empty allowed list', () => {
    const result = routingPolicySchema.safeParse({
      ...POLICY,
      defaultTarget: { kind: 'routing_profile_id', routingProfileId: 'power-high' },
      allowedRoutingProfileIds: ['power-instant'],
    });
    expect(result.success).toBe(false);
    expect(
      routingPolicySchema.safeParse({
        ...POLICY,
        defaultTarget: { kind: 'routing_profile_id', routingProfileId: 'power-instant' },
        allowedRoutingProfileIds: ['power-instant'],
      }).success,
    ).toBe(true);
  });

  it('refuses a duplicated allowed profile', () => {
    expect(
      routingPolicySchema.safeParse({ ...POLICY, allowedRoutingProfileIds: ['a', 'a'] }).success,
    ).toBe(false);
  });

  it('treats an omitted sameModelDeployment as on unless fallback is disabled', () => {
    expect(effectiveSameModelDeployment({ disabled: false })).toBe(true);
    expect(effectiveSameModelDeployment({ disabled: false, sameModelDeployment: false })).toBe(
      false,
    );
    expect(effectiveSameModelDeployment({ disabled: true })).toBe(false);
    // disabled + omitted is a coherent policy, not a contradiction.
    expect(routingPolicySchema.safeParse({ ...POLICY, fallback: { disabled: true } }).success).toBe(
      true,
    );
  });
});
