import { describe, expect, it } from 'vitest';
import { routingPolicySchema } from '@oxyhq/contracts';
import type { ModelCatalogueEntry, RoutingPolicy } from '@oxyhq/contracts';
import type { StoredRoutingPolicy } from '@/lib/routing-policy';
import {
  catalogueLicences,
  catalogueModelReferences,
  controlsFromPolicy,
  defaultRoutingPolicyControls,
  effectivePolicyOrigin,
  routingPolicyHighlights,
} from '@/lib/routing-policy';

/**
 * Policies are built through the CONTRACT's own schema, not as literals.
 *
 * The schema's refinement rejects a contradictory policy, so a fixture that
 * drifts out of the contract fails at construction rather than silently testing
 * a shape the API would never send.
 */
function policy(overrides: Record<string, unknown> = {}): RoutingPolicy {
  return routingPolicySchema.parse({
    schemaVersion: 1,
    routingPolicyId: 'rp_1',
    policyVersion: 3,
    scope: { kind: 'application', accountId: 'acct_1', applicationId: 'app_1' },
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
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  });
}

function stored(overrides: Record<string, unknown> = {}): StoredRoutingPolicy {
  return {
    routingPolicyId: 'rp_1',
    versionId: 'rpv_1',
    status: 'active',
    policy: policy(overrides),
  };
}

describe('controlsFromPolicy', () => {
  it('keeps every control and drops every server-owned identity field', () => {
    const controls = controlsFromPolicy(
      policy({
        providerAllowlist: ['alpha'],
        deniedRegions: ['eu-west-1'],
        requireZeroDataRetention: true,
        optimiseFor: 'price',
        allowedLicenseIds: ['apache-2.0'],
        byokPreference: 'prefer',
        dedicatedCapacity: 'require',
      })
    );

    expect(controls.providerAllowlist).toEqual(['alpha']);
    expect(controls.deniedRegions).toEqual(['eu-west-1']);
    expect(controls.requireZeroDataRetention).toBe(true);
    expect(controls.optimiseFor).toBe('price');
    expect(controls.allowedLicenseIds).toEqual(['apache-2.0']);
    expect(controls.byokPreference).toBe('prefer');
    expect(controls.dedicatedCapacity).toBe('require');

    for (const serverOwned of ['routingPolicyId', 'policyVersion', 'scope', 'updatedAt', 'schemaVersion']) {
      expect(Object.hasOwn(controls, serverOwned)).toBe(false);
    }
  });

  it('copies the lists rather than aliasing the policy it read them from', () => {
    const source = policy({ providerDenylist: ['alpha'] });
    const controls = controlsFromPolicy(source);

    controls.providerDenylist.push('beta');
    controls.fallback.authorizedCrossModel.push('publisher/model');

    expect(source.providerDenylist).toEqual(['alpha']);
    expect(source.fallback.authorizedCrossModel).toEqual([]);
  });

  it('round-trips back into a policy the contract still accepts', () => {
    const original = policy({
      providerAllowlist: ['alpha'],
      fallback: {
        disabled: false,
        sameModelDeployment: false,
        authorizedCrossModel: ['publisher/model@2026-01-01'],
      },
    });

    const rebuilt = routingPolicySchema.parse({
      ...controlsFromPolicy(original),
      schemaVersion: 1,
      routingPolicyId: original.routingPolicyId,
      policyVersion: original.policyVersion + 1,
      scope: original.scope,
      updatedAt: original.updatedAt,
    });

    expect(rebuilt.providerAllowlist).toEqual(['alpha']);
    expect(rebuilt.fallback.authorizedCrossModel).toEqual(['publisher/model@2026-01-01']);
  });
});

describe('defaultRoutingPolicyControls', () => {
  it('constrains nothing, so a new policy cannot narrow routing by surprise', () => {
    const controls = defaultRoutingPolicyControls();

    expect(controls.defaultTarget).toBeUndefined();
    expect(controls.providerAllowlist).toEqual([]);
    expect(controls.providerDenylist).toEqual([]);
    expect(controls.allowedRegions).toEqual([]);
    expect(controls.deniedRegions).toEqual([]);
    expect(controls.allowedLicenseIds).toEqual([]);
    expect(controls.maxPricePerUnit).toEqual([]);
    expect(controls.maxPricePerRequest).toBeUndefined();
    expect(controls.requireZeroDataRetention).toBe(false);
    expect(controls.prohibitTrainingOnCustomerData).toBe(false);
    expect(controls.oxyHostedOnly).toBe(false);
    expect(controls.requireCommercialUseRights).toBe(false);
    expect(controls.byokPreference).toBe('disabled');
    expect(controls.dedicatedCapacity).toBe('disabled');
  });

  it('leaves same-model deployment failover on — an availability decision, not a substitution', () => {
    const controls = defaultRoutingPolicyControls();

    expect(controls.fallback.disabled).toBe(false);
    expect(controls.fallback.sameModelDeployment).toBe(true);
    expect(controls.fallback.authorizedCrossModel).toEqual([]);
  });

  it('is a policy the contract accepts', () => {
    expect(() =>
      routingPolicySchema.parse({
        ...defaultRoutingPolicyControls(),
        schemaVersion: 1,
        routingPolicyId: 'rp_new',
        policyVersion: 1,
        scope: { kind: 'application', accountId: 'acct_1', applicationId: 'app_1' },
        updatedAt: '2026-08-01T00:00:00.000Z',
      })
    ).not.toThrow();
  });
});

describe('effectivePolicyOrigin', () => {
  it('reads the origin off the scope the policy carries', () => {
    expect(effectivePolicyOrigin(stored())).toBe('application');
    expect(effectivePolicyOrigin(stored({ scope: { kind: 'account', accountId: 'acct_1' } }))).toBe(
      'account'
    );
  });
});

describe('routingPolicyHighlights', () => {
  it('says a policy with no default target requires the caller to name a model', () => {
    const highlights = routingPolicyHighlights(policy());
    const target = highlights.find((entry) => entry.label === 'Default target');

    expect(target?.value).toBe('Every request must name its own model');
  });

  it('distinguishes a routing profile from a model, never printing one as the other', () => {
    const asModel = routingPolicyHighlights(
      policy({ defaultTarget: { kind: 'model', modelReference: 'publisher/model' } })
    ).find((entry) => entry.label === 'Default target');
    const asProfile = routingPolicyHighlights(
      policy({ defaultTarget: { kind: 'routing_profile', routingProfile: 'fast' } })
    ).find((entry) => entry.label === 'Default target');

    expect(asModel?.value).toBe('publisher/model');
    expect(asProfile?.value).toBe('Routing profile: fast');
  });

  it('reports a disabled fallback as a refusal, not as an empty list', () => {
    const highlights = routingPolicyHighlights(
      policy({
        fallback: { disabled: true, sameModelDeployment: false, authorizedCrossModel: [] },
      })
    );
    const fallback = highlights.find((entry) => entry.label === 'Fallback');

    expect(fallback?.value).toContain('Disabled');
    expect(fallback?.value).toContain('fails');
  });

  it('names every authorised cross-model substitute rather than counting them', () => {
    const highlights = routingPolicyHighlights(
      policy({
        fallback: {
          disabled: false,
          sameModelDeployment: true,
          authorizedCrossModel: ['publisher/a', 'publisher/b'],
        },
      })
    );
    const fallback = highlights.find((entry) => entry.label === 'Fallback');

    expect(fallback?.value).toContain('publisher/a');
    expect(fallback?.value).toContain('publisher/b');
  });

  it('renders price ceilings with their unit, currency and divisor', () => {
    const highlights = routingPolicyHighlights(
      policy({
        maxPricePerUnit: [
          { unit: 'input_tokens', amount: '0.000003', per: 1, currency: 'USD' },
        ],
        maxPricePerRequest: { amount: '0.05', currency: 'USD' },
      })
    );
    const ceilings = highlights.find((entry) => entry.label === 'Price ceilings');

    expect(ceilings?.value).toContain('Input tokens: 0.000003 USD per 1');
    expect(ceilings?.value).toContain('Per request: 0.05 USD');
  });

  it('covers every control, so the summary cannot understate a policy', () => {
    const labels = routingPolicyHighlights(policy()).map((entry) => entry.label);

    expect(labels).toEqual([
      'Default target',
      'Optimise for',
      'Providers allowed',
      'Providers denied',
      'Regions allowed',
      'Regions denied',
      'Zero data retention',
      'Training on customer data',
      'Oxy-hosted only',
      'Licences allowed',
      'Commercial use rights',
      'Price ceilings',
      'Fallback',
      'Your provider credentials',
      'Dedicated capacity',
    ]);
  });
});

describe('catalogue-derived option lists', () => {
  const licence = {
    licenseId: 'apache-2.0',
    displayName: 'Apache 2.0',
    commercialUseAllowed: true,
    requiresAttribution: true,
  };

  const entries = [
    {
      modelId: 'publisher/one',
      availableRevisions: ['2026-01-01', '2025-06-01'],
      license: licence,
    },
    {
      modelId: 'publisher/two',
      availableRevisions: ['2026-02-01'],
      license: licence,
    },
  ] satisfies Array<Pick<ModelCatalogueEntry, 'modelId' | 'availableRevisions' | 'license'>>;

  it('offers both the model line and each pinnable revision', () => {
    expect(catalogueModelReferences(entries)).toEqual([
      'publisher/one',
      'publisher/one@2026-01-01',
      'publisher/one@2025-06-01',
      'publisher/two',
      'publisher/two@2026-02-01',
    ]);
  });

  it('deduplicates licences shared across models', () => {
    expect(catalogueLicences(entries)).toEqual([
      { licenseId: 'apache-2.0', displayName: 'Apache 2.0' },
    ]);
  });

  it('offers nothing at all from an empty catalogue', () => {
    // The load-bearing case: today's catalogue is empty, and an empty option
    // list is what lets the editor render an honest empty state instead of a
    // free-text box that would write an unservable id.
    expect(catalogueModelReferences([])).toEqual([]);
    expect(catalogueLicences([])).toEqual([]);
  });
});
