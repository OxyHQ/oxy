/**
 * Personhood Service (civic / Commons — Fase 3 proof-of-personhood web-of-trust).
 *
 * Personhood answers "is this a real, unique human?" — NEVER from a single
 * third-party KYC, but from a web-of-trust of SIGNED, staked vouches + real-life
 * attestations + an on-device biometric signal, MINUS sybil penalties. A user
 * NEVER self-awards: a voucher signs a self-issued `personhood_vouch` record and
 * THIS service decides eligibility, records the stake, calls
 * `reputationService.award` in-process for the subject, and recomputes the
 * subject's personhood. Mirrors the trust model of `realLife.service`.
 *
 * Anti-gaming layers, all reusing the Fase 2 substrate:
 *  - the voucher must themselves be a real person (personhood ≥ τ) — the network
 *    is bootstrapped by hand-picked `User.isSeedVerifier` genesis nodes;
 *  - the voucher must NOT be a graph-neighbour / shared-device sock-puppet of the
 *    subject (`isSockPuppetRelation`);
 *  - the vouch is STAKED — if the subject is later proven fake (a failed random
 *    audit or a reversed personhood award) every active voucher is SLASHED
 *    (`slashVouchersForFakeSubject`);
 *  - the derived score subtracts a heuristic `sybilPenalty`.
 */

import { z } from 'zod';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { verifyEnvelopeSignature, type RejectionReason } from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { getDb } from '../../config/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { personhoodStatuses } from '../../db/schema/personhoodStatuses';
import { personhoodVouches } from '../../db/schema/personhoodVouches';
import { reputationBalances } from '../../db/schema/reputationBalances';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { users } from '../../db/schema/users';
import { isSelfIssuedByUser, parseUserDid } from '../did.service';
import { verifyAndStoreRecord } from '../signedRecord.service';
import { isSockPuppetRelation } from './graphExclusion';
import { computeSybilPenalty } from './sybil.service';
import { reputationService } from '../reputation.service';
import { personhoodScore, type PersonhoodInputs } from '../../utils/personhoodDerive';
import {
  PERSONHOOD_VOUCHED_ACTION,
  REAL_LIFE_ATTESTED_ACTION,
  VOUCH_SLASHED_ACTION,
  clamp,
} from '../../utils/reputation.constants';
import {
  MIN_VOUCHER_PERSONHOOD,
  PERSONHOOD_VOUCH_EXCLUSION_HOPS,
  PERSONHOOD_VOUCH_DEFAULT_STAKE,
  PERSONHOOD_VOUCH_MIN_STAKE,
  PERSONHOOD_VOUCH_MAX_STAKE,
  vouchWeightForTier,
} from '../../utils/civic.constants';
import userCache from '../../utils/userCache';
import { logger } from '../../utils/logger';

/**
 * The `record` payload of a `personhood_vouch` signed envelope (API-internal —
 * the wire envelope is validated against `@oxyhq/contracts`; only this inner
 * payload shape is API-private). `about` is the subject's DID; `stake` is an
 * optional caller-chosen stake (clamped server-side); `context` is an opaque
 * note from the vouching UI.
 */
const personhoodVouchRecordSchema = z.object({
  about: z.string(),
  context: z.string().optional(),
  stake: z.number().optional(),
});

/** Why a vouch can be rejected (stable, machine-readable). */
export type VouchRejectionReason =
  | 'invalid_type'
  | 'not_self_issued'
  | 'invalid_record'
  | 'invalid_subject'
  | 'self_vouch'
  | 'subject_not_found'
  | 'voucher_below_threshold'
  | 'already_vouched'
  | 'excluded_self'
  | 'excluded_graph_neighbor'
  | 'excluded_shared_device'
  | RejectionReason;

export type VouchResult =
  | { ok: true; recordId: string; subjectUserId: string; voucherUserId: string; stakeAmount: number; points: number }
  | { ok: false; reason: VouchRejectionReason };

/** The recomputable personhood snapshot of one account. */
export type PersonhoodStatusRow = typeof personhoodStatuses.$inferSelect;

/**
 * The partial unique index on `(voucher_user_id, subject_user_id) WHERE status =
 * 'active'` — the concurrency backstop behind the friendly `already_vouched`
 * lookup. Named so a duplicate is answered for THIS constraint and not for some
 * future index on the same table.
 */
const ACTIVE_VOUCH_PAIR_UNIQUE = 'personhood_vouches_active_pair_key';

/** Map a sock-puppet exclusion reason to the matching vouch rejection reason. */
function exclusionReason(
  reason: 'self' | 'graph_neighbor' | 'shared_device',
): VouchRejectionReason {
  switch (reason) {
    case 'self':
      return 'excluded_self';
    case 'shared_device':
      return 'excluded_shared_device';
    default:
      return 'excluded_graph_neighbor';
  }
}

/* -------------------------------------------------------------------------- */
/*  Input aggregation + recompute                                             */
/* -------------------------------------------------------------------------- */

/** Sum the active vouchers' tier weights for a subject (the vouch axis). */
async function weightedVouchScore(subjectUserId: string): Promise<{ score: number; count: number }> {
  const vouches = await getDb()
    .select({ voucherUserId: personhoodVouches.voucherUserId })
    .from(personhoodVouches)
    .where(
      and(
        eq(personhoodVouches.subjectUserId, subjectUserId),
        eq(personhoodVouches.status, 'active'),
      ),
    );
  if (vouches.length === 0) {
    return { score: 0, count: 0 };
  }
  const voucherIds = vouches.map((vouch) => vouch.voucherUserId);
  const balances = await getDb()
    .select({ userId: reputationBalances.userId, trustTier: reputationBalances.trustTier })
    .from(reputationBalances)
    .where(inArray(reputationBalances.userId, voucherIds));
  const tierById = new Map<string, string>();
  for (const balance of balances) {
    tierById.set(balance.userId, balance.trustTier);
  }
  let score = 0;
  for (const voucherId of voucherIds) {
    // A voucher with no balance snapshot yet defaults to the `new` tier weight.
    score += vouchWeightForTier(tierById.get(voucherId) ?? 'new');
  }
  return { score, count: voucherIds.length };
}

/**
 * Whether the subject has at least one biometric-bound real-life attestation.
 *
 * Mongo's dotted `'metadata.biometricOk': true` becomes jsonb CONTAINMENT rather
 * than `metadata->>'biometricOk' = 'true'`: the text form also matches the
 * STRING `"true"`, which is not the boolean the attestation writes, and `@>`
 * additionally leaves the door open to a GIN index if this ever needs one.
 */
async function isBiometricBound(subjectUserId: string): Promise<boolean> {
  const [txn] = await getDb()
    .select({ id: reputationTransactions.id })
    .from(reputationTransactions)
    .where(
      and(
        eq(reputationTransactions.userId, subjectUserId),
        eq(reputationTransactions.actionType, REAL_LIFE_ATTESTED_ACTION),
        eq(reputationTransactions.status, 'active'),
        sql`${reputationTransactions.metadata} @> '{"biometricOk":true}'::jsonb`,
      ),
    )
    .limit(1);
  return txn !== undefined;
}

/** Count of the subject's active real-life counterparty attestations. */
async function realLifeCount(subjectUserId: string): Promise<number> {
  const [totals] = await getDb()
    .select({ total: count() })
    .from(reputationTransactions)
    .where(
      and(
        eq(reputationTransactions.userId, subjectUserId),
        eq(reputationTransactions.actionType, REAL_LIFE_ATTESTED_ACTION),
        eq(reputationTransactions.status, 'active'),
      ),
    );
  return totals?.total ?? 0;
}

/**
 * Recompute + persist a user's `PersonhoodStatus` from their active vouches,
 * real-life attestations, biometric signal, and sybil penalty. Mirrors
 * `User.verified` to `isRealPerson` so the reputation `deriveTrustTier` promotes
 * a real person to the `verified` tier; when `verified` actually flips, the
 * reputation balance is recalculated and `userCache` invalidated.
 */
export async function recomputePersonhood(userId: string): Promise<PersonhoodStatusRow> {
  const [user] = await getDb()
    .select({ isSeedVerifier: users.isSeedVerifier, verified: users.verified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  let inputs: PersonhoodInputs;
  let vouchCount = 0;
  let realLife = 0;
  let biometricBound = false;
  let sybilPenalty = 0;

  if (user?.isSeedVerifier === true) {
    inputs = {
      weightedVouchScore: 0,
      realLifeCount: 0,
      biometricBound: false,
      sybilPenalty: 0,
      isSeedVerifier: true,
    };
  } else {
    const [vouch, life, biometric, sybil] = await Promise.all([
      weightedVouchScore(userId),
      realLifeCount(userId),
      isBiometricBound(userId),
      computeSybilPenalty(userId),
    ]);
    vouchCount = vouch.count;
    realLife = life;
    biometricBound = biometric;
    sybilPenalty = sybil.penalty;
    inputs = {
      weightedVouchScore: vouch.score,
      realLifeCount: life,
      biometricBound: biometric,
      sybilPenalty: sybil.penalty,
      isSeedVerifier: false,
    };
  }

  const derived = personhoodScore(inputs);

  const columns = {
    score: derived.score,
    isRealPerson: derived.isRealPerson,
    vouchCount,
    realLifeCount: realLife,
    biometricBound,
    sybilPenalty,
    breakdownVouchSignal: derived.breakdown.vouchSignal,
    breakdownRealLifeSignal: derived.breakdown.realLifeSignal,
    breakdownBiometricSignal: derived.breakdown.biometricSignal,
    breakdownEvidence: derived.breakdown.evidence,
    breakdownSybilPenalty: derived.breakdown.sybilPenalty,
    breakdownSeed: derived.breakdown.seed,
  };
  const [status] = await getDb()
    .insert(personhoodStatuses)
    .values({ userId, ...columns })
    .onConflictDoUpdate({
      target: personhoodStatuses.userId,
      set: { ...columns, updatedAt: new Date() },
    })
    .returning();

  // Mirror onto users.verified so the reputation tier reflects personhood. Only
  // write + recompute + invalidate when the flag actually changes.
  if ((user?.verified === true) !== derived.isRealPerson) {
    await getDb().update(users).set({ verified: derived.isRealPerson }).where(eq(users.id, userId));
    await reputationService.recalculateBalance(userId);
    userCache.invalidate(userId);
  }

  return status;
}

/** The voucher's current personhood score (seed verifiers count as 1). */
async function voucherPersonhoodScore(voucherUserId: string): Promise<number> {
  const [user] = await getDb()
    .select({ isSeedVerifier: users.isSeedVerifier })
    .from(users)
    .where(eq(users.id, voucherUserId))
    .limit(1);
  if (user?.isSeedVerifier === true) {
    return 1;
  }
  const [status] = await getDb()
    .select({ score: personhoodStatuses.score })
    .from(personhoodStatuses)
    .where(eq(personhoodStatuses.userId, voucherUserId))
    .limit(1);
  if (status) {
    return status.score;
  }
  const recomputed = await recomputePersonhood(voucherUserId);
  return recomputed.score;
}

/* -------------------------------------------------------------------------- */
/*  Vouch                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Verify + record a `personhood_vouch` signed by `voucherUserId` about the
 * subject in `record.about`, stake the voucher, award the subject the
 * `personhood_vouched` points, and recompute the subject's personhood. Returns a
 * verdict so the route maps a rejection to the right HTTP status.
 */
export async function vouchForPerson(
  envelope: SignedRecordEnvelope,
  voucherUserId: string,
): Promise<VouchResult> {
  if (envelope.type !== 'personhood_vouch') {
    return { ok: false, reason: 'invalid_type' };
  }

  // The vouch is the voucher's SELF-ISSUED statement (`subject === issuer === B`).
  // Account-based: the SDK's DID spelling may differ from the server's
  // `DID_WEB_DOMAIN` anchor for the same account.
  if (!isSelfIssuedByUser(envelope, voucherUserId)) {
    return { ok: false, reason: 'not_self_issued' };
  }

  const parsed = personhoodVouchRecordSchema.safeParse(envelope.record);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_record' };
  }
  const record = parsed.data;

  const subjectUserId = parseUserDid(record.about);
  if (!subjectUserId) {
    return { ok: false, reason: 'invalid_subject' };
  }
  if (subjectUserId === voucherUserId) {
    return { ok: false, reason: 'self_vouch' };
  }

  // Cheap forgery gate before any expensive graph / DB work.
  if (!(await verifyEnvelopeSignature(envelope))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // The voucher must themselves be a real person (≥ τ) — only real people can
  // vouch; the genesis is the seed verifiers.
  const voucherScore = await voucherPersonhoodScore(voucherUserId);
  if (voucherScore < MIN_VOUCHER_PERSONHOOD) {
    return { ok: false, reason: 'voucher_below_threshold' };
  }

  const [subject] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, subjectUserId))
    .limit(1);
  if (!subject) {
    return { ok: false, reason: 'subject_not_found' };
  }

  // Anti-sybil: the voucher must not be the subject's puppet (no graph edge, no
  // shared device/IP).
  const relation = await isSockPuppetRelation(subjectUserId, voucherUserId, {
    hops: PERSONHOOD_VOUCH_EXCLUSION_HOPS,
  });
  if (relation.excluded) {
    return { ok: false, reason: exclusionReason(relation.reason) };
  }

  // Reject any existing vouch for this pair BEFORE appending a signed record.
  // Withdrawn/slashed vouches remain audit history and must not make the pair
  // eligible for a fresh reputation award — so this lookup is deliberately
  // BROADER than the partial unique index, which only covers `active` rows.
  const [existing] = await getDb()
    .select({ id: personhoodVouches.id })
    .from(personhoodVouches)
    .where(
      and(
        eq(personhoodVouches.voucherUserId, voucherUserId),
        eq(personhoodVouches.subjectUserId, subjectUserId),
      ),
    )
    .limit(1);
  if (existing) {
    return { ok: false, reason: 'already_vouched' };
  }

  // Store the voucher's signed statement on the voucher's own chain. A
  // `personhood_vouch` must be a v2 (chained) envelope — `oxyStorePolicy`
  // enforces that — so the returned content address always names a stored row,
  // which is what `personhood_vouches.record_id`'s foreign key requires.
  const stored = await verifyAndStoreRecord(envelope, voucherUserId);
  if (!stored.ok) {
    return { ok: false, reason: stored.reason };
  }
  const recordId = stored.record.recordId;

  const stakeAmount = clamp(
    record.stake ?? PERSONHOOD_VOUCH_DEFAULT_STAKE,
    PERSONHOOD_VOUCH_MIN_STAKE,
    PERSONHOOD_VOUCH_MAX_STAKE,
  );

  try {
    await getDb()
      .insert(personhoodVouches)
      .values({ voucherUserId, subjectUserId, stakeAmount, recordId, status: 'active' });
  } catch (error) {
    if (isUniqueViolation(error, ACTIVE_VOUCH_PAIR_UNIQUE)) {
      return { ok: false, reason: 'already_vouched' };
    }
    throw error;
  }

  // Award the subject — no self-award: the SERVICE awards, referencing the
  // voucher's envelope as provenance and recording the voucher (so they can be
  // slashed if the subject is later proven fake).
  const txn = await reputationService.award({
    userId: subjectUserId,
    actionType: PERSONHOOD_VOUCHED_ACTION,
    createdByUserId: voucherUserId,
    sourceActionId: recordId,
    reason: 'Vouched for as a real person by a staking voucher',
    metadata: { voucherUserId, stakeAmount },
    emitAttestation: true,
    sourceEnvelopeIds: [recordId],
  });

  await recomputePersonhood(subjectUserId);

  logger.info('Personhood vouch accepted', {
    component: 'civic.personhood',
    subjectUserId,
    voucherUserId,
    recordId,
  });

  return { ok: true, recordId, subjectUserId, voucherUserId, stakeAmount, points: txn.points };
}

/* -------------------------------------------------------------------------- */
/*  Withdraw                                                                   */
/* -------------------------------------------------------------------------- */

export type WithdrawResult = { ok: true } | { ok: false; reason: 'not_found' };

/**
 * Withdraw the caller's active vouch for `subjectUserId`. The vouch flips to
 * `withdrawn` (kept for audit) so it no longer contributes to the subject's
 * personhood; the subject is recomputed (which may demote them below θ). The
 * already-awarded `personhood_vouched` reputation points are NOT clawed back,
 * and the historical vouch still prevents re-vouching the same pair to avoid
 * farming reputation through withdraw/re-vouch loops.
 */
export async function withdrawVouch(voucherUserId: string, subjectUserId: string): Promise<WithdrawResult> {
  const withdrawn = await getDb()
    .update(personhoodVouches)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(personhoodVouches.voucherUserId, voucherUserId),
        eq(personhoodVouches.subjectUserId, subjectUserId),
        eq(personhoodVouches.status, 'active'),
      ),
    )
    .returning({ id: personhoodVouches.id });
  if (withdrawn.length === 0) {
    return { ok: false, reason: 'not_found' };
  }
  await recomputePersonhood(subjectUserId);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Slash cascade                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Slash every ACTIVE voucher of a subject who was proven fake (a failed random
 * audit, or a reversed personhood award): award each `vouch_slashed` (-20), flip
 * their vouch to `slashed`, and recompute that voucher's standing. Finally
 * recompute the (now un-vouched) subject. Returns the number of vouchers
 * slashed. Best-effort — individual failures are logged and skipped.
 */
export async function slashVouchersForFakeSubject(subjectUserId: string, reason: string): Promise<number> {
  const vouches = await getDb()
    .select({ id: personhoodVouches.id, voucherUserId: personhoodVouches.voucherUserId })
    .from(personhoodVouches)
    .where(
      and(
        eq(personhoodVouches.subjectUserId, subjectUserId),
        eq(personhoodVouches.status, 'active'),
      ),
    );

  let slashed = 0;
  for (const vouch of vouches) {
    const voucherUserId = vouch.voucherUserId;
    const vouchId = vouch.id;
    try {
      await reputationService.award({
        userId: voucherUserId,
        actionType: VOUCH_SLASHED_ACTION,
        sourceActionId: `vouch_slash:${vouchId}`,
        reason,
      });
      await getDb()
        .update(personhoodVouches)
        .set({ status: 'slashed' })
        .where(eq(personhoodVouches.id, vouchId));
      await recomputePersonhood(voucherUserId);
      slashed += 1;
    } catch (error) {
      logger.warn('Vouch slash failed (non-fatal)', {
        component: 'civic.personhood',
        voucherUserId,
        vouchId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The subject's vouches are now slashed → recompute drops their vouch signal
  // (and, if it was their main evidence, demotes them below θ).
  await recomputePersonhood(subjectUserId);

  return slashed;
}
