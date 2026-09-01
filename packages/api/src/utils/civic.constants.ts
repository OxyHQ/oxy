/**
 * Civic / Commons constants (Fase 2 — anti-gaming layer; Fase 3 — personhood).
 *
 * SINGLE SOURCE OF TRUTH for the tunables of the real-life attestation flow,
 * (Fase 2 Part B) the validator jury, and (Fase 3) the proof-of-personhood
 * web-of-trust. Nothing in the civic services may hardcode these — import them
 * here so the anti-sybil knobs stay in one auditable place.
 */

import type { TrustTier } from '@oxyhq/contracts';

/* -------------------------------------------------------------------------- */
/*  Real-life counterparty attestation (Part A)                               */
/* -------------------------------------------------------------------------- */

/**
 * Max age of a real-life attestation QR/nonce. A counterparty's signed
 * submission is rejected once `record.exp` (epoch ms) is in the past; the QR's
 * `exp` should be no further out than this from when it was shown.
 */
export const REAL_LIFE_NONCE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Graph-exclusion hop radius for the real-life flow: the counterparty must not
 * be within this many social-graph hops of the subject (1 = direct neighbour).
 */
export const REAL_LIFE_EXCLUSION_HOPS = 1;

/* -------------------------------------------------------------------------- */
/*  Validator jury (Part B)                                                   */
/* -------------------------------------------------------------------------- */

/** Trust tiers eligible to serve on a validation jury (never `restricted`/`new`). */
export const VALIDATOR_POOL_TIERS = ['trusted', 'high_trust', 'verified'] as const;

/** Number of validators selected per request. */
export const VALIDATOR_COUNT = 5;

/** Minimum votes before a request can be tallied (normal value). */
export const VALIDATOR_QUORUM = 3;

/** Votes required on the winning side for a HIGH-VALUE request (supermajority). */
export const VALIDATOR_SUPERMAJORITY = 4;

/** A juror must not be within this many social-graph hops of the subject. */
export const VALIDATION_EXCLUSION_HOPS = 2;

/** How long a validation request stays open for votes before it expires. */
export const VALIDATION_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Max prior co-votes a candidate juror may share with an already-selected juror
 * before being skipped (collusion-cluster throttle).
 */
export const AFFINITY_MAX_COVOTES = 3;

/**
 * Cap on the candidate pool scanned per selection — bounds the work and the
 * `candidateSnapshot` size while staying far larger than `VALIDATOR_COUNT`.
 */
export const VALIDATOR_POOL_CAP = 500;

/** How often the background sweep re-tallies / expires stale validation requests. */
export const VALIDATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/* -------------------------------------------------------------------------- */
/*  Proof-of-personhood web-of-trust (Fase 3)                                 */
/* -------------------------------------------------------------------------- */
//
// Personhood = "is this a real, unique human", derived from a web-of-trust of
// SIGNED, staked vouches + real-life attestations + an on-device biometric
// signal, MINUS sybil penalties. It is NEVER a single third-party KYC, and a
// user NEVER self-awards: a voucher signs a `personhood_vouch` record and the
// `personhood.service` decides the outcome. The derived score is computed by the
// pure `personhoodDerive.personhoodScore` from these tunables.

/**
 * θ (theta) — the personhood SCORE threshold (0..1) at or above which a user is
 * considered a real person (`isRealPerson`). Reaching it deliberately requires
 * MORE than one signal class (e.g. vouches alone fall short of θ): see
 * `personhoodDerive` for the worked combinations.
 */
export const PERSONHOOD_THRESHOLD = 0.6;

/**
 * τ (tau) — the minimum personhood score a VOUCHER must themselves have before
 * their vouch counts. A real person can only be vouched for by other (already)
 * real people — the genesis of the network is the hand-picked seed verifiers
 * (`User.isSeedVerifier`), who are treated as score = 1.
 */
export const MIN_VOUCHER_PERSONHOOD = 0.6;

/** Graph-exclusion hop radius for a vouch: the voucher must not be within this
 * many social-graph hops of the subject (1 = direct neighbour) — a sock-puppet
 * cannot vouch for the account it controls. */
export const PERSONHOOD_VOUCH_EXCLUSION_HOPS = 1;

/** Default stake (in reputation points of skin-in-the-game) recorded for a vouch
 * when the signed record does not specify one. */
export const PERSONHOOD_VOUCH_DEFAULT_STAKE = 10;

/** Inclusive bounds for a caller-supplied vouch stake. */
export const PERSONHOOD_VOUCH_MIN_STAKE = 1;
export const PERSONHOOD_VOUCH_MAX_STAKE = 100;

/**
 * Per-trust-tier weight a single vouch contributes to the subject's weighted
 * vouch sum. A higher-tier voucher's word is worth more; `restricted` is worth
 * nothing (and is below τ anyway). These are summed across the subject's active
 * vouches to form `weightedVouchScore`, the vouch axis of the personhood score.
 */
export const VOUCH_TIER_WEIGHT: Readonly<Record<TrustTier, number>> = {
  restricted: 0,
  new: 0.25,
  trusted: 0.45,
  high_trust: 0.7,
  verified: 1.0,
} as const;

/** The weight a voucher contributes for a given trust tier (0 when unmapped). */
export function vouchWeightForTier(tier: TrustTier | string | undefined): number {
  if (tier && tier in VOUCH_TIER_WEIGHT) {
    return VOUCH_TIER_WEIGHT[tier as TrustTier];
  }
  return 0;
}

/** The weighted-vouch sum that alone saturates the vouch signal to 1.0 (≈ three
 * `verified` vouchers, or more lower-tier ones). */
export const PERSONHOOD_VOUCH_TARGET = 3.0;

/** The count of real-life attestations that alone saturates the real-life
 * signal to 1.0. */
export const PERSONHOOD_REAL_LIFE_TARGET = 2;

// Component weights of the personhood evidence score. They sum to 1.0 so a user
// with EVERY signal maxed reaches exactly 1.0 before the sybil penalty. No
// single component reaches θ on its own — personhood requires a blend.
/** Weight of the staked web-of-trust vouch signal. */
export const PERSONHOOD_VOUCH_COMPONENT = 0.5;
/** Weight of the real-life counterparty-attestation signal. */
export const PERSONHOOD_REAL_LIFE_COMPONENT = 0.35;
/** Weight of the on-device biometric-bound signal. */
export const PERSONHOOD_BIOMETRIC_COMPONENT = 0.15;

/* -------------------------------------------------------------------------- */
/*  Sybil heuristics (Fase 3)                                                 */
/* -------------------------------------------------------------------------- */

/** Hard ceiling on the computed sybil penalty (1.0 = the score is fully zeroed). */
export const SYBIL_PENALTY_CAP = 1.0;

/** Weight of the shared-device/IP cluster signal in the sybil penalty: the
 * fraction of a subject's vouchers that share a device fingerprint or IP with
 * the subject or with one another. */
export const SYBIL_SHARED_FINGERPRINT_WEIGHT = 0.6;

/** Weight of the vouch-ring density signal in the sybil penalty: reciprocal
 * (A↔B) and short-cycle (A→B→C→A) vouch edges around the subject. */
export const SYBIL_VOUCH_RING_WEIGHT = 0.6;

/** Cap on the number of a subject's active vouchers scanned by the sybil
 * heuristics — bounds the pairwise/neighbourhood work. */
export const SYBIL_VOUCHER_SCAN_CAP = 50;

/* -------------------------------------------------------------------------- */
/*  Random personhood audits (Fase 3)                                         */
/* -------------------------------------------------------------------------- */

/**
 * The `ValidationRequest.actionType` used for a random personhood audit. It
 * REUSES the Fase 2 jury (`selectValidators`/`tallyAndResolve`); a juror votes
 * `valid` (= confirmed real person) or `invalid` (= fake). It is NOT a
 * reputation rule — nothing is ever awarded under this action key directly.
 */
export const PERSONHOOD_AUDIT_ACTION = 'personhood_audit';

/** Fraction of `isRealPerson` users sampled for audit on each sweep. */
export const PERSONHOOD_AUDIT_SAMPLE_RATE = 0.05;

/** Max number of audits opened per sweep (bounds jury-selection work). */
export const PERSONHOOD_AUDIT_BATCH = 25;

/** How often the background sweep opens new random personhood audits. */
export const PERSONHOOD_AUDIT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/* -------------------------------------------------------------------------- */
/*  Verifiable Credentials (Fase 4)                                           */
/* -------------------------------------------------------------------------- */

/**
 * AtProto-style collection (NSID) for verifiable credentials. The signed
 * `credential` record carries this as its `collection`; the per-credential
 * `rkey` (chosen by the issuer client) MUST be unique per credential so multiple
 * credentials from the same issuer do not collide on the chain's monotonic /
 * last-writer-wins key.
 */
export const CREDENTIAL_COLLECTION = 'app.oxy.credential';

/**
 * The W3C base VC type that MUST be present in every credential's `types` array.
 * At least one specific type (e.g. `EmploymentCredential`) is required alongside.
 */
export const CREDENTIAL_BASE_TYPE = 'VerifiableCredential';
