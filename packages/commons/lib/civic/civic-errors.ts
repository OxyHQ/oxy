/**
 * Map a thrown SDK error from a Fase 2 civic write to a stable code the UI shows
 * friendly copy for.
 *
 * The API rejects these writes with a message that embeds the server reason —
 * `"Attestation rejected: <reason>"` / `"Vote rejected: <reason>"` /
 * `"Vouch rejected: <reason>"` — which the SDK preserves on `Error.message`. Two
 * exceptions are sentences rather than `<verb> rejected: <reason>`: the jury
 * "not selected" case (`"You are not on this validation jury"`) and the vouch
 * `subject_not_found` case (`"Vouch subject not found"`), so they are matched
 * separately.
 *
 * Only the reasons we have localized copy for are recognized; anything else
 * (transport failures, unmodelled reasons) collapses to `'generic'`, so a screen
 * can always do `t('civic.<ns>.error.' + code)` and land on a real string.
 */

/** Recognized rejection codes for a real-life attestation submit. */
export type AttestErrorCode =
  | 'expired'
  | 'nonce_used'
  | 'pair_cooldown'
  | 'excluded_graph_neighbor'
  | 'excluded_shared_device'
  | 'self_attestation'
  | 'bad_signature'
  | 'subject_not_found'
  | 'generic';

/** Recognized rejection codes for a validation vote. */
export type VoteErrorCode = 'request_closed' | 'already_voted' | 'not_selected' | 'generic';

/** Recognized rejection codes for a personhood vouch submit. */
export type VouchErrorCode =
  | 'self_vouch'
  | 'already_vouched'
  | 'voucher_below_threshold'
  | 'excluded_graph_neighbor'
  | 'excluded_shared_device'
  | 'subject_not_found'
  | 'generic';

/**
 * Recognized rejection reasons for a credential VERIFY (`valid: false`).
 *
 * `civic.credentials.verify` resolves to `{ valid, reason?, credential }` (it does NOT
 * throw on an untrusted credential), so this maps the stable server `reason`
 * string — not a thrown `Error.message`.
 */
export type CredentialVerifyReasonCode =
  | 'bad_signature'
  | 'issuer_key_not_current'
  | 'issuer_not_found'
  | 'record_missing'
  | 'revoked'
  | 'expired'
  | 'not_found'
  | 'generic';

/** Recognized rejection codes for a credential ISSUE submit. */
export type CredentialIssueErrorCode =
  | 'self_credential'
  | 'holder_not_found'
  | 'invalid_holder'
  | 'invalid_expiry'
  | 'invalid_claims'
  | 'conflict'
  | 'generic';

/** Recognized rejection codes for a credential REVOKE. */
export type CredentialRevokeErrorCode =
  | 'not_issuer'
  | 'already_revoked'
  | 'not_found'
  | 'generic';

const ATTEST_REASONS: readonly Exclude<AttestErrorCode, 'generic' | 'subject_not_found'>[] = [
  'expired',
  'nonce_used',
  'pair_cooldown',
  'excluded_graph_neighbor',
  'excluded_shared_device',
  'self_attestation',
  'bad_signature',
];

const VOTE_REASONS: readonly Exclude<VoteErrorCode, 'generic' | 'not_selected'>[] = [
  'request_closed',
  'already_voted',
];

const VOUCH_REASONS: readonly Exclude<VouchErrorCode, 'generic' | 'subject_not_found'>[] = [
  'self_vouch',
  'voucher_below_threshold',
  'already_vouched',
  'excluded_graph_neighbor',
  'excluded_shared_device',
];

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
}

/** Classify a real-life-attestation submit error. */
export function attestErrorCode(error: unknown): AttestErrorCode {
  const msg = messageOf(error);
  const match = ATTEST_REASONS.find((reason) => msg.includes(reason));
  if (match) return match;
  // `subject_not_found` surfaces as the sentence "Attestation subject not found".
  if (msg.includes('subject not found')) {
    return 'subject_not_found';
  }
  return 'generic';
}

/** Classify a validation-vote error. */
export function voteErrorCode(error: unknown): VoteErrorCode {
  const msg = messageOf(error);
  const match = VOTE_REASONS.find((reason) => msg.includes(reason));
  if (match) return match;
  // `not_selected` surfaces as the sentence "You are not on this validation jury".
  if (msg.includes('not on this validation jury') || msg.includes('not_selected')) {
    return 'not_selected';
  }
  return 'generic';
}

/** Classify a personhood-vouch submit error. */
export function vouchErrorCode(error: unknown): VouchErrorCode {
  const msg = messageOf(error);
  const match = VOUCH_REASONS.find((reason) => msg.includes(reason));
  if (match) return match;
  // `subject_not_found` surfaces as the sentence "Vouch subject not found".
  if (msg.includes('subject not found') || msg.includes('subject_not_found')) {
    return 'subject_not_found';
  }
  return 'generic';
}

/** The credential-verify reasons we have localized copy for, longest-first so a
 *  more specific code is matched before a substring of it. */
const CREDENTIAL_VERIFY_REASONS: readonly Exclude<CredentialVerifyReasonCode, 'generic'>[] = [
  'issuer_key_not_current',
  'issuer_not_found',
  'record_missing',
  'bad_signature',
  'not_found',
  'revoked',
  'expired',
];

/**
 * Classify the stable `reason` from a `civic.credentials.verify` result
 * (`valid: false`). `civic.credentials.verify` never throws on an untrusted credential,
 * so this maps the machine-readable `reason` string directly. Anything
 * unmodelled (or a missing reason) collapses to `'generic'`, so a screen can
 * always do `t('civic.credentials.verify.reason.' + code)`.
 */
export function credentialVerifyReason(reason: string | undefined): CredentialVerifyReasonCode {
  if (!reason) return 'generic';
  const normalized = reason.toLowerCase();
  return CREDENTIAL_VERIFY_REASONS.find((code) => normalized === code || normalized.includes(code)) ?? 'generic';
}

/**
 * Classify a credential-issuance submit error. The API rejects with
 * `"Credential rejected: <reason>"` (or the sentences `"Credential holder not
 * found"`), and the SDK can throw a client-side `"Invalid expiresAt …"` before
 * the request. The modelled reasons collapse into the friendly codes above;
 * anything else is `'generic'`.
 */
export function credentialIssueErrorCode(error: unknown): CredentialIssueErrorCode {
  const msg = messageOf(error);
  if (msg.includes('self_credential')) return 'self_credential';
  if (msg.includes('holder not found') || msg.includes('holder_not_found')) return 'holder_not_found';
  if (msg.includes('invalid_holder')) return 'invalid_holder';
  if (msg.includes('invalid_expiry') || msg.includes('invalid expiresat')) return 'invalid_expiry';
  if (
    msg.includes('missing_base_type') ||
    msg.includes('invalid_type') ||
    msg.includes('invalid_record')
  ) {
    return 'invalid_claims';
  }
  if (
    msg.includes('chain_conflict') ||
    msg.includes('chain_fork') ||
    msg.includes('chain_gap') ||
    msg.includes('bad_seq') ||
    msg.includes('stale_issued_at')
  ) {
    return 'conflict';
  }
  return 'generic';
}

/** Classify a credential-revoke error. */
export function credentialRevokeErrorCode(error: unknown): CredentialRevokeErrorCode {
  const msg = messageOf(error);
  if (msg.includes('original issuer') || msg.includes('not_issuer')) return 'not_issuer';
  if (msg.includes('already_revoked')) return 'already_revoked';
  if (msg.includes('credential not found') || msg.includes('not_found')) return 'not_found';
  return 'generic';
}
