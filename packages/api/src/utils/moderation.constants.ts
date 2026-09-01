/**
 * Oxy Conduct Policy — the tunables of the moderation reputation bridge.
 *
 * The split between this file and the `ModerationPolicy` COLLECTION is
 * deliberate and is the whole substance of "rules must be versioned":
 *
 *  - Every value that decides a consequence — points, active risk, expiry,
 *    repetition multipliers, the multi-finding cap, the standing thresholds —
 *    lives in a `ModerationPolicy` DOCUMENT keyed by `policyVersion`, because
 *    an effect must be recomputable under the policy it was decided under. A
 *    constant in a source file cannot do that: deploying a new tuning would
 *    silently rewrite the past.
 *  - What lives HERE is only the identity of the policy — the action keys, the
 *    baseline version's contents used to SEED the first document, and the
 *    ledger-side vocabulary. Nothing here is read while deriving an effect.
 *
 * The one exception worth naming: {@link CONDUCT_ACTION_TYPES} is read while
 * recomputing a balance, to tell a conduct penalty apart from every other
 * negative transaction. That is a classification, not a tunable — it decides
 * which AXIS a ledger row belongs to, not how much it costs.
 */

import type {
    ConductStanding,
    ModerationSeverity,
    ReputationCategory,
} from '@oxyhq/contracts';
import type { ConductStandingThreshold } from '../db/schema/moderationPolicyStandingThresholds';

// =============================================================================
// LEDGER ACTION KEYS
// =============================================================================

/**
 * Ledger `actionType` for a conduct penalty, one per severity band.
 *
 * These are the keys a conduct transaction is stamped with. They are NOT backed
 * by a `ReputationRule`: the versioned `ModerationPolicy` supplies the points,
 * so a rule row would be a second, drifting authority for the same number.
 */
export const MODERATION_VIOLATION_ACTIONS: Readonly<Record<ModerationSeverity, string>> = {
    low: 'moderation_violation_low',
    medium: 'moderation_violation_medium',
    high: 'moderation_violation_high',
    critical: 'moderation_violation_critical',
} as const;

/** Ledger `actionType` for confirmed report abuse — the reporting axis. */
export const REPORT_ABUSE_CONFIRMED_ACTION = 'report_abuse_confirmed';

/** Ledger `actionType` for confirmed reviewer abuse (collusion, leaks, random voting). */
export const REVIEW_ABUSE_CONFIRMED_ACTION = 'review_abuse_confirmed';

/**
 * Every action key that belongs to the CONDUCT axis.
 *
 * A transaction stamped with one of these is a conduct consequence: it raises
 * `conduct.activeRisk` through its strike and it must NOT be counted as
 * contribution, nor folded into the reporting-abuse signal. That separation is
 * the point — before it, one `vouch_slashed` pushed a report-abuse score a third
 * of the way to a forced restriction, and a conduct penalty would have done the
 * same through a path that has nothing to do with reports.
 */
export const CONDUCT_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
    ...Object.values(MODERATION_VIOLATION_ACTIONS),
    REPORT_ABUSE_CONFIRMED_ACTION,
    REVIEW_ABUSE_CONFIRMED_ACTION,
]);

/**
 * The action keys that count toward the REPORTING-abuse signal.
 *
 * Only confirmed report abuse. A conduct violation is not report abuse, and a
 * rejected report is not bad faith.
 */
export const REPORT_ABUSE_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
    REPORT_ABUSE_CONFIRMED_ACTION,
]);

/** Ledger category every moderation consequence is filed under. */
export const MODERATION_LEDGER_CATEGORY: ReputationCategory = 'penalty';

/**
 * `sourceActionType` stamped on a conduct transaction, so the ledger row is
 * self-describing without carrying the taxonomy code.
 */
export const MODERATION_CONDUCT_SOURCE_ACTION_TYPE = 'moderation_conduct_effect';

// =============================================================================
// POLICY IDENTITY
// =============================================================================

/**
 * The Oxy Conduct Policy version this build seeds.
 *
 * An event naming a version with no stored policy is REJECTED rather than
 * silently falling back to this one — falling back would apply today's tuning
 * to a decision made under another.
 */
export const BASELINE_OXY_CONDUCT_POLICY_VERSION = 'oxy.2026.1';

/**
 * Conduct families the baseline policy recognises. §11.7 requires that the
 * finding's category be contemplated by the policy version; an unrecognised
 * family produces no effect rather than a guessed one.
 */
export const BASELINE_CONDUCT_FAMILIES: readonly string[] = [
    'harassment',
    'hate',
    'sexual_content',
    'child_safety',
    'violence',
    'self_harm',
    'spam',
    'fraud',
    'impersonation',
    'privacy',
    'platform_manipulation',
    'report_abuse',
    'review_abuse',
] as const;

/**
 * The baseline points / active risk / expiry per severity band.
 *
 * Seeded into the `ModerationPolicy` document for
 * {@link BASELINE_OXY_CONDUCT_POLICY_VERSION} and never read afterwards — the
 * engine resolves the stored document. `riskExpiryDays: null` means the risk
 * does not lapse on its own and requires a specialised recovery review.
 */
export const BASELINE_SEVERITY_RULES: readonly {
    severity: ModerationSeverity;
    points: number;
    riskPoints: number;
    riskExpiryDays: number | null;
}[] = [
    { severity: 'low', points: -2, riskPoints: 1, riskExpiryDays: 30 },
    { severity: 'medium', points: -8, riskPoints: 3, riskExpiryDays: 90 },
    { severity: 'high', points: -20, riskPoints: 8, riskExpiryDays: 180 },
    { severity: 'critical', points: -50, riskPoints: 20, riskExpiryDays: null },
] as const;

/**
 * Repetition multipliers by ordinal of a SIMILAR incident inside the window.
 * Index 0 is the first incident. Beyond the last entry the last value holds, so
 * the escalation is bounded rather than unbounded.
 */
export const BASELINE_REPETITION_MULTIPLIERS: readonly number[] = [1.0, 1.5, 2.0, 2.5] as const;

/**
 * How far back a similar incident counts as repetition. Similarity is by
 * conduct FAMILY, not by taxonomy code, so relabelling the same behaviour does
 * not reset the counter.
 */
export const BASELINE_REPETITION_WINDOW_DAYS = 365;

/** Each secondary finding adds at most this share of the primary effect. */
export const BASELINE_MULTI_FINDING_SECONDARY_SHARE = 0.25;

/** Total multi-finding multiplier ceiling relative to the primary effect. */
export const BASELINE_MULTI_FINDING_CAP = 1.5;

/**
 * Active-risk thresholds for conduct standing, evaluated highest-first.
 *
 * Calibrated against the severity table above so the base consequence of a
 * single incident matches its band: medium (risk 3) → `watch`, high (8) →
 * `limited`, critical (20) → `restricted`. A single low incident (1) lands on
 * `watch`, not on a restriction.
 */
export const BASELINE_STANDING_THRESHOLDS: readonly ConductStandingThreshold[] =
    [
        { standing: 'restricted', minRisk: 20 },
        { standing: 'limited', minRisk: 8 },
        { standing: 'watch', minRisk: 1 },
        { standing: 'good', minRisk: 0 },
    ] as const;

// =============================================================================
// CONTRIBUTION AXIS
// =============================================================================

/** Minimum contribution points for the `trusted` contribution tier. */
export const CONTRIBUTION_TIER_TRUSTED_MIN = 100;

/** Minimum contribution points for the `high_trust` contribution tier. */
export const CONTRIBUTION_TIER_HIGH_TRUST_MIN = 500;

// =============================================================================
// REPORTING AXIS (Beta posterior with a neutral prior)
// =============================================================================

/**
 * Neutral prior for the reporting posterior: `Beta(1, 1)` — an unproven
 * reporter sits at 0.5 with near-zero confidence, so one accurate report
 * neither certifies nor condemns them.
 */
export const REPORTING_PRIOR_SUCCESS = 1;
export const REPORTING_PRIOR_FAILURE = 1;

/** Sample size at which reporting confidence reaches 1. */
export const REPORTING_TARGET_SAMPLE_SIZE = 20;

/** Weight of a confirmed report-abuse finding in the reporting posterior's failures. */
export const REPORTING_MALICIOUS_WEIGHT = 5;

// =============================================================================
// REVIEWING AXIS
// =============================================================================

/** Neutral prior for reviewer reliability, same shape as the reporting prior. */
export const REVIEWING_PRIOR_SUCCESS = 1;
export const REVIEWING_PRIOR_FAILURE = 1;

/**
 * Reliability a reviewer with NO review history reads as — the prior's mean.
 *
 * A person who has never reviewed is unproven, not unreliable, so the neutral
 * value must be the prior itself rather than zero.
 */
export const NEUTRAL_REVIEWER_RELIABILITY =
    REVIEWING_PRIOR_SUCCESS / (REVIEWING_PRIOR_SUCCESS + REVIEWING_PRIOR_FAILURE);

// =============================================================================
// CONTEXTUAL INFLUENCE
// =============================================================================

/**
 * Bounds on every contextual weight. A weight is a probability multiplier for
 * selection or priority — never the weight of a vote inside a jury, which does
 * not exist: one qualified person, one vote.
 */
export const CONTEXTUAL_WEIGHT_MIN = 0.1;
export const CONTEXTUAL_WEIGHT_MAX = 3.0;

/** Per-standing multiplier applied to every contextual weight. */
export const STANDING_WEIGHT_FACTOR: Readonly<Record<ConductStanding, number>> = {
    good: 1.0,
    watch: 0.75,
    limited: 0.25,
    restricted: 0,
} as const;

// =============================================================================
// EXPIRY SWEEP
// =============================================================================

/** How often the conduct-risk expiry sweep runs (hourly). */
export const CONDUCT_EXPIRY_INTERVAL_MS = 60 * 60 * 1000;

/** Maximum strikes expired in one sweep pass, so a backlog cannot stall a tick. */
export const CONDUCT_EXPIRY_BATCH_SIZE = 500;
