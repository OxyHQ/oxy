/**
 * Pure derivation tests for #219: trust tiers, capped influence, reliability.
 * No DB — exercises the formulas directly against the documented constants.
 */

import {
  computeReliability,
  computeReporting,
  deriveConductStanding,
  deriveContextualInfluence,
  deriveContributionTier,
  deriveTrustTier,
  deriveInfluence,
  baseTrustWeight,
} from '../reputationDerive';
import type { ConductStanding } from '@oxyhq/contracts';
import {
  INFLUENCE_MIN,
  INFLUENCE_MAX,
  TRUST_TIER_HIGH_TRUST_MIN,
  TRUST_TIER_TRUSTED_MIN,
  NEUTRAL_REPORT_ACCURACY,
} from '../reputation.constants';
import {
  CONTEXTUAL_WEIGHT_MAX,
  CONTEXTUAL_WEIGHT_MIN,
} from '../moderation.constants';
import type { ReputationReliability } from '@oxyhq/contracts';

const NEUTRAL: ReputationReliability = {
  accurateReports: 0,
  rejectedReports: 0,
  reportAccuracyScore: NEUTRAL_REPORT_ACCURACY,
  abuseScore: 0,
};

/**
 * `deriveTrustTier` takes an object now, and the two totals are distinct: the
 * positive ladder reads `total`, the punitive `< 0` clause reads
 * `nonConductTotal`. This helper keeps them equal — the shape every user with no
 * conduct transaction has — so the existing threshold cases still assert exactly
 * what they always asserted.
 */
function tierOf(
  total: number,
  verified: boolean,
  reliability: ReputationReliability,
  conductStanding: ConductStanding = 'good'
) {
  return deriveTrustTier({
    total,
    nonConductTotal: total,
    verified,
    reliability,
    conductStanding,
  });
}

describe('computeReliability', () => {
  it('returns the neutral 0.5 accuracy for a user with no report history', () => {
    const r = computeReliability({ accurateReports: 0, rejectedReports: 0, reportAbuseCount: 0 });
    expect(r.reportAccuracyScore).toBe(NEUTRAL_REPORT_ACCURACY);
    expect(r.abuseScore).toBe(0);
  });

  it('accuracy rises with accurate reports', () => {
    const r = computeReliability({ accurateReports: 9, rejectedReports: 1, reportAbuseCount: 0 });
    expect(r.reportAccuracyScore).toBeCloseTo(0.9, 5);
  });

  it('accuracy falls with rejected reports', () => {
    const r = computeReliability({ accurateReports: 1, rejectedReports: 9, reportAbuseCount: 0 });
    expect(r.reportAccuracyScore).toBeCloseTo(0.1, 5);
  });

  it('abuse score is smoothed and clamped to [0,1]', () => {
    // rejected=10, report abuse=10 → numerator 10 + 2*10 = 30; denom 0+10+10+5 = 25
    // raw = 1.2 → clamped to 1.
    const r = computeReliability({ accurateReports: 0, rejectedReports: 10, reportAbuseCount: 10 });
    expect(r.abuseScore).toBe(1);
  });

  /*
   * THE SEPARATION. `abuseScore` used to count EVERY negative transaction at
   * double weight, so an unrelated conduct penalty drove a REPORT-ABUSE verdict —
   * and `abuseScore >= 0.5` forces the `restricted` tier. One `vouch_slashed`
   * alone reached ≈0.33, a third of the way there, through a path that has
   * nothing to do with reports.
   *
   * The counter is now `reportAbuseCount`: only CONFIRMED report abuse. These two
   * cases are what fail if anyone widens it back.
   */
  it('a conduct penalty does not touch the reporting-abuse signal', () => {
    // A subject with three conduct penalties and no reporting history at all.
    // Under the old counter this was (0 + 2*3) / (0 + 0 + 3 + 5) = 0.75 →
    // `restricted`. The conduct axis carries it now, so the reporting signal
    // stays exactly neutral.
    const r = computeReliability({ accurateReports: 0, rejectedReports: 0, reportAbuseCount: 0 });
    expect(r.abuseScore).toBe(0);
    expect(r.reportAccuracyScore).toBe(NEUTRAL_REPORT_ACCURACY);
  });

  it('confirmed report abuse — and only that — raises the abuse score', () => {
    const clean = computeReliability({
      accurateReports: 4,
      rejectedReports: 0,
      reportAbuseCount: 0,
    });
    const abusive = computeReliability({
      accurateReports: 4,
      rejectedReports: 0,
      reportAbuseCount: 3,
    });
    expect(clean.abuseScore).toBe(0);
    expect(abusive.abuseScore).toBeGreaterThan(clean.abuseScore);
  });
});

describe('deriveTrustTier (#219 thresholds)', () => {
  it('a fresh user with zero total is "new"', () => {
    expect(tierOf(0, false, NEUTRAL)).toBe('new');
  });

  it(`total >= ${TRUST_TIER_TRUSTED_MIN} is "trusted"`, () => {
    expect(tierOf(TRUST_TIER_TRUSTED_MIN, false, NEUTRAL)).toBe('trusted');
    expect(tierOf(TRUST_TIER_TRUSTED_MIN - 1, false, NEUTRAL)).toBe('new');
  });

  it(`total >= ${TRUST_TIER_HIGH_TRUST_MIN} is "high_trust"`, () => {
    expect(tierOf(TRUST_TIER_HIGH_TRUST_MIN, false, NEUTRAL)).toBe('high_trust');
    expect(tierOf(TRUST_TIER_HIGH_TRUST_MIN - 1, false, NEUTRAL)).toBe('trusted');
  });

  it('a negative total forces "restricted" regardless of verified', () => {
    expect(tierOf(-1, true, NEUTRAL)).toBe('restricted');
  });

  it('a high abuse score forces "restricted" even with a high total', () => {
    const abusive: ReputationReliability = { ...NEUTRAL, abuseScore: 0.5 };
    expect(tierOf(10_000, false, abusive)).toBe('restricted');
  });

  it('verified beats both high_trust and trusted thresholds', () => {
    expect(tierOf(0, true, NEUTRAL)).toBe('verified');
    expect(tierOf(TRUST_TIER_HIGH_TRUST_MIN, true, NEUTRAL)).toBe('verified');
  });
});

describe('deriveInfluence (#219 capped weights)', () => {
  it('base weight at total=0 is the floor offset', () => {
    expect(baseTrustWeight(0)).toBeCloseTo(0.1, 5);
  });

  it('every weight is clamped to [INFLUENCE_MIN, INFLUENCE_MAX]', () => {
    const inf = deriveInfluence(1_000_000, 'verified', NEUTRAL);
    for (const weight of Object.values(inf)) {
      expect(weight).toBeGreaterThanOrEqual(INFLUENCE_MIN);
      expect(weight).toBeLessThanOrEqual(INFLUENCE_MAX);
    }
    // A pathologically large total saturates the default weight at the cap.
    expect(inf.defaultWeight).toBe(INFLUENCE_MAX);
  });

  it('restricted users are floored to INFLUENCE_MIN on every axis', () => {
    const inf = deriveInfluence(10_000, 'restricted', NEUTRAL);
    expect(inf.defaultWeight).toBe(INFLUENCE_MIN);
    expect(inf.reportWeight).toBe(INFLUENCE_MIN);
    expect(inf.moderationWeight).toBe(INFLUENCE_MIN);
    expect(inf.rankingFeedbackWeight).toBe(INFLUENCE_MIN);
  });

  it('reportWeight rises with accurate reports and falls with rejected ones', () => {
    const total = 500;
    const accurate = computeReliability({ accurateReports: 10, rejectedReports: 0, reportAbuseCount: 0 });
    const inaccurate = computeReliability({ accurateReports: 0, rejectedReports: 10, reportAbuseCount: 0 });

    const accurateWeight = deriveInfluence(total, 'high_trust', accurate).reportWeight;
    const neutralWeight = deriveInfluence(total, 'high_trust', NEUTRAL).reportWeight;
    const inaccurateWeight = deriveInfluence(total, 'high_trust', inaccurate).reportWeight;

    expect(accurateWeight).toBeGreaterThan(neutralWeight);
    expect(inaccurateWeight).toBeLessThan(neutralWeight);
  });

  it('moderation weight scales up by tier', () => {
    const total = 200;
    const newWeight = deriveInfluence(total, 'new', NEUTRAL).moderationWeight;
    const trustedWeight = deriveInfluence(total, 'trusted', NEUTRAL).moderationWeight;
    const verifiedWeight = deriveInfluence(total, 'verified', NEUTRAL).moderationWeight;
    expect(trustedWeight).toBeGreaterThan(newWeight);
    expect(verifiedWeight).toBeGreaterThan(trustedWeight);
  });
});

/*
 * THE CONDUCT AXIS.
 *
 * Two defects motivate every case below, and they pull in opposite directions:
 *  - contribution offsetting conduct (earn enough points, cancel a strike), and
 *  - a single small penalty restricting a new account outright.
 *
 * Separating the axes is what fixes both at once, so these tests assert the
 * separation itself rather than any particular number.
 */

describe('deriveConductStanding', () => {
  it('no active risk is "good"', () => {
    expect(deriveConductStanding(0)).toBe('good');
  });

  it('the baseline bands match the severity table they were calibrated against', () => {
    // A single incident of each severity, at its base risk, lands on the standing
    // the conduct policy says it should. Low is `watch`, NOT a restriction.
    expect(deriveConductStanding(1)).toBe('watch');
    expect(deriveConductStanding(3)).toBe('watch');
    expect(deriveConductStanding(8)).toBe('limited');
    expect(deriveConductStanding(20)).toBe('restricted');
  });

  it('evaluates highest-first, so a differently-ordered stored policy cannot pick the wrong band', () => {
    const shuffled = [
      { standing: 'watch' as const, minRisk: 1 },
      { standing: 'restricted' as const, minRisk: 20 },
      { standing: 'good' as const, minRisk: 0 },
      { standing: 'limited' as const, minRisk: 8 },
    ];
    expect(deriveConductStanding(25, shuffled)).toBe('restricted');
    expect(deriveConductStanding(9, shuffled)).toBe('limited');
  });
});

describe('contribution and conduct are independent axes', () => {
  it('contribution points cannot buy back a conduct standing', () => {
    // The pair the model exists to make representable: a long, genuine
    // contribution history AND an active consequence.
    expect(deriveContributionTier(2000)).toBe('high_trust');
    expect(deriveConductStanding(9)).toBe('limited');
  });

  it('the contribution tier has no punitive band at all', () => {
    // Conduct is expressed as standing, never as a demotion of what was built.
    for (const points of [0, 99, 100, 499, 500, 100_000]) {
      expect(['new', 'trusted', 'high_trust']).toContain(deriveContributionTier(points));
    }
  });

  it('a conduct restriction still reaches a caller that only knows about trustTier', () => {
    // The legacy tier is layered, not replaced — a consumer unaware of the
    // conduct axis must not read a restricted person as unremarkable.
    expect(
      deriveTrustTier({
        total: 5000,
        nonConductTotal: 5000,
        verified: true,
        reliability: NEUTRAL,
        conductStanding: 'restricted',
      })
    ).toBe('restricted');
  });

  it('a single low-severity conduct penalty does NOT restrict a new account', () => {
    // The other half of the defect. The ledger total goes negative (−2), but the
    // punitive clause reads the NON-conduct total, and the conduct policy rates a
    // single low finding as `watch`.
    expect(
      deriveTrustTier({
        total: -2,
        nonConductTotal: 0,
        verified: false,
        reliability: NEUTRAL,
        conductStanding: 'watch',
      })
    ).toBe('new');
  });

  it('a NON-conduct penalty still restricts exactly as it did before', () => {
    // Unchanged behaviour for every existing penalty type: nothing about the
    // separation weakens a sanction that was already in force.
    expect(
      deriveTrustTier({
        total: -20,
        nonConductTotal: -20,
        verified: false,
        reliability: NEUTRAL,
        conductStanding: 'good',
      })
    ).toBe('restricted');
  });
});

describe('computeReporting (Beta posterior with a neutral prior)', () => {
  it('a reporter with no history sits at the neutral prior with zero confidence', () => {
    const r = computeReporting({ confirmed: 0, rejected: 0, malicious: 0 });
    expect(r.reliability).toBeCloseTo(0.5, 5);
    expect(r.confidence).toBe(0);
  });

  it('one accurate report does not make a perfect reporter', () => {
    const r = computeReporting({ confirmed: 1, rejected: 0, malicious: 0 });
    expect(r.reliability).toBeLessThan(1);
    expect(r.reliability).toBeGreaterThan(0.5);
    expect(r.confidence).toBeLessThan(1);
  });

  it('confidence grows with sample size and saturates at 1', () => {
    const few = computeReporting({ confirmed: 2, rejected: 1, malicious: 0 });
    const many = computeReporting({ confirmed: 40, rejected: 20, malicious: 0 });
    expect(many.confidence).toBeGreaterThan(few.confidence);
    expect(many.confidence).toBe(1);
  });

  it('confirmed report abuse weighs far more heavily than a rejected report', () => {
    const rejected = computeReporting({ confirmed: 5, rejected: 1, malicious: 0 });
    const malicious = computeReporting({ confirmed: 5, rejected: 0, malicious: 1 });
    expect(malicious.reliability).toBeLessThan(rejected.reliability);
  });
});

describe('deriveContextualInfluence', () => {
  const base = {
    contributionPoints: 500,
    reportingReliability: 0.9,
    reportingConfidence: 1,
    reviewingReliability: 0.9,
  };

  it('conduct standing scales every weight down', () => {
    const good = deriveContextualInfluence({ ...base, conductStanding: 'good' });
    const watch = deriveContextualInfluence({ ...base, conductStanding: 'watch' });
    const limited = deriveContextualInfluence({ ...base, conductStanding: 'limited' });

    expect(watch.reviewSelectionWeight).toBeLessThan(good.reviewSelectionWeight);
    expect(limited.reviewSelectionWeight).toBeLessThan(watch.reviewSelectionWeight);
    expect(limited.reportPriorityWeight).toBeLessThan(good.reportPriorityWeight);
  });

  it('restricted floors every weight', () => {
    const restricted = deriveContextualInfluence({ ...base, conductStanding: 'restricted' });
    expect(restricted.reportPriorityWeight).toBe(CONTEXTUAL_WEIGHT_MIN);
    expect(restricted.reviewSelectionWeight).toBe(CONTEXTUAL_WEIGHT_MIN);
    expect(restricted.rankingWeight).toBe(CONTEXTUAL_WEIGHT_MIN);
  });

  it('a reliability estimate only moves the weight in proportion to its confidence', () => {
    // The same 0.9 estimate, once unproven and once well-evidenced. An unproven
    // reporter must not be promoted on a single data point.
    const unproven = deriveContextualInfluence({
      ...base,
      reportingConfidence: 0,
      conductStanding: 'good',
    });
    const evidenced = deriveContextualInfluence({
      ...base,
      reportingConfidence: 1,
      conductStanding: 'good',
    });
    expect(evidenced.reportPriorityWeight).toBeGreaterThan(unproven.reportPriorityWeight);
  });

  it('every weight stays inside the documented bounds', () => {
    const extreme = deriveContextualInfluence({
      contributionPoints: 10_000_000,
      conductStanding: 'good',
      reportingReliability: 1,
      reportingConfidence: 1,
      reviewingReliability: 1,
    });
    for (const weight of Object.values(extreme)) {
      expect(weight).toBeGreaterThanOrEqual(CONTEXTUAL_WEIGHT_MIN);
      expect(weight).toBeLessThanOrEqual(CONTEXTUAL_WEIGHT_MAX);
    }
  });
});
