import {
  getTierProgress,
  formatInfluenceMultiplier,
  formatReliabilityPercent,
} from '@/lib/civic/reputation-standing';
import type { ReputationInfluence, ReputationReliability } from '@oxyhq/contracts';

function influence(defaultWeight: number): ReputationInfluence {
  return {
    defaultWeight,
    reportWeight: defaultWeight,
    moderationWeight: defaultWeight,
    rankingFeedbackWeight: defaultWeight,
  };
}

function reliability(reportAccuracyScore: number): ReputationReliability {
  return { accurateReports: 0, rejectedReports: 0, reportAccuracyScore, abuseScore: 0 };
}

describe('getTierProgress', () => {
  it('reports progress toward the next tier from the "new" band', () => {
    expect(getTierProgress('new', 47)).toEqual({
      kind: 'progress',
      current: 47,
      targetMin: 100,
      remaining: 53,
      nextTier: 'trusted',
      fraction: 0.47,
    });
  });

  it('progresses from "trusted" toward "high_trust" within the 100..500 band', () => {
    expect(getTierProgress('trusted', 300)).toEqual({
      kind: 'progress',
      current: 300,
      targetMin: 500,
      remaining: 200,
      nextTier: 'high_trust',
      fraction: 0.5,
    });
  });

  it('reports "topPoints" at the highest points tier (high_trust)', () => {
    expect(getTierProgress('high_trust', 800)).toEqual({ kind: 'topPoints', current: 800 });
  });

  it('reports "max" for the verified (personhood) tier — no progress bar', () => {
    expect(getTierProgress('verified', 1200)).toEqual({ kind: 'max' });
  });

  it('reports "restricted" for the punitive tier', () => {
    expect(getTierProgress('restricted', -5)).toEqual({ kind: 'restricted' });
  });

  it('clamps the fill fraction and never returns a negative remaining', () => {
    const progress = getTierProgress('new', 150);
    expect(progress).toMatchObject({ kind: 'progress', fraction: 1, remaining: 0 });
  });
});

describe('formatInfluenceMultiplier', () => {
  it('renders the capped default weight as a one-decimal multiplier', () => {
    expect(formatInfluenceMultiplier(influence(1.4))).toBe('×1.4');
    expect(formatInfluenceMultiplier(influence(1))).toBe('×1.0');
  });
});

describe('formatReliabilityPercent', () => {
  it('renders the report accuracy score as a whole percent', () => {
    expect(formatReliabilityPercent(reliability(0.9))).toBe('90%');
    expect(formatReliabilityPercent(reliability(0.5))).toBe('50%');
  });
});
