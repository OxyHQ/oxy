import {
  attestErrorCode,
  voteErrorCode,
  vouchErrorCode,
  credentialVerifyReason,
  credentialIssueErrorCode,
  credentialRevokeErrorCode,
} from '@/lib/civic/civic-errors';

describe('attestErrorCode', () => {
  it.each([
    ['Attestation rejected: nonce_used', 'nonce_used'],
    ['Attestation rejected: pair_cooldown', 'pair_cooldown'],
    ['Attestation rejected: excluded_graph_neighbor', 'excluded_graph_neighbor'],
    ['Attestation rejected: excluded_shared_device', 'excluded_shared_device'],
    ['Attestation rejected: self_attestation', 'self_attestation'],
    ['Attestation rejected: bad_signature', 'bad_signature'],
    ['Attestation subject not found', 'subject_not_found'],
    ['Attestation rejected: expired', 'expired'],
  ])('maps "%s" → %s', (message, code) => {
    expect(attestErrorCode(new Error(message))).toBe(code);
  });

  it('falls back to generic for an unmodelled reason or transport error', () => {
    expect(attestErrorCode(new Error('Network request failed'))).toBe('generic');
    expect(attestErrorCode(null)).toBe('generic');
  });
});

describe('voteErrorCode', () => {
  it.each([
    ['Vote rejected: request_closed', 'request_closed'],
    ['Vote rejected: already_voted', 'already_voted'],
  ])('maps "%s" → %s', (message, code) => {
    expect(voteErrorCode(new Error(message))).toBe(code);
  });

  it('maps the "not on this validation jury" sentence to not_selected', () => {
    expect(voteErrorCode(new Error('You are not on this validation jury'))).toBe('not_selected');
  });

  it('falls back to generic otherwise', () => {
    expect(voteErrorCode(new Error('boom'))).toBe('generic');
  });
});

describe('vouchErrorCode', () => {
  it.each([
    ['Vouch rejected: self_vouch', 'self_vouch'],
    ['Vouch rejected: already_vouched', 'already_vouched'],
    ['Vouch rejected: voucher_below_threshold', 'voucher_below_threshold'],
    ['Vouch rejected: excluded_graph_neighbor', 'excluded_graph_neighbor'],
    ['Vouch rejected: excluded_shared_device', 'excluded_shared_device'],
  ])('maps "%s" → %s', (message, code) => {
    expect(vouchErrorCode(new Error(message))).toBe(code);
  });

  it('maps the "Vouch subject not found" sentence to subject_not_found', () => {
    expect(vouchErrorCode(new Error('Vouch subject not found'))).toBe('subject_not_found');
  });

  it('falls back to generic for an unmodelled reason or transport error', () => {
    expect(vouchErrorCode(new Error('Network request failed'))).toBe('generic');
    expect(vouchErrorCode(null)).toBe('generic');
  });
});

describe('credentialVerifyReason', () => {
  it.each([
    ['bad_signature', 'bad_signature'],
    ['issuer_key_not_current', 'issuer_key_not_current'],
    ['issuer_not_found', 'issuer_not_found'],
    ['record_missing', 'record_missing'],
    ['revoked', 'revoked'],
    ['expired', 'expired'],
    ['not_found', 'not_found'],
  ])('maps the "%s" reason → %s', (reason, code) => {
    expect(credentialVerifyReason(reason)).toBe(code);
  });

  it('falls back to generic for a missing or unmodelled reason', () => {
    expect(credentialVerifyReason(undefined)).toBe('generic');
    expect(credentialVerifyReason('something_else')).toBe('generic');
  });

  it('does not confuse issuer_not_found with not_found (longest-match wins)', () => {
    expect(credentialVerifyReason('issuer_not_found')).toBe('issuer_not_found');
  });
});

describe('credentialIssueErrorCode', () => {
  it.each([
    ['Credential rejected: self_credential', 'self_credential'],
    ['Credential holder not found', 'holder_not_found'],
    ['Credential rejected: invalid_holder', 'invalid_holder'],
    ['Credential rejected: invalid_expiry', 'invalid_expiry'],
    ['Invalid expiresAt — must be an ISO 8601 date string.', 'invalid_expiry'],
    ['Credential rejected: missing_base_type', 'invalid_claims'],
    ['Credential rejected: invalid_type', 'invalid_claims'],
    ['Credential rejected: chain_conflict', 'conflict'],
    ['Credential rejected: stale_issued_at', 'conflict'],
  ])('maps "%s" → %s', (message, code) => {
    expect(credentialIssueErrorCode(new Error(message))).toBe(code);
  });

  it('falls back to generic for an unmodelled reason or transport error', () => {
    expect(credentialIssueErrorCode(new Error('Credential rejected: not_self_issued'))).toBe(
      'generic',
    );
    expect(credentialIssueErrorCode(new Error('Network request failed'))).toBe('generic');
    expect(credentialIssueErrorCode(null)).toBe('generic');
  });
});

describe('credentialRevokeErrorCode', () => {
  it.each([
    ['Only the original issuer may revoke this credential', 'not_issuer'],
    ['Revoke rejected: already_revoked', 'already_revoked'],
    ['Credential not found', 'not_found'],
  ])('maps "%s" → %s', (message, code) => {
    expect(credentialRevokeErrorCode(new Error(message))).toBe(code);
  });

  it('falls back to generic otherwise', () => {
    expect(credentialRevokeErrorCode(new Error('boom'))).toBe('generic');
    expect(credentialRevokeErrorCode(null)).toBe('generic');
  });
});
