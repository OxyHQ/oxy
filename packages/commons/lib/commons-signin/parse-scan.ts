/**
 * Single front door for the Commons QR scanner.
 *
 * A scanned string can be one of three unrelated Commons payloads:
 *
 *   - a "Sign in with Oxy" approval link    (`oxycommons://approve?code=…`)
 *   - a citizen Oxy ID card                  (`oxycommons://card?did=…`)
 *   - a real-life attestation request (F2)   (`oxycommons://attest?subject=…&nonce=…&exp=…`)
 *
 * `parseScan` branches a raw scanned string into a discriminated result so the
 * scanner can route once (`approval` → the sign-in approval flow; `id` → the
 * Oxy ID card view; `attest` → the real-life confirmation flow) without each call
 * site re-implementing the matching.
 *
 * It delegates to the pure, already-tested parsers — `parseApprovalLink` (here)
 * and `parseIdPayload` / `parseAttestPayload` (from `@oxy.so/core`) — and never
 * trusts the QR for anything beyond the opaque fields it carries: all are
 * re-resolved / re-verified server-side.
 */

import { parseIdPayload, parseAttestPayload } from '@oxy.so/core';
import { parseApprovalLink } from './parse-approval-link';

/** The branch a scanned string resolves to. */
export type ScanResult =
  /** A "Sign in with Oxy" approval link carrying a usable authorize code. */
  | { kind: 'approval'; code: string }
  /** A citizen Oxy ID card carrying the subject's DID. */
  | { kind: 'id'; did: string }
  /**
   * A real-life attestation request shown by the person being attested (A). The
   * scanner (B) confirms it after a biometric gate. Carries A's DID plus the
   * single-use nonce/exp the server re-validates.
   */
  | { kind: 'attest'; subjectDid: string; context: string; nonce: string; exp: number }
  /**
   * The string is not a recognized Commons payload, or is a recognized one that
   * can no longer be used. `reason: 'expired'` is reserved for an approval link
   * whose client-side expiry has already passed (better UX than a generic
   * "invalid"); everything else is `'invalid'`.
   */
  | { kind: 'invalid'; reason: 'invalid' | 'expired' };

/**
 * Branch a scanned QR string / deep link into its Commons payload kind.
 *
 * Approval links are matched first: an approve-scheme link that fails ONLY
 * because it is expired surfaces as `{ kind: 'invalid', reason: 'expired' }`
 * rather than falling through to the other matchers (the schemes never overlap,
 * so this only affects the error message shown). The two `oxycommons://` card /
 * attest payloads are disambiguated by their host (`card` vs `attest`).
 *
 * @param raw - The raw scanned string or deep-link URL.
 */
export function parseScan(raw: string): ScanResult {
  const approval = parseApprovalLink(raw);
  if (approval.ok) {
    return { kind: 'approval', code: approval.code };
  }
  // An approve-scheme link that matched but is stale: report it as expired so
  // the scanner can show the right message instead of "invalid".
  if (approval.reason === 'expired') {
    return { kind: 'invalid', reason: 'expired' };
  }

  const id = parseIdPayload(raw);
  if (id) {
    return { kind: 'id', did: id.did };
  }

  const attest = parseAttestPayload(raw);
  if (attest) {
    if (attest.exp < Date.now()) {
      return { kind: 'invalid', reason: 'expired' };
    }
    return {
      kind: 'attest',
      subjectDid: attest.subjectDid,
      context: attest.context,
      nonce: attest.nonce,
      exp: attest.exp,
    };
  }

  return { kind: 'invalid', reason: 'invalid' };
}
