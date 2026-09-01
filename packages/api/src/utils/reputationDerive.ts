/**
 * Pure derivation of trust tier, influence weights, and reliability (#219),
 * plus the multidimensional axes the moderation bridge introduced.
 *
 * These functions are intentionally DB-free and side-effect-free so they can be
 * unit-tested in isolation and reused anywhere. `reputation.service.ts` feeds
 * them aggregated counts from the ledger; they return the derived snapshot that
 * is persisted on `ReputationBalance`.
 *
 * Every constant lives in `reputation.constants.ts` / `moderation.constants.ts`
 * — nothing here is hardcoded.
 *
 * THE SEPARATION THIS FILE ENFORCES
 *
 * Four axes, and a signal on one may never move another:
 *  - CONTRIBUTION — what the person built. Positive-only ladder.
 *  - CONDUCT      — the standing moderation outcomes move. Derived from ACTIVE
 *    RISK alone, which is what makes contribution points unable to cancel a
 *    strike.
 *  - REPORTING    — how accurate this person's reports are, and nothing else.
 *  - REVIEWING    — competence as a reviewer, per category and language.
 *
 * `computeReliability` used to count EVERY negative transaction toward
 * `abuseScore` at double weight, and `abuseScore` forces the `restricted` tier.
 * A penalty for unrelated conduct therefore drove a report-abuse verdict: one
 * `vouch_slashed` alone reached a third of the way to a forced restriction. It
 * now counts only CONFIRMED REPORT ABUSE, so the reporting axis carries
 * reporting signals and the conduct axis carries conduct.
 */

import {
  clamp,
  ABUSE_PENALTY_WEIGHT,
  ABUSE_RESTRICT_THRESHOLD,
  ABUSE_SMOOTHING,
  INFLUENCE_BASE_OFFSET,
  INFLUENCE_MAX,
  INFLUENCE_MIN,
  INFLUENCE_TOTAL_DIVISOR,
  MODERATION_TIER_FACTOR,
  NEUTRAL_REPORT_ACCURACY,
  RANKING_FEEDBACK_FACTOR,
  REPORT_WEIGHT_ACCURACY_OFFSET,
  TRUST_TIER_HIGH_TRUST_MIN,
  TRUST_TIER_TRUSTED_MIN,
} from './reputation.constants';
import {
  BASELINE_STANDING_THRESHOLDS,
  CONTEXTUAL_WEIGHT_MAX,
  CONTEXTUAL_WEIGHT_MIN,
  CONTRIBUTION_TIER_HIGH_TRUST_MIN,
  CONTRIBUTION_TIER_TRUSTED_MIN,
  REPORTING_MALICIOUS_WEIGHT,
  REPORTING_PRIOR_FAILURE,
  REPORTING_PRIOR_SUCCESS,
  REPORTING_TARGET_SAMPLE_SIZE,
  STANDING_WEIGHT_FACTOR,
} from './moderation.constants';
import type { ConductStanding, ContributionTier, TrustTier } from '@oxyhq/contracts';
import type { ConductStandingThreshold } from '../db/schema/moderationPolicyStandingThresholds';
import type {
  ReputationContextualInfluenceSnapshot,
  ReputationInfluence,
  ReputationReliability,
  ReputationReportingSnapshot,
} from '../db/schema/reputationBalances';

/** Raw moderation counts pulled from the active ledger for one user. */
export interface ReliabilityCounts {
  accurateReports: number;
  rejectedReports: number;
  /**
   * Count of CONFIRMED REPORT-ABUSE transactions — manipulation, harassment by
   * reporting, abusive automation.
   *
   * Deliberately not "every penalty". A conduct penalty belongs on the conduct
   * axis; counting it here made an unrelated sanction drive a report-abuse
   * verdict, and `abuseScore >= ABUSE_RESTRICT_THRESHOLD` forces `restricted`.
   */
  reportAbuseCount: number;
}

/**
 * Compute the reliability block (report accuracy + abuse score) from raw
 * REPORTING counts.
 *
 * - reportAccuracyScore: neutral 0.5 when the user has filed no reports at all,
 *   otherwise accurate / (accurate + rejected).
 * - abuseScore: Laplace-smoothed ratio of reporting-axis bad signals (rejected
 *   reports + weighted confirmed report abuse) to total reporting events,
 *   clamped to [0, 1].
 */
export function computeReliability(counts: ReliabilityCounts): ReputationReliability {
  const { accurateReports, rejectedReports, reportAbuseCount } = counts;

  const reportTotal = accurateReports + rejectedReports;
  const reportAccuracyScore =
    reportTotal === 0 ? NEUTRAL_REPORT_ACCURACY : accurateReports / reportTotal;

  const abuseNumerator = rejectedReports + ABUSE_PENALTY_WEIGHT * reportAbuseCount;
  const abuseDenominator =
    accurateReports + rejectedReports + reportAbuseCount + ABUSE_SMOOTHING;
  const abuseScore = clamp(abuseNumerator / abuseDenominator, 0, 1);

  return {
    accurateReports,
    rejectedReports,
    reportAccuracyScore,
    abuseScore,
  };
}

/** Everything the legacy trust tier is derived from. */
export interface TrustTierInput {
  /** Legacy lifetime total, unchanged in meaning. Drives the positive ladder. */
  total: number;
  /**
   * Net of every transaction OUTSIDE the conduct axis.
   *
   * The punitive `< 0` clause reads THIS rather than `total`, so a conduct
   * penalty is judged once, on the conduct axis, instead of also forcing
   * `restricted` through a negative total. Without the split, a single low-
   * severity finding — worth `watch` under the conduct policy — restricted a new
   * account outright. For every user with no conduct transactions the two
   * figures are identical, so nothing about existing behaviour moves.
   */
  nonConductTotal: number;
  verified: boolean;
  reliability: ReputationReliability;
  /** Conduct standing. `restricted` here forces the legacy tier to match. */
  conductStanding: ConductStanding;
}

/**
 * Derive the legacy trust tier. Evaluated strictly top-down in priority order:
 *   restricted → verified → high_trust → trusted → new.
 *
 * Retained unchanged in meaning for existing consumers; the conduct axis is
 * layered in rather than replacing it, so a conduct restriction is visible to a
 * caller that only knows about `trustTier`.
 */
export function deriveTrustTier(input: TrustTierInput): TrustTier {
  const { total, nonConductTotal, verified, reliability, conductStanding } = input;
  if (
    conductStanding === 'restricted' ||
    nonConductTotal < 0 ||
    reliability.abuseScore >= ABUSE_RESTRICT_THRESHOLD
  ) {
    return 'restricted';
  }
  if (verified) {
    return 'verified';
  }
  if (total >= TRUST_TIER_HIGH_TRUST_MIN) {
    return 'high_trust';
  }
  if (total >= TRUST_TIER_TRUSTED_MIN) {
    return 'trusted';
  }
  return 'new';
}

/* -------------------------------------------------------------------------- */
/*  The multidimensional axes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Conduct standing from active risk, using the thresholds of a specific policy
 * version so a standing can be recomputed under the policy it was decided
 * under.
 *
 * Thresholds are evaluated highest-first, so a partially-ordered or
 * differently-ordered stored list cannot silently pick the wrong band.
 *
 * @param activeRisk - Sum of risk carried by the subject's ACTIVE strikes.
 * @param thresholds - The policy version's thresholds; the baseline when absent.
 */
export function deriveConductStanding(
  activeRisk: number,
  thresholds: readonly ConductStandingThreshold[] = BASELINE_STANDING_THRESHOLDS
): ConductStanding {
  const ordered = [...thresholds].sort((a, b) => b.minRisk - a.minRisk);
  for (const threshold of ordered) {
    if (activeRisk >= threshold.minRisk) {
      return threshold.standing;
    }
  }
  return 'good';
}

/**
 * Contribution tier from contribution points alone.
 *
 * There is no punitive band here on purpose: contribution measures what was
 * built, and a conduct consequence is expressed as standing. A person may sit at
 * `high_trust` contribution and `limited` conduct at the same time — that pair
 * is the model working, not a contradiction.
 */
export function deriveContributionTier(points: number): ContributionTier {
  if (points >= CONTRIBUTION_TIER_HIGH_TRUST_MIN) {
    return 'high_trust';
  }
  if (points >= CONTRIBUTION_TIER_TRUSTED_MIN) {
    return 'trusted';
  }
  return 'new';
}

/** Raw reporting outcome counts for one user. */
export interface ReportingCounts {
  confirmed: number;
  rejected: number;
  malicious: number;
}

/**
 * Reporting reliability as a Beta posterior mean with a neutral prior, plus a
 * confidence that grows with effective sample size.
 *
 * Two properties this shape buys, both of which a raw ratio lacks: one accurate
 * report does not make a perfect reporter, and a newcomer with no history keeps
 * a neutral prior rather than reading as either flawless or worthless.
 * Confirmed report ABUSE is weighted heavily among the failures — it is a
 * finding of bad faith, not an inaccuracy.
 */
export function computeReporting(counts: ReportingCounts): ReputationReportingSnapshot {
  const { confirmed, rejected, malicious } = counts;

  const successes = confirmed + REPORTING_PRIOR_SUCCESS;
  const failures =
    rejected + REPORTING_MALICIOUS_WEIGHT * malicious + REPORTING_PRIOR_FAILURE;
  const reliability = clamp(successes / (successes + failures), 0, 1);

  const effectiveSampleSize = confirmed + rejected + malicious;
  const confidence = clamp(effectiveSampleSize / REPORTING_TARGET_SAMPLE_SIZE, 0, 1);

  return { reliability, confidence, confirmed, rejected, malicious };
}

/** Everything the contextual weights are derived from. */
export interface ContextualInfluenceInput {
  contributionPoints: number;
  conductStanding: ConductStanding;
  /** Reporting reliability, 0..1. */
  reportingReliability: number;
  /** Confidence in that reliability, 0..1. */
  reportingConfidence: number;
  /** Global reviewer reliability, 0..1. */
  reviewingReliability: number;
}

/**
 * Derive the three contextual weights.
 *
 * Each answers a different question and is scaled by conduct standing, so a
 * person under consequence is drawn less often and their reports prioritised
 * lower — without their contribution history being erased. `restricted` floors
 * every weight.
 *
 * NONE of these is the weight of a vote. A vote inside a jury is never weighted:
 * one qualified person, one vote. Reputation decides who is ASKED, never how
 * much their answer counts.
 */
export function deriveContextualInfluence(
  input: ContextualInfluenceInput
): ReputationContextualInfluenceSnapshot {
  const {
    contributionPoints,
    conductStanding,
    reportingReliability,
    reportingConfidence,
    reviewingReliability,
  } = input;

  const base = baseTrustWeight(contributionPoints);
  const standingFactor = STANDING_WEIGHT_FACTOR[conductStanding];

  // A reliability estimate only moves the weight in proportion to how much
  // evidence stands behind it, so an unproven reporter is neither promoted nor
  // demoted on one data point.
  const reportSignal =
    NEUTRAL_REPORT_ACCURACY +
    (reportingReliability - NEUTRAL_REPORT_ACCURACY) * reportingConfidence;

  const bound = (value: number): number =>
    clamp(value, CONTEXTUAL_WEIGHT_MIN, CONTEXTUAL_WEIGHT_MAX);

  return {
    reportPriorityWeight: bound(
      base * standingFactor * (REPORT_WEIGHT_ACCURACY_OFFSET + reportSignal)
    ),
    reviewSelectionWeight: bound(
      base * standingFactor * (REPORT_WEIGHT_ACCURACY_OFFSET + reviewingReliability)
    ),
    rankingWeight: bound(base * standingFactor * RANKING_FEEDBACK_FACTOR),
  };
}

/**
 * The base trust weight that every influence axis scales from:
 *   clamp(INFLUENCE_BASE_OFFSET + total / INFLUENCE_TOTAL_DIVISOR, MIN, MAX).
 */
export function baseTrustWeight(total: number): number {
  return clamp(
    INFLUENCE_BASE_OFFSET + total / INFLUENCE_TOTAL_DIVISOR,
    INFLUENCE_MIN,
    INFLUENCE_MAX
  );
}

/**
 * Derive all four capped influence weights. Restricted users are floored to
 * INFLUENCE_MIN on every axis regardless of their total.
 */
export function deriveInfluence(
  total: number,
  tier: TrustTier,
  reliability: ReputationReliability
): ReputationInfluence {
  if (tier === 'restricted') {
    return {
      defaultWeight: INFLUENCE_MIN,
      reportWeight: INFLUENCE_MIN,
      moderationWeight: INFLUENCE_MIN,
      rankingFeedbackWeight: INFLUENCE_MIN,
    };
  }

  const base = baseTrustWeight(total);

  const defaultWeight = base;
  const reportWeight = clamp(
    base * (REPORT_WEIGHT_ACCURACY_OFFSET + reliability.reportAccuracyScore),
    INFLUENCE_MIN,
    INFLUENCE_MAX
  );
  const moderationWeight = clamp(
    base * MODERATION_TIER_FACTOR[tier],
    INFLUENCE_MIN,
    INFLUENCE_MAX
  );
  const rankingFeedbackWeight = clamp(
    base * RANKING_FEEDBACK_FACTOR,
    INFLUENCE_MIN,
    INFLUENCE_MAX
  );

  return { defaultWeight, reportWeight, moderationWeight, rankingFeedbackWeight };
}
