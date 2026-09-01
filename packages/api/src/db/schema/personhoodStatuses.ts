/**
 * `personhood_statuses` — the recomputable proof-of-personhood snapshot, one row
 * per account.
 *
 * Ported from `models/PersonhoodStatus.ts`. The web-of-trust analogue of
 * `reputation_balances`: always re-derivable from the account's active vouches,
 * real-life attestations, biometric signal and sybil heuristics via
 * `personhood.service.recomputePersonhood`. `is_real_person` is mirrored onto
 * `users.verified`, which is what promotes the account to the `verified` tier.
 *
 * The `breakdown` subdocument has a closed, six-field shape, so it is columns
 * with a `breakdown_` prefix rather than `jsonb`.
 *
 * ## `sybil_penalty` appears twice, on purpose
 *
 * The top-level column is the penalty applied at the last recompute; the
 * `breakdown_sybil_penalty` is the audit copy inside the score breakdown. Both
 * are on the wire today and both are written by the same recompute, so
 * collapsing them would be a contract change dressed as a schema tidy-up. The
 * CHECK below pins them to the same 0..1 range; making them provably equal is a
 * call for whoever ports `personhoodDerive`.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * The signal sub-scores behind the personhood score (audit / UI breakdown).
 *
 * Declared here beside the `breakdown_*` columns that store it, so the shape
 * `personhoodDerive.personhoodScore` produces and the columns it lands in
 * cannot drift. The six fields map 1:1 onto those columns.
 */
export interface PersonhoodBreakdown {
  /** Saturated [0,1] vouch signal from the weighted vouch sum. */
  vouchSignal: number;
  /** Saturated [0,1] real-life-attestation signal. */
  realLifeSignal: number;
  /** 1 when the account is biometric-bound, else 0. */
  biometricSignal: number;
  /** Weighted blend of the three signals before the sybil penalty. */
  evidence: number;
  /** The [0,1] sybil penalty subtracted (multiplicatively) from the evidence. */
  sybilPenalty: number;
  /** True when the score came from the seed-verifier genesis short-circuit. */
  seed: boolean;
}

export const personhoodStatuses = pgTable(
  'personhood_statuses',
  {
    id: generatedId(),
    /** `CASCADE` — a personhood verdict about an account that no longer exists. */
    userId: text()
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Personhood score in [0, 1]. */
    score: doublePrecision().notNull().default(0),
    /** `score >= θ` — the headline verdict. */
    isRealPerson: boolean().notNull().default(false),
    /** Active vouches in the web-of-trust for this account. */
    vouchCount: integer().notNull().default(0),
    /** Real-life counterparty attestations for this account. */
    realLifeCount: integer().notNull().default(0),
    /** Whether an on-device biometric gate is bound to the account. */
    biometricBound: boolean().notNull().default(false),
    /** The [0, 1] sybil penalty applied at the last recompute. */
    sybilPenalty: doublePrecision().notNull().default(0),

    // ---- breakdown (audit / UI) -------------------------------------------
    /** Saturated [0, 1] vouch signal from the weighted vouch sum. */
    breakdownVouchSignal: doublePrecision().notNull().default(0),
    /** Saturated [0, 1] real-life-attestation signal. */
    breakdownRealLifeSignal: doublePrecision().notNull().default(0),
    /** 1 when the account is biometric-bound, else 0. */
    breakdownBiometricSignal: doublePrecision().notNull().default(0),
    /** Weighted blend of the three signals, BEFORE the sybil penalty. */
    breakdownEvidence: doublePrecision().notNull().default(0),
    /** The penalty subtracted (multiplicatively) from the evidence. */
    breakdownSybilPenalty: doublePrecision().notNull().default(0),
    /** True when the score came from the seed-verifier genesis short-circuit. */
    breakdownSeed: boolean().notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The personhood leaderboard / audit sample reads by score, and the
    // `verified` cohort reads by the verdict.
    index('personhood_statuses_score_idx').on(t.score),
    index('personhood_statuses_is_real_person_idx').on(t.isRealPerson),

    check('personhood_statuses_counts_check', sql`${t.vouchCount} >= 0 and ${t.realLifeCount} >= 0`),
    // Every one of these is a saturated [0, 1] signal by construction in
    // `personhoodDerive.personhoodScore`; a value outside it is not a weaker
    // score, it is a broken derivation.
    check(
      'personhood_statuses_signals_check',
      sql`${t.score} between 0 and 1 and ${t.sybilPenalty} between 0 and 1 and ${t.breakdownVouchSignal} between 0 and 1 and ${t.breakdownRealLifeSignal} between 0 and 1 and ${t.breakdownBiometricSignal} between 0 and 1 and ${t.breakdownEvidence} between 0 and 1 and ${t.breakdownSybilPenalty} between 0 and 1`
    ),
  ]
);
