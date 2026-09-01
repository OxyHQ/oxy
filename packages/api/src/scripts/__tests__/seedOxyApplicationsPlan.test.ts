/**
 * THE INVARIANT of `scripts/seed-oxy-applications.ts`, pinned: the dry run
 * reports EXACTLY what the real run would change.
 *
 * Same class of bug as `registerCommonsClientsPlan.test.ts`: reconcile lived
 * inside `if (!dryRun)`, so dry runs under-reported updates.
 */

import {
  applySeedApplicationPlan,
  computeSeedApplicationPlan,
  readSeedApplicationState,
  type MutableSeedApplicationFields,
  type SeedApplicationState,
  type SeedApplicationTarget,
} from '../seedOxyApplicationsPlan';

const OWNER = '69b2d3df5d12f58c9800d651';

const COMMONS_TARGET: SeedApplicationTarget = {
  description:
    'Official Oxy Commons app — self-sovereign identity wallet and Sign-in-with-Oxy approvals (native).',
  type: 'first_party',
  ownerAccountId: OWNER,
  redirectUris: ['commons://', 'oxycommons://'],
  scopes: ['user:read'],
  capabilities: ['identity:approval'],
};

function commonsMissingCapability(): SeedApplicationState {
  return {
    description: COMMONS_TARGET.description,
    websiteUrl: null,
    status: 'active',
    type: 'first_party',
    isOfficial: true,
    isInternal: false,
    ownerAccountId: OWNER,
    redirectUris: ['commons://', 'oxycommons://'],
    scopes: ['user:read'],
    capabilities: [],
  };
}

function mutableRecord(state: SeedApplicationState): MutableSeedApplicationFields {
  return { ...state };
}

describe('computeSeedApplicationPlan', () => {
  it('reports a capability union that a dry run would have hidden before the fix', () => {
    const plan = computeSeedApplicationPlan(commonsMissingCapability(), COMMONS_TARGET);

    expect(plan.creates).toBe(false);
    expect(plan.changes.map((change) => change.field)).toEqual(['capabilities']);
    expect(plan.changes[0]).toMatchObject({
      from: '(none)',
      to: 'identity:approval',
    });
  });

  it('treats null and undefined websiteUrl as equal', () => {
    const current = {
      ...commonsMissingCapability(),
      capabilities: ['identity:approval'],
    };
    const plan = computeSeedApplicationPlan(current, COMMONS_TARGET);

    expect(plan.changes.some((change) => change.field === 'websiteUrl')).toBe(false);
  });

  it('reports no changes when the record is already reconciled', () => {
    const current = {
      ...commonsMissingCapability(),
      capabilities: ['identity:approval'],
    };
    const plan = computeSeedApplicationPlan(current, COMMONS_TARGET);

    expect(plan.changes).toEqual([]);
  });

  it('applySeedApplicationPlan writes exactly the fields the plan reported', () => {
    const plan = computeSeedApplicationPlan(commonsMissingCapability(), COMMONS_TARGET);
    const record = mutableRecord(commonsMissingCapability());

    const written = applySeedApplicationPlan(record, plan);

    expect(written).toEqual(plan.changes.map((change) => change.field));
    expect(record.capabilities).toEqual(['identity:approval']);
  });

  it('readSeedApplicationState normalizes a null websiteUrl', () => {
    const state = readSeedApplicationState({
      description: 'x',
      websiteUrl: null,
      status: 'active',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      ownerAccountId: OWNER,
      redirectUris: [],
      scopes: ['user:read'],
      capabilities: [],
    });

    expect(state.websiteUrl).toBeNull();
  });
});
