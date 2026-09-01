/**
 * Reputation Attestation Service (civic / Commons — Fase 1).
 *
 * Makes reputation CRYPTO-OWNED: every civic award additionally emits an
 * Oxy-signed `reputation_attestation` record onto the SUBJECT's per-subject hash
 * chain (F0.2). The record references the `ReputationTransaction` it attests and
 * the user-signed envelopes that originated it, so the proof chain is:
 *
 *   user signatures (real-life / jury verdicts) → Oxy attestation → reputation txn
 *
 * The attestation is signed with the Oxy CUSTODIAL key (`OXY_PRIVATE_KEY`, the
 * verification method of `OXY_DID`) — the subject is the awarded user but the
 * SIGNER is Oxy. `signedRecord.service.verifyEnvelope` accepts this because the
 * issuer is `OXY_DID` and the public key is the Oxy custodial key; the record
 * still lives on the user's chain (so it materializes per-user and exports with
 * the account). See `verifyEnvelope`'s issuer branch.
 *
 * Emission is best-effort: it is idempotent per txn (one attestation per `rkey =
 * txnId`), non-fatal (returns `null` and logs on any failure — never throws to
 * the award path), and retries the chain-head race a few times. A missing Oxy
 * key (dev / pre-prod) simply skips emission, exactly like the signed export.
 */

import { createHash } from 'node:crypto';
import type { ModerationSeverity, SignedRecordEnvelope } from '@oxyhq/contracts';
import { signedRecordSigningInput } from '@oxyhq/protocol';
import SignatureService from '../signature.service';
import { buildUserDid, OXY_DID } from '../did.service';
import { getHead, materializeCurrent } from '../repoLog.service';
import { verifyAndStoreRecord } from '../signedRecord.service';
import { weightClassForAction } from '../../utils/reputation.constants';
import { logger } from '../../utils/logger';

const ALG = 'ES256K-DER-SHA256' as const;

/** AtProto-style collection (NSID) for crypto-owned reputation attestations. */
export const REPUTATION_ATTESTATION_COLLECTION = 'app.oxy.reputation';

/** Retry budget for the multi-writer chain-head race (rare). */
const MAX_ATTESTATION_ATTEMPTS = 4;

/** The minimal transaction shape an attestation references. */
export interface AttestableTransaction {
  id: string;
  userId: string;
  actionType: string;
  points: number;
  category: string;
  sourceActionId?: string | null;
}

export interface AttestAwardOptions {
  /** `recordId`s of the user-signed envelopes that originated the award. */
  sourceEnvelopes?: string[];
}

/**
 * Emit (idempotently) an Oxy-signed `reputation_attestation` for `txn` onto the
 * subject's hash chain. Returns the stored/existing attestation envelope, or
 * `null` when emission was skipped (no Oxy key) or failed (non-fatal).
 */
export async function attestAward(
  txn: AttestableTransaction,
  options: AttestAwardOptions = {},
): Promise<SignedRecordEnvelope | null> {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  const publicKey = process.env.OXY_PUBLIC_KEY;
  if (!privateKey || !publicKey) {
    logger.warn('Reputation attestation skipped: OXY_PRIVATE_KEY/OXY_PUBLIC_KEY not configured', {
      component: 'civic.attestation',
    });
    return null;
  }

  const subjectUserId = txn.userId;
  const txnId = txn.id;
  const subjectDid = buildUserDid(subjectUserId);

  // Idempotency: at most one attestation per txn (keyed by rkey = txnId).
  const existing = await materializeCurrent(subjectUserId, REPUTATION_ATTESTATION_COLLECTION, txnId);
  if (existing) {
    return existing;
  }

  const record: Record<string, unknown> = {
    txnId,
    subjectUserId,
    actionType: txn.actionType,
    points: txn.points,
    category: txn.category,
    sourceActionId: txn.sourceActionId ?? null,
    weightClass: weightClassForAction(txn.actionType),
    sourceEnvelopeIds: options.sourceEnvelopes ?? [],
  };

  for (let attempt = 0; attempt < MAX_ATTESTATION_ATTEMPTS; attempt += 1) {
    const head = await getHead(subjectUserId);
    const seq = head ? head.seq + 1 : 0;
    const prev = head ? head.headRecordId : null;

    const fields: Omit<SignedRecordEnvelope, 'signature'> = {
      version: 2,
      type: 'reputation_attestation',
      subject: subjectDid,
      issuer: OXY_DID,
      record,
      issuedAt: Date.now(),
      seq,
      prev,
      collection: REPUTATION_ATTESTATION_COLLECTION,
      rkey: txnId,
      publicKey,
      alg: ALG,
    };
    const signature = SignatureService.signMessage(signedRecordSigningInput(fields), privateKey);
    const envelope: SignedRecordEnvelope = { ...fields, signature };

    // The subject account's VMs are NOT consulted for a custodial record (the
    // issuer is OXY_DID); the resolver resolves the subject either way.
    const result = await verifyAndStoreRecord(envelope, subjectUserId);
    if (result.ok) {
      return envelope;
    }

    // A concurrent writer advanced the chain head between our read and write —
    // re-read the head and retry.
    if (result.reason === 'chain_conflict' || result.reason === 'bad_seq' || result.reason === 'chain_fork') {
      continue;
    }

    logger.warn('Reputation attestation rejected (non-fatal)', {
      component: 'civic.attestation',
      reason: result.reason,
      txnId,
      subjectUserId,
    });
    return null;
  }

  logger.warn('Reputation attestation abandoned after chain-race retries', {
    component: 'civic.attestation',
    txnId,
    subjectUserId,
  });
  return null;
}

/** AtProto-style collection (NSID) for moderation-conduct effect attestations. */
export const MODERATION_EFFECT_ATTESTATION_COLLECTION = 'app.oxy.moderationEffect';

/** What a moderation attestation is allowed to know. */
export interface ModerationEffectAttestationInput {
  /** The ledger transaction the attestation covers; also the record's `rkey`. */
  transactionId: string;
  /** The subject whose chain the record lands on. */
  subjectUserId: string;
  /** Severity BAND only — never the taxonomy code. */
  severityBand: ModerationSeverity;
  /** Signed points, already multiplied and capped. */
  points: number;
  /** Hash of the PRIVATE decision document. Provenance without contents. */
  decisionHash: string;
  /** The Oxy conduct policy version the consequence was derived under. */
  policyVersion: string;
  /** The effect's idempotency key, stored HASHED — see below. */
  sourceActionId: string;
}

/**
 * Emit an Oxy-signed attestation for a moderation conduct effect.
 *
 * SEPARATE from {@link attestAward} on purpose, and the difference is the whole
 * reason this function exists: a reputation attestation is exportable and may end
 * up on a public chain, so a moderation one must be a MINIMAL PROOF rather than a
 * description. It carries a severity BAND, the points, the hash of the private
 * decision and the policy version — and nothing else:
 *
 *  - NO taxonomy code. `harassment.targeted_abuse` in an exportable record turns
 *    a reputation chain into a published charge sheet.
 *  - NO victim, reporter or juror identifier. Naming them would put the people a
 *    moderation system protects into its most durable artefact.
 *  - NO content, no evidence reference, no case id.
 *  - The `sourceActionId` is stored as a SHA-256 hash, not in the clear: the key
 *    embeds the incident id, which correlates across effects and would let a
 *    holder of two records infer they concern the same case. The hash still
 *    proves which effect the attestation covers to anyone who already knows the
 *    key.
 *
 * A verifier who holds the private decision can recompute `decisionHash` and
 * confirm the chain; a verifier who does not learns only that a consequence of
 * some band occurred. That asymmetry is the design.
 *
 * Best-effort and non-fatal, exactly like {@link attestAward}: a missing Oxy key
 * skips emission, and a signing failure never blocks or rolls back the
 * consequence.
 */
export async function attestModerationEffect(
  input: ModerationEffectAttestationInput,
): Promise<SignedRecordEnvelope | null> {
  const privateKey = process.env.OXY_PRIVATE_KEY;
  const publicKey = process.env.OXY_PUBLIC_KEY;
  if (!privateKey || !publicKey) {
    logger.warn(
      'Moderation attestation skipped: OXY_PRIVATE_KEY/OXY_PUBLIC_KEY not configured',
      { component: 'civic.attestation' },
    );
    return null;
  }

  const subjectDid = buildUserDid(input.subjectUserId);

  // Idempotency: at most one attestation per transaction.
  const existing = await materializeCurrent(
    input.subjectUserId,
    MODERATION_EFFECT_ATTESTATION_COLLECTION,
    input.transactionId,
  );
  if (existing) {
    return existing;
  }

  const record: Record<string, unknown> = {
    actionType: 'moderation_conduct_effect',
    severityBand: input.severityBand,
    points: input.points,
    decisionHash: input.decisionHash,
    policyVersion: input.policyVersion,
    sourceActionIdHash: createHash('sha256').update(input.sourceActionId).digest('hex'),
  };

  for (let attempt = 0; attempt < MAX_ATTESTATION_ATTEMPTS; attempt += 1) {
    const head = await getHead(input.subjectUserId);
    const seq = head ? head.seq + 1 : 0;
    const prev = head ? head.headRecordId : null;

    const fields: Omit<SignedRecordEnvelope, 'signature'> = {
      version: 2,
      type: 'reputation_attestation',
      subject: subjectDid,
      issuer: OXY_DID,
      record,
      issuedAt: Date.now(),
      seq,
      prev,
      collection: MODERATION_EFFECT_ATTESTATION_COLLECTION,
      rkey: input.transactionId,
      publicKey,
      alg: ALG,
    };
    const signature = SignatureService.signMessage(signedRecordSigningInput(fields), privateKey);
    const envelope: SignedRecordEnvelope = { ...fields, signature };

    const result = await verifyAndStoreRecord(envelope, input.subjectUserId);
    if (result.ok) {
      return envelope;
    }

    if (
      result.reason === 'chain_conflict' ||
      result.reason === 'bad_seq' ||
      result.reason === 'chain_fork'
    ) {
      continue;
    }

    logger.warn('Moderation attestation rejected (non-fatal)', {
      component: 'civic.attestation',
      reason: result.reason,
      transactionId: input.transactionId,
    });
    return null;
  }

  logger.warn('Moderation attestation abandoned after chain-race retries', {
    component: 'civic.attestation',
    transactionId: input.transactionId,
  });
  return null;
}
