/**
 * Signed Record Service — the thin Oxy ADAPTER over the @oxyhq/protocol chain
 * engine (self-sovereign identity layer — B5; F0.2 hash chain).
 *
 * The verification + continuity + append state machine now lives, app-agnostic,
 * in `@oxyhq/protocol` (`verifyAndAppend`). This module is only the Oxy-specific
 * glue around it:
 *
 *  - the {@link oxyRecordStore} (the protocol `RecordStore` over the
 *    `signed_records`/`repo_heads` tables) and {@link oxyVerificationResolver}
 *    (the Oxy authorization policy: current VMs + the `OXY_DID` custodial
 *    issuer) are injected into the engine;
 *  - the `subject_mismatch` binding (the caller may only write to their OWN
 *    chain), the Oxy STORE strictness gate (only the closed
 *    `oxySignedRecordTypeSchema` set may land on the Oxy chain) and the CHAIN
 *    gate (only the two v1 legacy singletons may arrive unchained) are applied
 *    here, around the engine, because they are Oxy policy, not protocol grammar.
 *
 * The protocol engine guarantees the same ordered checks (signature, issuer
 * authorization, freshness, monotonicity, chain continuity) and the same
 * rejection-reason strings the API returned before the extraction, so responses
 * are unchanged.
 */

import { signedRecordSigningInput } from '@oxyhq/protocol';
import { verifyAndAppend, verifyEnvelope as protocolVerifyEnvelope, type RejectionReason, type VerifyOutcome } from '@oxyhq/protocol';
import { oxySignedRecordTypeSchema, type OxySignedRecordType, type SignedRecordEnvelope } from '@oxyhq/contracts';
import SignatureService from './signature.service';
import { parseUserDid } from './did.service';
import { oxyRecordStore } from './oxyRecordStore';
import { oxyVerificationResolver } from './oxyVerificationResolver';

/**
 * The reference to a stored record returned on a successful append. Carries the
 * content address + chain `seq` from the engine plus the stored envelope and its
 * `verified` flag — enough for every caller (the route echoes the envelope; the
 * civic/node services read the `recordId`/`seq`).
 */
export interface StoredRecordRef {
  recordId: string;
  seq: number;
  envelope: SignedRecordEnvelope;
  verified: boolean;
}

export type VerifyAndStoreResult =
  | { ok: true; record: StoredRecordRef }
  | { ok: false; reason: RejectionReason };

/**
 * Build and sign a record envelope with a secp256k1 private key. Used to forge a
 * valid client signature in tests and (server-side) for custodial provenance
 * attestations. The returned envelope verifies against the protocol signature
 * check. (Signing — not an engine internal — stays in the Oxy service.)
 */
export function signRecordEnvelope(
  fields: Omit<SignedRecordEnvelope, 'signature'>,
  privateKeyHex: string,
): SignedRecordEnvelope {
  const signature = SignatureService.signMessage(signedRecordSigningInput(fields), privateKeyHex);
  return { ...fields, signature };
}

/**
 * The record categories a v1 (UNCHAINED) envelope may still carry.
 *
 * v1 predates the hash chain and only ever carried these two, both already in
 * production — see `@oxyhq/contracts`'s `oxyRecordTypes.ts`, which states it as
 * history rather than as a rule anything enforced. It is a rule now; see
 * {@link oxyStorePolicy}'s third policy for why.
 */
const V1_LEGACY_RECORD_TYPES: ReadonlySet<OxySignedRecordType> = new Set(['identity', 'profile']);

/**
 * The three Oxy policies that wrap the protocol engine, applied before any
 * verification:
 *  1. `subject_mismatch` — the envelope's `subject` MUST be `subjectUserId`'s DID
 *     (a caller may only publish records about their own account / chain).
 *  2. the STORE strictness gate — the base envelope `type` is an OPEN string so
 *     any Oxy app can sign on the shared grammar, but the store accepts ONLY the
 *     closed `oxySignedRecordTypeSchema` set; a `type` outside it is rejected as
 *     `invalid_envelope`. That set now includes `app_record`, the one category
 *     every Oxy app's records carry (the lexicon is the envelope's `collection`,
 *     not the type) — see `@oxyhq/contracts`'s `oxyRecordTypes.ts` for why the
 *     boundary moved.
 *  3. the CHAIN gate — every Oxy type except the two v1 legacy singletons MUST
 *     arrive as a v2 (chained) envelope. `app_record` is not a legacy singleton,
 *     so an app record must be chained — which is what Mention already signs.
 *
 * ## Why (3) exists — the `recordId ?? ''` root cause
 *
 * `verifyAndStoreRecord` hands back the engine-computed content address for
 * EVERY successful append, but `oxyRecordStore.append`'s v1 path stores no
 * `record_id` at all (the schema's `signed_records_chain_completeness_check`
 * forbids a half-chained row, so a v1 row cannot carry one). Five civic call
 * sites then wrote that address into a projection —
 * `personhood_vouches.record_id`, `validation_votes.record_id`,
 * `verifiable_credentials.record_id` — as a reference to the proof. On a v1
 * envelope those references named a row that does not exist: Mongo accepted a
 * dangling reference silently, and the `?? ''` those call sites carried was a
 * vestigial guard from an older, optional `recordId` shape that could no longer
 * fire and hid the real defect. The version is entirely CLIENT-chosen, so any
 * client signing `{version: 1, type: 'personhood_vouch'}` produced one.
 *
 * The fix belongs here rather than at the five call sites: this is the one
 * chokepoint every projected record passes through, so a type added later
 * inherits the guarantee instead of re-acquiring the bug. With it, a content
 * address returned for a projected type always names a stored row, which is
 * exactly what the foreign keys now require.
 *
 * Returns the rejection reason when a policy fails, or `null` when all pass.
 */
function oxyStorePolicy(env: SignedRecordEnvelope, subjectUserId: string): RejectionReason | null {
  // Account-based, not DID-string-based: the SDK signs subjects at the canonical
  // identity apex while `DID_WEB_DOMAIN` may re-anchor server-emitted DIDs, so
  // the binding resolves the subject DID back to the account id and compares ids.
  if (parseUserDid(env.subject) !== subjectUserId) {
    return 'subject_mismatch';
  }
  const oxyType = oxySignedRecordTypeSchema.safeParse(env.type);
  if (!oxyType.success) {
    return 'invalid_envelope';
  }
  if (env.version !== 2 && !V1_LEGACY_RECORD_TYPES.has(oxyType.data)) {
    return 'invalid_envelope';
  }
  return null;
}

/**
 * Verify an envelope for a subject WITHOUT persisting it (the Oxy store policy +
 * the protocol verification state machine with the Oxy store + resolver
 * injected). Powers the public re-verify endpoint.
 */
export async function verifyEnvelope(
  env: SignedRecordEnvelope,
  subjectUserId: string,
): Promise<VerifyOutcome> {
  const policyReason = oxyStorePolicy(env, subjectUserId);
  if (policyReason) {
    return { ok: false, reason: policyReason };
  }
  return protocolVerifyEnvelope(oxyRecordStore, oxyVerificationResolver, env);
}

/**
 * Verify an envelope and append it to the subject's chain as `verified: true`,
 * via the protocol engine with the Oxy store + resolver injected (wrapped by the
 * {@link oxyStorePolicy}). Returns the verdict (so the route maps a rejection to
 * a 4xx) rather than throwing on a bad envelope.
 */
export async function verifyAndStoreRecord(
  env: SignedRecordEnvelope,
  subjectUserId: string,
): Promise<VerifyAndStoreResult> {
  const policyReason = oxyStorePolicy(env, subjectUserId);
  if (policyReason) {
    return { ok: false, reason: policyReason };
  }

  const outcome = await verifyAndAppend(oxyRecordStore, oxyVerificationResolver, env);
  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    record: { recordId: outcome.recordId, seq: outcome.seq, envelope: env, verified: true },
  };
}

/** Latest stored record of `type` for a user, or null. */
export async function getLatestRecord(
  userId: string,
  type: 'identity' | 'profile',
): Promise<{ envelope: SignedRecordEnvelope } | null> {
  return oxyRecordStore.latestRecordOfType(userId, type);
}
