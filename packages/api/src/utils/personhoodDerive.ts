/**
 * Pure derivation of the proof-of-personhood score (Fase 3).
 *
 * DB-free and side-effect-free — `personhood.service.recomputePersonhood`
 * aggregates the raw inputs (the weighted vouch sum, real-life count, biometric
 * flag, sybil penalty) and feeds them here; the returned snapshot is persisted
 * on `PersonhoodStatus`. Mirrors the structure of `reputationDerive.ts`.
 *
 * ## Formula
 *
 * Personhood is the answer to "is this a real, unique human", and it is NEVER a
 * single third-party signal — it is a multiplicative blend of independent
 * evidence axes, minus sybil risk:
 *
 *   1. SEED short-circuit — a hand-picked seed verifier (`User.isSeedVerifier`)
 *      is the genesis of the trust network and is assigned `score = 1`,
 *      `isRealPerson = true` outright.
 *
 *   2. Otherwise the three evidence signals are each saturated into [0,1]:
 *        vouchSignal     = clamp(weightedVouchScore / PERSONHOOD_VOUCH_TARGET, 0, 1)
 *        realLifeSignal  = clamp(realLifeCount     / PERSONHOOD_REAL_LIFE_TARGET, 0, 1)
 *        biometricSignal = biometricBound ? 1 : 0
 *
 *      `weightedVouchScore` is the sum of each active voucher's tier weight
 *      (`VOUCH_TIER_WEIGHT`), so a `verified` voucher is worth more than a
 *      `trusted` one; ~3 verified vouches saturate the axis.
 *
 *   3. They combine with component weights that SUM TO 1 (so a fully-evidenced
 *      user reaches exactly 1.0 before the penalty), and NO single component can
 *      reach θ alone — personhood requires a blend:
 *        evidence = 0.50·vouchSignal + 0.35·realLifeSignal + 0.15·biometricSignal
 *
 *   4. The sybil penalty (shared-device clusters + vouch-ring density, [0,1])
 *      attenuates the evidence MULTIPLICATIVELY — a fully-sybil cluster zeroes
 *      the score regardless of how many vouches it manufactured:
 *        score = clamp(evidence · (1 − clamp(sybilPenalty, 0, 1)), 0, 1)
 *
 *   5. isRealPerson = score >= PERSONHOOD_THRESHOLD (θ).
 *
 * Worked points (θ = 0.6): full vouch (0.5) alone < θ; full vouch + biometric
 * (0.65) ≥ θ; full vouch + full real-life (0.85) ≥ θ; full real-life + biometric
 * (0.5) < θ. Reaching personhood therefore needs at least two independent signal
 * classes — exactly the anti-single-point-of-trust property.
 *
 * Every constant lives in `civic.constants.ts` — nothing here is hardcoded.
 */

import { clamp } from './reputation.constants';
import {
  PERSONHOOD_THRESHOLD,
  PERSONHOOD_VOUCH_TARGET,
  PERSONHOOD_REAL_LIFE_TARGET,
  PERSONHOOD_VOUCH_COMPONENT,
  PERSONHOOD_REAL_LIFE_COMPONENT,
  PERSONHOOD_BIOMETRIC_COMPONENT,
} from './civic.constants';
import type { PersonhoodBreakdown } from '../db/schema/personhoodStatuses';

/** Raw, aggregated personhood inputs for a single user. */
export interface PersonhoodInputs {
  /** Sum of active vouchers' tier weights (`VOUCH_TIER_WEIGHT`). */
  weightedVouchScore: number;
  /** Count of the user's real-life counterparty attestations. */
  realLifeCount: number;
  /** Whether an on-device biometric gate is bound to the account. */
  biometricBound: boolean;
  /** The [0,1] sybil penalty (heuristic clustering + ring density). */
  sybilPenalty: number;
  /** Hand-picked genesis verifier — short-circuits to score 1. */
  isSeedVerifier: boolean;
}

export interface PersonhoodScore {
  score: number;
  isRealPerson: boolean;
  breakdown: PersonhoodBreakdown;
}

/**
 * Derive the personhood score, verdict, and signal breakdown from the raw
 * inputs. Pure: identical inputs always yield an identical snapshot.
 */
export function personhoodScore(inputs: PersonhoodInputs): PersonhoodScore {
  if (inputs.isSeedVerifier) {
    return {
      score: 1,
      isRealPerson: true,
      breakdown: {
        vouchSignal: 1,
        realLifeSignal: 1,
        biometricSignal: 1,
        evidence: 1,
        sybilPenalty: 0,
        seed: true,
      },
    };
  }

  const vouchSignal = clamp(inputs.weightedVouchScore / PERSONHOOD_VOUCH_TARGET, 0, 1);
  const realLifeSignal = clamp(inputs.realLifeCount / PERSONHOOD_REAL_LIFE_TARGET, 0, 1);
  const biometricSignal = inputs.biometricBound ? 1 : 0;

  const evidence =
    PERSONHOOD_VOUCH_COMPONENT * vouchSignal +
    PERSONHOOD_REAL_LIFE_COMPONENT * realLifeSignal +
    PERSONHOOD_BIOMETRIC_COMPONENT * biometricSignal;

  const sybilPenalty = clamp(inputs.sybilPenalty, 0, 1);
  const score = clamp(evidence * (1 - sybilPenalty), 0, 1);

  return {
    score,
    isRealPerson: score >= PERSONHOOD_THRESHOLD,
    breakdown: { vouchSignal, realLifeSignal, biometricSignal, evidence, sybilPenalty, seed: false },
  };
}
