/**
 * ADR 0038: Kaana must never spend beyond the funding tier Oxy signed on a
 * route. The edge cannot un-spend, so a report naming a dearer tier is the
 * evidence of a breach, logged loudly while the request still settles.
 */
import { fundingCeilingBreach } from '../inferenceEdge.service';

const ceilings = new Map([['dep_anthropic_opus', 'credit' as const]]);

describe('fundingCeilingBreach', () => {
  it('names a paid key spent on a credit-only route', () => {
    expect(
      fundingCeilingBreach({ deploymentId: 'dep_anthropic_opus', fundingTier: 'paid' }, ceilings),
    ).toEqual({ ceiling: 'credit', served: 'paid' });
  });

  it('accepts a tier at or below the ceiling', () => {
    for (const fundingTier of ['free', 'credit'] as const) {
      expect(
        fundingCeilingBreach({ deploymentId: 'dep_anthropic_opus', fundingTier }, ceilings),
      ).toBeUndefined();
    }
  });

  it('reads nothing into a route without a ceiling or a report that states no tier', () => {
    expect(
      fundingCeilingBreach({ deploymentId: 'dep_openrouter_opus', fundingTier: 'paid' }, ceilings),
    ).toBeUndefined();
    expect(fundingCeilingBreach({ deploymentId: 'dep_anthropic_opus' }, ceilings)).toBeUndefined();
    expect(
      fundingCeilingBreach({ deploymentId: 'dep_anthropic_opus', fundingTier: 'paid' }, undefined),
    ).toBeUndefined();
  });
});
