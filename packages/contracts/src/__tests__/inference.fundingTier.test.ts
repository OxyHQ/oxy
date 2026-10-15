/**
 * ADR 0038: the one economic fact Oxy and Kaana exchange about provider keys.
 * Oxy bounds a route by a funding tier; Kaana reports the tier that served.
 */
import {
  authorizedRouteSchema,
  inferenceFundingTierSchema,
  normalizedUsageReportSchema,
} from '../index';

const route = {
  substitution: 'same_model' as const,
  deploymentId: 'dep_anthropic_opus5',
  modelReference: 'anthropic/claude-opus-5@2026-05-01',
  provider: 'anthropic',
  regions: [],
};

const report = {
  schemaVersion: 2,
  requestId: 'req_01H8Z9T6NB',
  attribution: {
    principal: {
      billing: { accountId: 'acc_01H8Z9QK7M' },
      applicationId: 'app_alia_prod',
      credentialId: 'cred_01H8Z9R2VX',
      environment: 'production',
      inferenceScopes: ['inference:invoke'],
    },
    requestId: 'req_01H8Z9T6NB',
  },
  outcome: 'completed',
  units: [{ unit: 'input_tokens', quantity: 812 }],
  usageSource: 'provider_reported',
  resolvedModelReference: 'anthropic/claude-opus-5@2026-05-01',
  servingProvider: 'anthropic',
  deploymentId: 'dep_anthropic_opus5',
  routeSwitches: 0,
  startedAt: '2026-10-12T09:41:00.120Z',
  completedAt: '2026-10-12T09:41:02.900Z',
};

describe('funding tiers (ADR 0038)', () => {
  it('names exactly free, credit and paid, in spending order', () => {
    expect(inferenceFundingTierSchema.options).toEqual(['free', 'credit', 'paid']);
  });

  it('lets a route carry a funding ceiling, and leaves it optional', () => {
    expect(authorizedRouteSchema.parse(route)).not.toHaveProperty('maxFundingTier');
    expect(authorizedRouteSchema.parse({ ...route, maxFundingTier: 'credit' })).toMatchObject({
      maxFundingTier: 'credit',
    });
    expect(
      authorizedRouteSchema.safeParse({ ...route, maxFundingTier: 'promotional' }).success,
    ).toBe(false);
  });

  it('refuses a ceiling beside a customer credential, which the provider bills to the customer', () => {
    const byok = {
      ...route,
      customerProviderCredential: {
        credentialHandle: 'kcred_abcdefghijklmnopqrstuvwxyz',
        credentialRevision: 1,
        ownerAccountId: 'acc_01H8Z9QK7M',
        connectionId: 'conn_1',
        environment: 'production' as const,
      },
    };
    const control = authorizedRouteSchema.safeParse(byok);
    expect(control.success).toBe(true);
    expect(authorizedRouteSchema.safeParse({ ...byok, maxFundingTier: 'credit' }).success).toBe(
      false,
    );
  });

  it('lets a usage report say which tier served, never which key', () => {
    expect(normalizedUsageReportSchema.parse(report)).not.toHaveProperty('fundingTier');
    expect(normalizedUsageReportSchema.parse({ ...report, fundingTier: 'credit' })).toMatchObject({
      fundingTier: 'credit',
    });
    expect(
      normalizedUsageReportSchema.safeParse({ ...report, fundingTier: 'unstated' }).success,
    ).toBe(false);
    const keys = Object.keys(normalizedUsageReportSchema.innerType().shape);
    for (const identity of ['keyId', 'credentialId', 'fundingAccountId', 'keyLabel']) {
      expect(keys).not.toContain(identity);
    }
  });
});
