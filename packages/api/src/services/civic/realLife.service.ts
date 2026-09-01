/**
 * Real-life Attestation Service (civic / Commons — Fase 2 Part A).
 *
 * The HIGH-weight (25 pt) anti-gaming signal: a counterparty (B) who physically
 * met the subject (A) scans A's QR (`oxydni://attest?subject=<A.did>&ctx=…&
 * nonce=…&exp=…`) and signs a `real_life_attestation` record with B's OWN key.
 *
 * Trust model:
 *  - B's envelope is SELF-ISSUED (`subject === issuer === B.did`) and stored on
 *    B's own chain — "B attests A" is B's signed statement. `record.about` is
 *    A's DID. (A's reputation award rides a SEPARATE Oxy-signed
 *    `reputation_attestation` on A's chain via `award(emitAttestation)`, which
 *    references B's envelope as provenance.)
 *  - Replay is blocked by a single-use `CivicNonce` (the QR's nonce) + `exp`.
 *  - Sybil farming is blocked by the shared graph-exclusion test (B must not be
 *    A's puppet: no graph edge, no shared deviceId).
 *  - Re-confirming the SAME person is IDEMPOTENT: the (attestor→subject) pair
 *    earns the HIGH-weight award at most once. A repeat (with a fresh QR/nonce)
 *    is a clean no-op that returns the original award, never a second +25 — so
 *    `realLifeCount`/personhood counts DISTINCT counterparties, not re-scans.
 *  - B is recorded as the attestor (`createdByUserId`) so B can be SLASHED in
 *    Part B if A's attested action is later found fraudulent.
 *
 * No self-award: B signs; the SERVICE decides eligibility and calls
 * `reputationService.award` for A in-process.
 */

import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
import { verifyEnvelopeSignature, type RejectionReason } from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { realLifeAttestationRecordSchema } from '@oxyhq/contracts';
import { getDb } from '../../config/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { civicNonces } from '../../db/schema/civicNonces';
import { reputationTransactions } from '../../db/schema/reputationTransactions';
import { users } from '../../db/schema/users';
import { isSelfIssuedByUser, parseUserDid } from '../did.service';
import { verifyAndStoreRecord } from '../signedRecord.service';
import { isSockPuppetRelation } from './graphExclusion';
import { reputationService } from '../reputation.service';
import { REAL_LIFE_ATTESTED_ACTION } from '../../utils/reputation.constants';
import {
  REAL_LIFE_NONCE_MAX_AGE_MS,
  REAL_LIFE_EXCLUSION_HOPS,
} from '../../utils/civic.constants';
import { logger } from '../../utils/logger';

const NONCE_PURPOSE = 'real_life_attestation';

/** Why a real-life attestation can be rejected (stable, machine-readable). */
export type RealLifeRejectionReason =
  | 'invalid_type'
  | 'invalid_record'
  | 'not_self_issued'
  | 'invalid_subject'
  | 'self_attestation'
  | 'subject_not_found'
  | 'expired'
  | 'nonce_used'
  | 'excluded_graph_neighbor'
  | 'excluded_shared_device'
  | RejectionReason;

export type RealLifeResult =
  | { ok: true; recordId: string; subjectUserId: string; attestorUserId: string; points: number }
  | { ok: false; reason: RealLifeRejectionReason };

/** SHA-256 of the purpose-salted raw nonce (we never store the raw value). */
function hashNonce(nonce: string): string {
  return crypto.createHash('sha256').update(`${NONCE_PURPOSE}:${nonce}`).digest('hex');
}

/** The unique index that makes the nonce single-use. */
const NONCE_HASH_UNIQUE = 'civic_nonces_nonce_hash_key';

/**
 * Atomically claim a single-use nonce. Returns false when it was already used
 * (the unique `nonce_hash` index rejects the second insert) — the replay guard.
 */
async function claimNonce(nonce: string, subjectUserId: string, exp: number): Promise<boolean> {
  try {
    await getDb().insert(civicNonces).values({
      nonceHash: hashNonce(nonce),
      purpose: NONCE_PURPOSE,
      subjectUserId,
      expiresAt: new Date(exp),
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error, NONCE_HASH_UNIQUE)) {
      return false;
    }
    throw error;
  }
}

/** Map a graph-exclusion reason to the matching rejection reason. */
function exclusionReason(
  reason: 'self' | 'graph_neighbor' | 'shared_device',
): RealLifeRejectionReason {
  switch (reason) {
    case 'shared_device':
      return 'excluded_shared_device';
    case 'self':
      return 'self_attestation';
    default:
      return 'excluded_graph_neighbor';
  }
}

/**
 * Verify + record a real-life attestation signed by `attestorUserId` (B) about
 * the subject referenced in `record.about` (A), and award A the HIGH-weight
 * points. Returns a verdict so the route maps a rejection to the right status.
 */
export async function submitRealLifeAttestation(
  envelope: SignedRecordEnvelope,
  attestorUserId: string,
): Promise<RealLifeResult> {
  if (envelope.type !== 'real_life_attestation') {
    return { ok: false, reason: 'invalid_type' };
  }

  // B's envelope must be SELF-ISSUED (B signs as the subject; `about` carries A).
  // Account-based: the SDK spells B's DID at the canonical identity apex, which
  // may differ from the server's `DID_WEB_DOMAIN` anchor for the same account.
  if (!isSelfIssuedByUser(envelope, attestorUserId)) {
    return { ok: false, reason: 'not_self_issued' };
  }

  const parsedRecord = realLifeAttestationRecordSchema.safeParse(envelope.record);
  if (!parsedRecord.success) {
    return { ok: false, reason: 'invalid_record' };
  }
  const record = parsedRecord.data;

  const subjectUserId = parseUserDid(record.about);
  if (!subjectUserId) {
    return { ok: false, reason: 'invalid_subject' };
  }
  if (subjectUserId === attestorUserId) {
    return { ok: false, reason: 'self_attestation' };
  }

  // Freshness: the QR's `exp` must be in the future but not absurdly far out.
  const now = Date.now();
  if (record.exp <= now || record.exp > now + REAL_LIFE_NONCE_MAX_AGE_MS) {
    return { ok: false, reason: 'expired' };
  }

  const [subject] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, subjectUserId))
    .limit(1);
  if (!subject) {
    return { ok: false, reason: 'subject_not_found' };
  }

  // Cheap forgery gate before any expensive graph work (authoritative
  // verification happens again inside verifyAndStoreRecord).
  if (!(await verifyEnvelopeSignature(envelope))) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Anti-sybil: B must not be A's puppet (no graph edge, no shared deviceId).
  // IP is not a signal (no user IPs at rest); deviceId + social graph + the
  // jury carry the anti-sybil weight for real-life attestation.
  const relation = await isSockPuppetRelation(subjectUserId, attestorUserId, {
    hops: REAL_LIFE_EXCLUSION_HOPS,
  });
  if (relation.excluded) {
    return { ok: false, reason: exclusionReason(relation.reason) };
  }

  // Idempotent re-affirmation: the (attestor→subject) pair earns the
  // HIGH-weight award at most ONCE. If B has already attested A, a repeat is a
  // clean no-op that returns the ORIGINAL award's points — never a second +25.
  // Keyed on the pair with NO time window (the simplest guarantee against a
  // double-award), which also keeps `realLifeCount`/personhood a count of
  // DISTINCT counterparties. Short-circuiting BEFORE the nonce claim means a
  // no-op repeat never burns the subject's fresh QR. A same-QR double-tap race
  // is still serialised by the single-use nonce below (one caller wins the
  // insert; the other gets `nonce_used`), so only one award is ever created.
  const [existingPairAward] = await getDb()
    .select({
      points: reputationTransactions.points,
      sourceActionId: reputationTransactions.sourceActionId,
    })
    .from(reputationTransactions)
    .where(
      and(
        eq(reputationTransactions.userId, subjectUserId),
        eq(reputationTransactions.createdByUserId, attestorUserId),
        eq(reputationTransactions.actionType, REAL_LIFE_ATTESTED_ACTION),
        eq(reputationTransactions.status, 'active'),
      ),
    )
    .limit(1);
  if (existingPairAward) {
    // The award's `sourceActionId` IS the original attestation's content
    // address — this service is the only writer of this action type and always
    // sets it — so the repeat reports the SAME address the first scan did. The
    // lookup deliberately does NOT filter on it being present: narrowing here
    // would let a row without one fall through to a SECOND +25 award, which is
    // the one outcome the pair idempotency exists to prevent.
    const originalRecordId = existingPairAward.sourceActionId;
    if (originalRecordId === null) {
      logger.warn('Real-life award has no source record id; repeat scan reports none', {
        component: 'civic.realLife',
        subjectUserId,
        attestorUserId,
      });
    }
    return {
      ok: true,
      recordId: originalRecordId ?? '',
      subjectUserId,
      attestorUserId,
      points: existingPairAward.points,
    };
  }

  // Burn the single-use nonce (replay guard) only after the eligibility gates,
  // so a rejected attempt never consumes the subject's QR.
  const claimed = await claimNonce(record.nonce, subjectUserId, record.exp);
  if (!claimed) {
    return { ok: false, reason: 'nonce_used' };
  }

  // Store B's signed attestation on B's chain (authoritative verify + append).
  // A `real_life_attestation` must be a v2 (chained) envelope — `oxyStorePolicy`
  // enforces that — so the returned content address always names a stored row,
  // and the award below can carry it as durable provenance.
  const stored = await verifyAndStoreRecord(envelope, attestorUserId);
  if (!stored.ok) {
    return { ok: false, reason: stored.reason };
  }
  const recordId = stored.record.recordId;

  // Award A the HIGH-weight points, recording B as the attestor + emitting the
  // Oxy provenance attestation that references B's envelope.
  const txn = await reputationService.award({
    userId: subjectUserId,
    actionType: REAL_LIFE_ATTESTED_ACTION,
    createdByUserId: attestorUserId,
    sourceActionId: recordId,
    reason: 'Real-life attestation by a counterparty',
    metadata: { attestorUserId, context: record.context, biometricOk: record.biometricOk ?? false },
    emitAttestation: true,
    sourceEnvelopeIds: [recordId],
  });

  logger.info('Real-life attestation accepted', {
    component: 'civic.realLife',
    subjectUserId,
    attestorUserId,
    recordId,
  });

  return {
    ok: true,
    recordId,
    subjectUserId,
    attestorUserId,
    points: txn.points,
  };
}
