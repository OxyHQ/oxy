import { requireSingleLogicalDeployment } from '../kaanaBootstrapDeploymentSelection';

describe('Kaana bootstrap logical deployment selection', () => {
  it('refuses an absent row after the create/readback boundary', () => {
    expect(() => requireSingleLogicalDeployment([], 'deployment-exact-01')).toThrow(
      /exactly one legacy\/current row after create; found 0/,
    );
  });

  it('returns the exact single legacy or current row', () => {
    const row = { id: 'route-exact-01', availabilityScope: 'internal_alia' };
    expect(requireSingleLogicalDeployment([row], 'deployment-exact-01')).toBe(row);
  });

  it('refuses a coexisting legacy and current row instead of choosing by row order', () => {
    expect(() => requireSingleLogicalDeployment([
      { id: 'route-legacy', availabilityScope: 'internal_alia' },
      { id: 'route-current', availabilityScope: 'platform_internal' },
    ], 'deployment-exact-01')).toThrow(/exactly one legacy\/current row after create; found 2/);
  });
});
