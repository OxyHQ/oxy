/**
 * Signed-record signing input — "what the signature covers".
 *
 * The single definition shared by every implementation (client signing and
 * server verification), so a record signed by one and verified by another
 * cannot drift.
 */

import type { SignedRecordEnvelope } from '@oxy.so/contracts';
import { canonicalize } from './canonicalJson';

/**
 * The signing-input portion of a {@link SignedRecordEnvelope}: every field
 * EXCEPT the `publicKey` and `signature`. Both the signer and the verifier
 * canonicalize exactly these fields, so they agree on the bytes that the
 * signature covers.
 *
 * The v2 chain fields (`seq`/`prev`/`collection`/`rkey`) are optional: a v1
 * envelope omits them and is signed over only the base fields; a v2 envelope
 * carries them and includes them in the signed bytes.
 */
export type SignedRecordSigningFields = Pick<
  SignedRecordEnvelope,
  'version' | 'type' | 'subject' | 'issuer' | 'record' | 'issuedAt'
> &
  Partial<Pick<SignedRecordEnvelope, 'seq' | 'prev' | 'collection' | 'rkey'>>;

/**
 * Compute the canonical signing input for a signed-record envelope.
 *
 * - **v1**: the canonical JSON of `{version, type, subject, issuer, record,
 *   issuedAt}` — BYTE-IDENTICAL to the original scheme, so every signature
 *   already in production keeps verifying.
 * - **v2**: the canonical JSON additionally includes the hash-chain fields
 *   `{seq, prev, collection, rkey}`. Because {@link canonicalize} sorts keys,
 *   the on-the-wire field order is irrelevant; the resulting canonical key
 *   order is `collection, issuedAt, issuer, prev, record, rkey, seq, subject,
 *   type, version`. `prev` is `null` at genesis (serialized as `null`, not
 *   omitted), so it is always part of the signed bytes.
 */
export function signedRecordSigningInput(fields: SignedRecordSigningFields): string {
  const { version, type, subject, issuer, record, issuedAt } = fields;
  if (version === 2) {
    const { seq, prev, collection, rkey } = fields;
    return canonicalize({ version, type, subject, issuer, record, issuedAt, seq, prev, collection, rkey });
  }
  return canonicalize({ version, type, subject, issuer, record, issuedAt });
}
