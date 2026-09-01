/**
 * Reputation system tunables (product name: "Oxy Trust").
 *
 * This file is the SINGLE SOURCE OF TRUTH for every TUNABLE in the reputation
 * ledger (#217) and the derived trust-tier / capped-influence model (#219) —
 * the tier thresholds, the influence clamps and factors, the reliability
 * smoothing, and the per-action point values. Nothing in the reputation
 * service, routes, or migration may hardcode any of these values; import them
 * from here so the documented, user-approved defaults stay in one auditable
 * place.
 *
 * The CLOSED VALUE SETS this system is built on — `REPUTATION_CATEGORIES`,
 * `TRUST_TIERS`, `REPUTATION_TRANSACTION_STATUSES`,
 * `REPUTATION_TARGET_ENTITY_TYPES`, `REPUTATION_DISPUTE_STATUSES` and their
 * derived unions — deliberately do NOT live here: they are part of the wire
 * contract and are owned by `@oxyhq/contracts`, so the mongoose enums below,
 * the route request schemas, and the SDK's unions are all the same tuple.
 * Import them from `@oxyhq/contracts`.
 *
 * All exports are frozen (`as const`) so the values cannot drift at runtime.
 */
import type { TrustTier } from '@oxyhq/contracts';

// =============================================================================
// TRUST-TIER THRESHOLDS (#219)
// =============================================================================
//
// Tiers are evaluated TOP-DOWN in priority order:
//   1. restricted — total < 0 OR reliability.abuseScore >= ABUSE_RESTRICT_THRESHOLD
//   2. verified   — the User document has `verified === true`
//   3. high_trust — total >= TRUST_TIER_HIGH_TRUST_MIN
//   4. trusted    — total >= TRUST_TIER_TRUSTED_MIN
//   5. new        — everything else (the default tier)

/** Minimum lifetime total to reach the `high_trust` tier. */
export const TRUST_TIER_HIGH_TRUST_MIN = 500;

/** Minimum lifetime total to reach the `trusted` tier. */
export const TRUST_TIER_TRUSTED_MIN = 100;

/**
 * Abuse-score (0..1) at or above which a user is forced into the `restricted`
 * tier regardless of their total.
 */
export const ABUSE_RESTRICT_THRESHOLD = 0.5;

// =============================================================================
// INFLUENCE WEIGHTS (#219)
// =============================================================================
//
// Every influence weight is CLAMPED to [INFLUENCE_MIN, INFLUENCE_MAX] so no
// single user — however high their total — can dominate ranking / moderation /
// reporting. Restricted users are floored to INFLUENCE_MIN across the board.

/** Hard lower bound on any influence weight. */
export const INFLUENCE_MIN = 0.1;

/** Hard upper bound on any influence weight (the cap). */
export const INFLUENCE_MAX = 3.0;

/**
 * Divisor mapping lifetime `total` onto the base trust weight:
 *   baseTrustWeight = clamp(0.1 + total / INFLUENCE_TOTAL_DIVISOR, MIN, MAX)
 * At total=0 → 0.1; at total=500 → ~1.1; saturates at the cap well before
 * pathological totals.
 */
export const INFLUENCE_TOTAL_DIVISOR = 500;

/** Constant offset added to `total / INFLUENCE_TOTAL_DIVISOR` for the base weight. */
export const INFLUENCE_BASE_OFFSET = 0.1;

/**
 * Report-weight scaling: `reportWeight = clamp(base * (0.5 + accuracy), MIN, MAX)`.
 * A neutral accuracy of 0.5 yields a factor of 1.0 (no change); perfectly
 * accurate reporters (accuracy=1.0) get a 1.5× boost, chronically inaccurate
 * ones (accuracy=0) are halved.
 */
export const REPORT_WEIGHT_ACCURACY_OFFSET = 0.5;

/**
 * Ranking-feedback weight is deliberately damped relative to the base trust
 * weight so per-user ranking nudges stay conservative:
 *   rankingFeedbackWeight = clamp(base * RANKING_FEEDBACK_FACTOR, MIN, MAX)
 */
export const RANKING_FEEDBACK_FACTOR = 0.8;

/**
 * Per-tier multiplier applied to the base trust weight to derive the
 * moderation weight: `moderationWeight = clamp(base * factor[tier], MIN, MAX)`.
 * `restricted` is 0 (then clamped up to INFLUENCE_MIN), escalating to 1.5 for
 * verified users.
 */
export const MODERATION_TIER_FACTOR: Readonly<Record<TrustTier, number>> = {
  restricted: 0,
  new: 0.5,
  trusted: 1.0,
  high_trust: 1.25,
  verified: 1.5,
} as const;

// =============================================================================
// RELIABILITY (#219)
// =============================================================================
//
// Reliability is computed from the user's moderation track record encoded in
// their active transactions:
//   - accurateReports = count of active txns with sourceActionType === REPORT_CONFIRMED_ACTION
//   - rejectedReports = count of active txns with sourceActionType === REPORT_REJECTED_ACTION
//   - penaltyCount    = count of active txns with category 'penalty' OR points < 0
//
//   reportAccuracyScore =
//     (accurate === 0 && rejected === 0) ? NEUTRAL_REPORT_ACCURACY
//                                        : accurate / (accurate + rejected)
//
//   abuseScore = clamp(
//     (rejected + ABUSE_PENALTY_WEIGHT * penaltyCount) /
//       (accurate + rejected + penaltyCount + ABUSE_SMOOTHING),
//     0, 1)

/**
 * Canonical source action key for a confirmed (accurate) report. The
 * originating system stamps this on the awarding transaction's
 * `sourceActionType` so reliability can be recomputed purely from the ledger.
 */
export const REPORT_CONFIRMED_ACTION = 'report_confirmed';

/** Canonical source action key for a rejected (inaccurate) report. */
export const REPORT_REJECTED_ACTION = 'report_rejected';

/**
 * Report-accuracy score assigned to a user with no report history at all
 * (neither accurate nor rejected) — a neutral 0.5 so newcomers are neither
 * boosted nor penalised on the report-weight axis.
 */
export const NEUTRAL_REPORT_ACCURACY = 0.5;

/** Laplace-style smoothing added to the abuse-score denominator. */
export const ABUSE_SMOOTHING = 5;

/** Weight applied to each penalty in the abuse-score numerator. */
export const ABUSE_PENALTY_WEIGHT = 2;

// =============================================================================
// CROSS-APP SIGNAL RULES
// =============================================================================

/**
 * Canonical action key awarded to the MEMBER of an endorsement edge when a
 * consuming app reports that an owner endorsed them (`POST /app-signals/ingest`,
 * op `add`). The giver is NOT awarded — only the endorsed member gains
 * reputation. Idempotent on (applicationId, sourceActionId = edge id).
 */
export const ENDORSEMENT_RECEIVED_ACTION = 'endorsement_received';

/** Points awarded to the member of an endorsement edge (social category). */
export const ENDORSEMENT_RECEIVED_POINTS = 2;

// =============================================================================
// CIVIC / COMMONS ACTION RULES (Fase 1)
// =============================================================================
//
// Crypto-owned reputation: each civic award additionally emits an Oxy-signed
// `reputation_attestation` record (see `services/civic/attestation.service.ts`).
// Weighting (the anti-"bring my friends" model): a real-life attestation that a
// counterparty physically signed is HIGH; a random-jury peer validation is
// MEDIUM; app-given signals stay LOW.

/** A real-world interaction the counterparty cryptographically attested (HIGH). */
export const REAL_LIFE_ATTESTED_ACTION = 'real_life_attested';
export const REAL_LIFE_ATTESTED_POINTS = 25;

/** Validated by a randomly-selected jury of peers (MEDIUM). */
export const PEER_VALIDATED_ACTION = 'peer_validated';
export const PEER_VALIDATED_POINTS = 8;

/** Reward to a juror who voted with the resolving majority. */
export const VALIDATION_CORRECT_ACTION = 'validation_correct';
export const VALIDATION_CORRECT_POINTS = 3;

/** Slash to a juror who endorsed a verdict later reverted as fraud. */
export const VALIDATION_INCORRECT_ACTION = 'validation_incorrect';
export const VALIDATION_INCORRECT_POINTS = -10;

/** A signed personhood vouch from a staking voucher (web-of-trust). */
export const PERSONHOOD_VOUCHED_ACTION = 'personhood_vouched';
export const PERSONHOOD_VOUCHED_POINTS = 5;

/** Slash to a voucher whose vouchee was found fake (staking penalty). */
export const VOUCH_SLASHED_ACTION = 'vouch_slashed';
export const VOUCH_SLASHED_POINTS = -20;

/**
 * Provenance weight class shown on the crypto-owned reputation breakdown (UI).
 * - HIGH   — real-life, counterparty-signed (the strongest signal).
 * - MEDIUM — peer/jury validation.
 * - LOW    — app-given signals (endorsements, etc.).
 */
export const WEIGHT_CLASSES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type WeightClass = (typeof WEIGHT_CLASSES)[number];

/**
 * Map an `actionType` to its provenance weight class. Unknown actions default to
 * `LOW` (app-given). Used by the attestation record + later by the Commons UI.
 */
export const ACTION_WEIGHT_CLASS: Readonly<Record<string, WeightClass>> = {
  [REAL_LIFE_ATTESTED_ACTION]: 'HIGH',
  [PEER_VALIDATED_ACTION]: 'MEDIUM',
} as const;

/** The provenance weight class for an action type (`LOW` when unmapped). */
export function weightClassForAction(actionType: string): WeightClass {
  return ACTION_WEIGHT_CLASS[actionType] ?? 'LOW';
}

// =============================================================================
// HOMIIO RE LIFECYCLE (awarded by Homiio `reputation:write` service credential)
// =============================================================================

/** A lease was fully signed by landlord and tenant. */
export const LEASE_SIGNED_ACTION = 'lease_signed';
export const LEASE_SIGNED_POINTS = 10;

/** A lease ran to completion without early termination. */
export const LEASE_COMPLETED_ACTION = 'lease_completed';
export const LEASE_COMPLETED_POINTS = 15;

/** Tenant completed move-out with no damage or outstanding obligations. */
export const CLEAN_MOVEOUT_ACTION = 'clean_moveout';
export const CLEAN_MOVEOUT_POINTS = 8;

/** Lease ended in default (unpaid rent, abandonment, breach). */
export const LEASE_DEFAULT_ACTION = 'lease_default';
export const LEASE_DEFAULT_POINTS = -12;

// =============================================================================
// PAGINATION
// =============================================================================

/** Default page size for a user's transaction ledger. */
export const DEFAULT_TRANSACTION_LIMIT = 50;

/** Maximum page size for a user's transaction ledger. */
export const MAX_TRANSACTION_LIMIT = 100;

/** Default page size for the leaderboard. */
export const DEFAULT_LEADERBOARD_LIMIT = 10;

/** Maximum page size for the leaderboard. */
export const MAX_LEADERBOARD_LIMIT = 100;

/** Default page size for dispute lists. */
export const DEFAULT_DISPUTE_LIMIT = 50;

/** Maximum page size for dispute lists. */
export const MAX_DISPUTE_LIMIT = 100;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Clamp a numeric value into the inclusive range [min, max].
 * Returns `min` when `value` is NaN so a degenerate input can never escape the
 * documented bounds.
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}
